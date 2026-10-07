import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import type { SfVoteSignal } from "@/lib/sf-events";

export const runtime = "nodejs";

interface FeedbackBody {
  eventId?: string;
  signal?: SfVoteSignal | null;
  tagsSnapshot?: string[];
  eventTitle?: string | null;
}

const VALID_SIGNALS = new Set<SfVoteSignal>(["up", "down", "busy"]);

/**
 * Records or clears a user vote signal (`up` | `busy` | `down` | `null`) for an SF event.
 * Persists to `sf_event_feedback` in Supabase when available, and returns 200 gracefully
 * if the table migration has not been applied yet so client-side state remains seamless.
 *
 * @param req - Incoming HTTP POST request with `{ eventId, signal, tagsSnapshot, eventTitle }`.
 * @returns JSON response confirming feedback state.
 */
export async function POST(req: Request) {
  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const eventId = body.eventId?.trim();
  if (!eventId || eventId.length > 200) {
    return NextResponse.json({ error: "Missing or invalid eventId." }, { status: 400 });
  }

  const signal = body.signal ?? null;
  if (signal !== null && !VALID_SIGNALS.has(signal)) {
    return NextResponse.json(
      { error: "signal must be 'up', 'down', 'busy', or null." },
      { status: 400 },
    );
  }

  const tagsSnapshot = Array.isArray(body.tagsSnapshot)
    ? body.tagsSnapshot.filter((t): t is string => typeof t === "string").slice(0, 25)
    : [];
  const eventTitle =
    typeof body.eventTitle === "string" ? body.eventTitle.slice(0, 300) : null;

  let persistedToDb = false;
  try {
    const db = getServiceClient();
    if (signal === null) {
      const { error } = await db.from("sf_event_feedback").delete().eq("event_id", eventId);
      if (!error) persistedToDb = true;
    } else {
      const { error } = await db.from("sf_event_feedback").upsert(
        {
          event_id: eventId,
          signal,
          tags_snapshot: tagsSnapshot,
          event_title: eventTitle,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "event_id" },
      );
      if (!error) persistedToDb = true;
    }
  } catch {
    // Gracefully allow client-side localStorage persistence if Supabase service key or table isn't ready
  }

  return NextResponse.json({
    ok: true,
    eventId,
    signal,
    persistedToDb,
  });
}
