import { NextResponse } from "next/server";
import { getTennisMatch, isValidUuid, resolveClipUrl } from "@/lib/tennis";

export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * `OPTIONS /api/tennis/sessions/[id]`: CORS preflight handler for the iOS TennisVision app.
 */
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * `GET /api/tennis/sessions/[id]`: returns the full session detail (summary stats with per-stroke
 * average/max ball speeds, net clearance, deep-zone %, trimmed rally clips with resolved Modal
 * HTTPS URLs, shot-by-shot breakdown, and the dead-air-free `condensedClipUrl`).
 */
export async function GET(_req: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    if (!isValidUuid(id)) {
      return NextResponse.json({ error: "Invalid session id." }, { status: 400, headers: CORS_HEADERS });
    }
    const detail = await getTennisMatch(id);
    if (!detail) {
      return NextResponse.json({ error: "Session not found." }, { status: 404, headers: CORS_HEADERS });
    }

    const modalBase = process.env.NEXT_PUBLIC_TENNIS_MODAL_URL;
    const rawStats = detail.stats as Record<string, unknown>;
    const rawCondensed =
      typeof rawStats.condensed_clip_url === "string"
        ? rawStats.condensed_clip_url
        : typeof rawStats.condensedClipUrl === "string"
          ? rawStats.condensedClipUrl
          : detail.rallies.length > 0
            ? `/clips/${detail.id}/condensed.mp4`
            : null;
    const condensedClipUrl = resolveClipUrl(rawCondensed, modalBase);

    const rallies = detail.rallies.map((r) => ({
      ...r,
      clipUrl: resolveClipUrl(r.clipUrl, modalBase),
    }));

    return NextResponse.json(
      {
        ...detail,
        condensedClipUrl,
        rallies,
      },
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (err) {
    console.error("[tennis/sessions/[id]] GET failed", err);
    return NextResponse.json(
      { error: "Failed to load tennis session detail." },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
