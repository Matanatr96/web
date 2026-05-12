/**
 * One-off: parse a Signal-conversation text dump and insert offseason banter
 * into fantasy_banter tagged season=2026, week=0.
 *
 * Usage: SIGNAL_PASTE=/tmp/banter_paste.txt npm exec tsx scripts/import-signal-paste.ts
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { getServiceClient } from "../lib/supabase";

loadEnv({ path: resolve(process.cwd(), ".env.local") });

const SEASON = 2026;
const WEEK = 0;
const PASTE_PATH = process.env.SIGNAL_PASTE ?? "/tmp/banter_paste.txt";

// All messages in this paste fall in March–May 2026. Today's date for "Today" /
// "Yesterday" handling.
const TODAY = new Date("2026-05-12T12:00:00-07:00");

const SENDER_RE = /^⁨(.+?)⁩$/;
const TIME_RE = /^(?:Edited)?(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
const AVATAR_RE = /^(?:RB|SA|HL|JH)$/;
const DATE_HEADER_RE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/;
const REL_TIME_RE = /^(\d+)m$/;

// Senders we recognize. Everything else (orphan body lines, photo cards, etc.)
// gets attributed to "You" if no explicit sender precedes a timestamp.
const KNOWN_SENDERS = new Set([
  "Danid Digby",
  "Raghuram Bada",
  "Tejas Idate",
  "Komee",
  "Sai 💀 Nethi",
  "Suprith Aireddy",
  "Prerak Upadhyaya",
  "Huy Le",
  "John Hansen",
]);

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function isPureReaction(line: string): boolean {
  // emoji + optional digit count
  return /^[\p{Emoji}‍️]+\d*$/u.test(line);
}

function parseTimeOnDate(
  baseY: number, baseM: number, baseD: number,
  hour: number, minute: number, ampm: string,
): Date {
  let h = hour % 12;
  if (ampm.toUpperCase() === "PM") h += 12;
  // Pacific time (-07:00 during March–May DST).
  const iso = `${baseY}-${String(baseM + 1).padStart(2, "0")}-${String(baseD).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-07:00`;
  return new Date(iso);
}

type Row = { sender_name: string; message: string; sent_at: string };

function parse(text: string): Row[] {
  const lines = text.split(/\r?\n/);
  const rows: Row[] = [];

  // Initial date: messages before the first date header are Tue Jan 6 2026.
  let curY = 2026;
  let curM = MONTHS.Jan;
  let curD = 6;

  let pendingSender: string | null = null;
  let bodyLines: string[] = [];
  let lastWasBlank = false;
  // Track quote-block to strip: when a sender block begins, if the next non-blank
  // line is also a ⁨Sender⁩ marker, treat everything until the first blank line as
  // a quote that should be dropped.
  let inQuote = false;
  let sawBlankInBody = false;

  const flush = (timestamp: Date) => {
    if (!pendingSender || bodyLines.length === 0) {
      pendingSender = null;
      bodyLines = [];
      inQuote = false;
      sawBlankInBody = false;
      return;
    }
    const msg = bodyLines.join("\n").trim();
    if (msg) {
      rows.push({
        sender_name: pendingSender,
        message: msg,
        sent_at: timestamp.toISOString(),
      });
    }
    pendingSender = null;
    bodyLines = [];
    inQuote = false;
    sawBlankInBody = false;
  };

  // Synthetic timestamps for "Xm ago" entries on "Today".
  let nextTodaySeconds = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Skip Signal system / attachment-card noise that would otherwise pollute bodies.
    if (
      line.startsWith("Safety Number with") ||
      line === "View Safety Number" ||
      / deleted this message$/.test(line) ||
      /^\d+(?:\.\d+)?\s+(?:kB|MB)(?:\s*·\s*GIF)?$/.test(line) ||
      line === "GIF" ||
      line === "Photo"
    ) {
      lastWasBlank = false;
      continue;
    }

    if (line === "") {
      if (pendingSender) {
        if (inQuote) {
          // End of quote block.
          inQuote = false;
          sawBlankInBody = true;
        } else if (bodyLines.length > 0) {
          bodyLines.push("");
          sawBlankInBody = true;
        }
      }
      lastWasBlank = true;
      continue;
    }

    // Date header
    const dh = line.match(DATE_HEADER_RE);
    if (dh) {
      curM = MONTHS[dh[1]];
      curD = Number(dh[2]);
      lastWasBlank = false;
      continue;
    }
    if (line === "Yesterday") {
      curM = MONTHS.May; curD = 11;
      lastWasBlank = false;
      continue;
    }
    if (line === "Today") {
      curM = MONTHS.May; curD = 12;
      nextTodaySeconds = 0;
      lastWasBlank = false;
      continue;
    }

    // Avatar marker — ignore.
    if (AVATAR_RE.test(line)) {
      lastWasBlank = false;
      continue;
    }

    // Sender marker
    const sm = line.match(SENDER_RE);
    if (sm) {
      const name = sm[1];
      if (pendingSender == null) {
        // Start a new message block.
        pendingSender = name;
        bodyLines = [];
        inQuote = false;
        sawBlankInBody = false;
      } else {
        // Inside a pending block — this is a quote block reference. Mark and skip.
        if (bodyLines.length === 0) {
          inQuote = true;
        } else {
          // Sender line appeared mid-body without timestamp; treat as quote separator.
          inQuote = true;
        }
      }
      lastWasBlank = false;
      continue;
    }

    // "You" marker (the user's own messages quoting somebody)
    if (line === "You") {
      if (pendingSender == null) {
        pendingSender = "Anush Mattapalli";
        bodyLines = [];
        inQuote = false;
        sawBlankInBody = false;
      } else {
        inQuote = true;
      }
      lastWasBlank = false;
      continue;
    }

    // Timestamp closes a message
    const tm = line.match(TIME_RE);
    if (tm) {
      // Body without explicit sender → treat as "You" (Anush).
      if (!pendingSender && bodyLines.length > 0) {
        pendingSender = "Anush Mattapalli";
      }
      const ts = parseTimeOnDate(curY, curM, curD, Number(tm[1]), Number(tm[2]), tm[3]);
      flush(ts);
      lastWasBlank = false;
      continue;
    }

    // Relative "Xm" — synthesize on Today.
    const rm = line.match(REL_TIME_RE);
    if (rm) {
      if (!pendingSender && bodyLines.length > 0) {
        pendingSender = "Anush Mattapalli";
      }
      // Use today @ 12:00 PT with deterministic +1s per message in order.
      const ts = new Date(TODAY.getTime() + nextTodaySeconds * 1000);
      nextTodaySeconds += 60;
      flush(ts);
      lastWasBlank = false;
      continue;
    }

    // Reaction-only line (after a message has just been flushed)
    if (!pendingSender && isPureReaction(line)) {
      lastWasBlank = false;
      continue;
    }

    // Body content
    if (pendingSender) {
      if (inQuote) {
        // Drop quote text until blank line resets it (handled above).
        lastWasBlank = false;
        continue;
      }
      bodyLines.push(line);
    } else {
      // Orphan body line before any sender — start an implicit "You" block.
      pendingSender = "Anush Mattapalli";
      bodyLines = [line];
      inQuote = false;
      sawBlankInBody = false;
    }
    lastWasBlank = false;
  }

  return rows;
}

async function main() {
  const text = readFileSync(PASTE_PATH, "utf-8");
  const rows = parse(text);

  // Drop rows with empty messages or obviously-garbage senders.
  const cleaned = rows.filter((r) => {
    if (!r.message.trim()) return false;
    if (!KNOWN_SENDERS.has(r.sender_name) && r.sender_name !== "Anush Mattapalli") {
      console.warn("skipping unknown sender:", r.sender_name, "→", r.message.slice(0, 60));
      return false;
    }
    return true;
  });

  // Resolve (sender, minute) collisions by bumping sub-minute seconds so each
  // message gets a unique sent_at and survives the unique constraint.
  const minuteCount = new Map<string, number>();
  const uniq = cleaned.map((r) => {
    const k = `${r.sender_name}|${r.sent_at}`;
    const n = minuteCount.get(k) ?? 0;
    minuteCount.set(k, n + 1);
    if (n === 0) return r;
    const d = new Date(r.sent_at);
    d.setSeconds(d.getSeconds() + n);
    return { ...r, sent_at: d.toISOString() };
  });

  console.log(`Parsed ${rows.length} raw, ${cleaned.length} cleaned, ${uniq.length} unique`);

  const payload = uniq.map((r) => ({
    season: SEASON,
    week: WEEK,
    sender_name: r.sender_name,
    message: r.message,
    sent_at: r.sent_at,
  }));

  if (process.env.DRY_RUN) {
    console.log("DRY_RUN — first 10 rows:");
    console.log(payload.slice(0, 10));
    console.log("…last 5:");
    console.log(payload.slice(-5));
    return;
  }

  const db = getServiceClient();
  // Insert in chunks of 200.
  let inserted = 0;
  for (let i = 0; i < payload.length; i += 200) {
    const chunk = payload.slice(i, i + 200);
    const { error, count } = await db
      .from("fantasy_banter")
      .upsert(chunk, { onConflict: "sender_name,sent_at", ignoreDuplicates: true, count: "exact" });
    if (error) {
      console.error("insert error:", error);
      process.exit(1);
    }
    inserted += count ?? chunk.length;
  }
  console.log(`Inserted/upserted ${inserted} rows into fantasy_banter (season=${SEASON}, week=${WEEK})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
