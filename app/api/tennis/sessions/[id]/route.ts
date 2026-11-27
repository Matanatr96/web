import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  deleteModalSession,
  deleteTennisMatchRecord,
  getTennisMatch,
  isValidUuid,
  resolveClipUrl,
  verifyModalJobToken,
} from "@/lib/tennis";

export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Job-Token, X-Admin-Token",
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

/**
 * `DELETE /api/tennis/sessions/[id]`: permanently deletes a tennis session from Postgres
 * (cascading to `tennis_rallies`, `tennis_shots`, and `tennis_points`) and triggers best-effort
 * cleanup of its video clips on Modal.
 *
 * Accepts either admin authentication (`admin_session` cookie / `Authorization: Bearer` /
 * `X-Admin-Token`) or a valid, non-expired Modal `X-Job-Token` scoped to this session or `"any"`
 * (used by the iOS TennisVision app).
 */
export async function DELETE(req: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    if (!isValidUuid(id)) {
      return NextResponse.json({ error: "Invalid session id." }, { status: 400, headers: CORS_HEADERS });
    }
    const normalizedId = id.trim().toLowerCase();

    const adminOk = await isAdmin();
    const jobToken = req.headers.get("x-job-token");
    const jobTokenOk = !adminOk && jobToken ? await verifyModalJobToken(jobToken, normalizedId) : false;

    if (!adminOk && !jobTokenOk) {
      const hasAttemptedCreds = Boolean(
        jobToken || req.headers.get("authorization") || req.headers.get("x-admin-token"),
      );
      return NextResponse.json(
        { error: hasAttemptedCreds ? "Forbidden." : "Unauthorized." },
        { status: hasAttemptedCreds ? 403 : 401, headers: CORS_HEADERS },
      );
    }

    const { deleted } = await deleteTennisMatchRecord(normalizedId);
    if (!deleted) {
      return NextResponse.json({ error: "Session not found." }, { status: 404, headers: CORS_HEADERS });
    }

    await deleteModalSession(normalizedId);

    revalidatePath("/tennis");
    revalidatePath(`/tennis/${normalizedId}`);
    return NextResponse.json(
      { ok: true, deleted: true, matchId: normalizedId },
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (err) {
    console.error("[tennis/sessions/[id]] DELETE failed", err);
    return NextResponse.json(
      { error: "Failed to delete tennis session." },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
