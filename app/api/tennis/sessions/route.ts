import { NextResponse } from "next/server";
import { listTennisMatches, summarizeAllSessions, type TennisSessionType } from "@/lib/tennis";

export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * `OPTIONS /api/tennis/sessions`: CORS preflight handler for the iOS TennisVision app and web tools.
 *
 * @returns Empty `204` response with permissive CORS headers.
 */
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * `GET /api/tennis/sessions`: returns the aggregate session summary (`totalSessions`, `totalRallies`,
 * `totalShots`, `bestInStreak`, `inCallRate`) and recent sessions (`sessions`) for the iOS Home Screen
 * and web dashboard. Supports optional `?mode=all|rally|match` filtering.
 *
 * @param req - Incoming HTTP request.
 * @returns JSON `{ summary, sessions }` with `Access-Control-Allow-Origin: *`.
 */
export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const rawMode = url.searchParams.get("mode");
    const filter: TennisSessionType | "all" =
      rawMode === "rally" || rawMode === "match" ? rawMode : "all";
    const matches = await listTennisMatches(filter);
    const payload = summarizeAllSessions(matches);
    return NextResponse.json(payload, { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    console.error("[tennis/sessions] GET failed", err);
    return NextResponse.json(
      { error: "Failed to load tennis sessions." },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
