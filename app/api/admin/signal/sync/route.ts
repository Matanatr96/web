import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getServiceClient } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { timestampToNflWeek } from "@/lib/nfl-week";

const execFileAsync = promisify(execFile);

const cliPath = process.env.SIGNAL_CLI_PATH ?? "signal-cli";
const phone = process.env.SIGNAL_ACCOUNT_PHONE ?? "";
const groupId = process.env.SIGNAL_GROUP_ID ?? "";

type SignalEnvelope = {
  envelope: {
    source: string;
    sourceName?: string;
    dataMessage?: {
      timestamp: number;
      message?: string | null;
      groupInfo?: { groupId: string };
    };
  };
};

export async function POST() {
  try {
    const authed = await isAdmin();
    if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!phone || !groupId) {
      return NextResponse.json(
        { error: "SIGNAL_ACCOUNT_PHONE and SIGNAL_GROUP_ID must be set" },
        { status: 500 },
      );
    }

    const { stdout } = await execFileAsync(cliPath, [
      "--output", "json",
      "-a", phone,
      "receive",
      "--ignore-attachments",
    ]);

    const lines = stdout.trim().split("\n").filter(Boolean);
    const envelopes: SignalEnvelope[] = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as SignalEnvelope];
      } catch {
        return [];
      }
    });

    const rows: {
      season: number;
      week: number;
      sender_name: string;
      message: string;
      sent_at: string;
    }[] = [];

    for (const env of envelopes) {
      const dm = env.envelope.dataMessage;
      if (!dm?.message) continue;

      // Filter to target group only.
      const msgGroupId = dm.groupInfo?.groupId;
      if (!msgGroupId || msgGroupId !== groupId) continue;

      const nflWeek = timestampToNflWeek(dm.timestamp);
      if (!nflWeek) continue;

      rows.push({
        season: nflWeek.season,
        week: nflWeek.week,
        sender_name: env.envelope.sourceName ?? env.envelope.source,
        message: dm.message,
        sent_at: new Date(dm.timestamp).toISOString(),
      });
    }

    if (rows.length === 0) {
      return NextResponse.json({ imported: 0, message: "No new group messages found" });
    }

    const db = getServiceClient();
    const { error } = await db
      .from("fantasy_banter")
      .upsert(rows, { onConflict: "sender_name,sent_at", ignoreDuplicates: true });

    if (error) throw error;

    return NextResponse.json({ imported: rows.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("signal sync error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
