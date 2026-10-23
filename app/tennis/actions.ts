"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import {
  isValidUuid,
  type ModalCourtJson,
  type Point2D,
  signModalJobToken,
  type TennisSessionType,
  toModalCourtJson,
  validateCourtCalibration,
} from "@/lib/tennis";

/** Upload tokens are scoped to one match and expire after 12 hours (long enough for a slow LTE upload). */
const JOB_TOKEN_TTL_S = 12 * 60 * 60;

async function assertAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new Error("Not authorized.");
}

/**
 * Creates a `tennis_matches` row (status `uploading`) from validated Frame-0 calibration taps and
 * mints a match-scoped `X-Job-Token`, so the browser can upload the video straight to the Modal
 * `tennis-rally` API (`POST /jobs`, `PUT /jobs/{id}/parts/{n}`, `POST /jobs/{id}/commit`).
 * Admin only. Idempotent for a repeated client-supplied `id`.
 *
 * @param input - Optional client UUID, title, date, session type (default `rally`), doubles flag,
 *   frame size, the 4 tapped outer corners, and the optional 2 net-post tops.
 * @returns `matchId`, `jobToken`, the Modal base URL, and the `court` JSON for `POST /jobs`.
 * @throws Error when not admin, the calibration is invalid, or the Modal URL / job secret is unset.
 */
export async function createTennisMatch(input: {
  id?: string;
  title?: string;
  playedOn?: string;
  sessionType?: TennisSessionType;
  doubles?: boolean;
  imageSize: [number, number];
  cornersPx: Point2D[];
  netPostsPx?: Point2D[];
}): Promise<{ matchId: string; jobToken: string; modalEndpoint: string; court: ModalCourtJson }> {
  await assertAdmin();

  const modalEndpoint = process.env.NEXT_PUBLIC_TENNIS_MODAL_URL;
  if (!modalEndpoint) throw new Error("NEXT_PUBLIC_TENNIS_MODAL_URL is not configured.");

  const validation = validateCourtCalibration({
    imageSize: input.imageSize,
    cornersPx: input.cornersPx,
    netPostsPx: input.netPostsPx,
    doubles: input.doubles,
  });
  if (!validation.calibration) {
    throw new Error(`Invalid court calibration: ${validation.errors.join(" ")}`);
  }

  const matchId = input.id && isValidUuid(input.id) ? input.id.trim().toLowerCase() : crypto.randomUUID();
  const sessionType: TennisSessionType = input.sessionType === "match" ? "match" : "rally";
  const jobToken = await signModalJobToken(matchId, Date.now() / 1000 + JOB_TOKEN_TTL_S);

  const { error } = await getServiceClient()
    .from("tennis_matches")
    .upsert(
      {
        id: matchId,
        title: input.title?.trim() || null,
        played_on: input.playedOn?.trim() || new Date().toISOString().slice(0, 10),
        session_type: sessionType,
        source: "web",
        status: "uploading",
        court: validation.calibration,
        doubles: validation.calibration.doubles,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
  if (error) throw new Error(`Failed to create tennis session: ${error.message}`);

  revalidatePath("/tennis");
  return {
    matchId,
    jobToken,
    modalEndpoint: modalEndpoint.replace(/\/$/, ""),
    court: toModalCourtJson(validation.calibration),
  };
}

/**
 * Marks a session `processing` after the browser's Modal `POST /jobs/{id}/commit` returned 200.
 * Only moves `uploading` sessions forward, so it never overrides a status the webhook already set.
 * Admin only.
 *
 * @param matchId - Session UUID.
 * @returns `{ ok: true, matchId }`.
 * @throws Error when not admin, the UUID is invalid, or the update fails.
 */
export async function commitTennisMatch(matchId: string): Promise<{ ok: true; matchId: string }> {
  await assertAdmin();
  if (!isValidUuid(matchId)) throw new Error("Invalid matchId.");

  const { error } = await getServiceClient()
    .from("tennis_matches")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", matchId)
    .eq("status", "uploading");
  if (error) throw new Error(`Failed to mark session processing: ${error.message}`);

  revalidatePath("/tennis");
  revalidatePath(`/tennis/${matchId}`);
  return { ok: true, matchId };
}

/**
 * Sets the `bookmarked` flag on one rally (the ⭐ filter on `/tennis/[id]`). Admin only.
 *
 * @param matchId - Session UUID.
 * @param rallyIdx - 0-based rally index.
 * @param bookmarked - New flag value.
 * @throws Error when not admin, the arguments are invalid, or the update fails.
 */
export async function toggleRallyBookmark(matchId: string, rallyIdx: number, bookmarked: boolean): Promise<void> {
  await assertAdmin();
  if (!isValidUuid(matchId)) throw new Error("Invalid matchId.");
  if (!Number.isInteger(rallyIdx) || rallyIdx < 0) throw new Error("Invalid rallyIdx.");

  const { error } = await getServiceClient()
    .from("tennis_rallies")
    .update({ bookmarked })
    .eq("match_id", matchId)
    .eq("rally_idx", rallyIdx);
  if (error) throw new Error(`Bookmark update failed: ${error.message}`);

  revalidatePath(`/tennis/${matchId}`);
}
