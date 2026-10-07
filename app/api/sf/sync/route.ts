import { NextResponse } from "next/server";
import { syncSfEventsToDb } from "@/lib/sf-events";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Triggers a live San Francisco events sync via GET (used by scheduled cron workflows).
 *
 * @returns JSON summary of fetched, deduplicated, and persisted SF events.
 */
export async function GET() {
  try {
    const summary = await syncSfEventsToDb();
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Triggers a live San Francisco events sync via POST (used by UI Refresh button and cron workflows).
 *
 * @returns JSON summary of fetched, deduplicated, and persisted SF events.
 */
export async function POST() {
  return GET();
}
