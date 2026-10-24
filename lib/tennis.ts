import { getServiceClient, getSupabase } from "@/lib/supabase";

/** Session mode: `'rally'` (default cooperative hitting / practice) or `'match'` (formal scored match). */
export type TennisSessionType = "rally" | "match";

/** Processing lifecycle status for a tennis session. */
export type TennisMatchStatus = "uploading" | "processing" | "ready" | "failed";

/** Line-call verdict; `close` means the bounce lies inside the ±2σ uncertainty band. */
export type TennisCall = "in" | "out" | "close" | "unknown";

/** Shot lateral direction relative to the court centre line. */
export type TennisDirection = "cross" | "dtl" | "middle";

/** Which end of the court the hitter stands at (`near` = camera side, `Y < 0`). */
export type TennisHitter = "near" | "far";

/** Court depth zone of a bounce. `deep` = 6.40–11.885 m from the net (the target zone). */
export type DepthZone = "deep" | "short" | "out_long" | "out_wide" | "net" | "unknown";

/** 2D point tuple `[x, y]` (either pixel `[u, v]` or metric court `[x_m, y_m]`). */
export type Point2D = [number, number];

/** Four points, used for the tapped outer court corners. */
export type Quad = [Point2D, Point2D, Point2D, Point2D];

/** Row-major 3x3 projective homography `[h11, h12, h13, h21, h22, h23, h31, h32, h33]`. */
export type HomographyMatrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** ITF half-court length: net (`Y = 0`) to baseline (`|Y| = 11.885 m`). */
export const ITF_HALF_LENGTH_M = 11.885;

/** ITF service line distance from the net (`|Y| = 6.40 m`). */
export const ITF_SERVICE_LINE_M = 6.4;

/** ITF singles half-width (`|X| = 4.115 m`). */
export const ITF_SINGLES_HALF_WIDTH_M = 4.115;

/** ITF doubles half-width (`|X| = 5.485 m`). */
export const ITF_DOUBLES_HALF_WIDTH_M = 5.485;

/** Net posts stand 0.914 m (3 ft) outside the doubles sideline (`|X| = 6.399 m`). */
export const ITF_NET_POST_OFFSET_M = 0.914;

/** Size of each resumable upload part accepted by the Modal `tennis-rally` API (32 MiB). */
export const MODAL_PART_SIZE_BYTES = 32 * 1024 * 1024;

/**
 * Frame-0 court calibration stored in `tennis_matches.court`.
 * `cornersPx` are the 4 outer (doubles) corners in tap order `[nearLeft, nearRight, farRight, farLeft]`;
 * `netPostsPx` are the tops of the `[left, right]` net posts.
 */
export interface CourtCalibrationV1 {
  version: 1;
  imageSize: [number, number];
  cornersPx: Quad;
  netPostsPx?: [Point2D, Point2D];
  doubles: boolean;
  /** Image pixels -> court metres on `Z = 0`. */
  homographyToCourt: HomographyMatrix;
  /** Court metres on `Z = 0` -> image pixels. */
  homographyToImage: HomographyMatrix;
}

/** The `court` object the Modal `POST /jobs` endpoint expects (corners in `COURT_M` order 0..3). */
export interface ModalCourtJson {
  size: [number, number];
  /** `[farLeft, farRight, nearLeft, nearRight]` outer doubles corners, as in `dsa.physics.homography.COURT_M`. */
  court_px: Quad;
  posts_px: [Point2D, Point2D] | null;
}

/** One shot (hit and its bounce) inside a rally. Positions are court metres on the `Z = 0.033 m` plane. */
export interface TennisShot {
  rallyIdx: number;
  shotIdx: number;
  hitter: TennisHitter | null;
  stroke: string | null;
  direction: TennisDirection | null;
  depthZone: DepthZone | null;
  tHitS: number | null;
  tBounceS: number | null;
  hitX: number | null;
  hitY: number | null;
  bounceX: number | null;
  bounceY: number | null;
  speedMph: number | null;
  netClearanceM: number | null;
  call: TennisCall;
  marginM: number | null;
  sigmaM: number | null;
  liveCall: TennisCall | null;
}

/** A continuous rally with its Modal clip URL and shots. */
export interface TennisRally {
  rallyIdx: number;
  startS: number;
  endS: number;
  shotCount: number;
  inStreak: number;
  bookmarked: boolean;
  /** Modal clip path, usually relative: `/clips/{match_id}/{rally_idx}.mp4`. */
  clipUrl: string | null;
  ballTrack: Array<[number, number, number]> | null;
  driftPx: number | null;
  shots: TennisShot[];
}

/** One scored point (Match Mode). */
export interface TennisPoint {
  pointIdx: number;
  winner: "me" | "opp";
  server: "me" | "opp" | null;
  source: "watch" | "auto" | "web";
  bookmarked: boolean;
  atS: number | null;
}

/** Match Mode scoreboard (subset of `scorekeeper.py` output used by the viewer). */
export interface TennisMatchScore {
  sets: Array<[number, number]>;
  games: [number, number];
  points: [string | number, string | number] | string;
  server?: "me" | "opp";
  side?: "deuce" | "ad";
  tiebreak?: boolean;
  display?: string;
  formatted?: string;
  winner?: "me" | "opp" | null;
}

/** One biomechanical trait compared against the ATP pro baseline (Phase 3). */
export interface BiomechTraitScore {
  trait: string;
  stroke: "fh" | "bh" | "serve";
  userValue: number;
  proMean: number;
  proStd: number;
  zScore: number;
  unit: string;
}

/** Session statistics for both Rally Mode and Match Mode dashboards. */
export interface TennisSessionSummary {
  sessionType: TennisSessionType;
  totalRallies: number;
  /** Rallies counted in `avgRallyLength` (1-shot feeds excluded when hidden). */
  qualifyingRallies: number;
  totalShots: number;
  longestRally: number;
  longestInStreak: number;
  avgRallyLength: number;
  rallies10Plus: number;
  deepZonePct: number;
  deepPct: number;
  shortZonePct: number;
  avgSpeedMph: number | null;
  maxSpeedMph: number | null;
  fhSpeedAvg: number | null;
  fhSpeedMax: number | null;
  bhSpeedAvg: number | null;
  bhSpeedMax: number | null;
  serveSpeedAvg: number | null;
  serveSpeedMax: number | null;
  netClearanceAvgM: number | null;
  inPct: number;
  outCount: number;
  closeCount: number;
  /** Rallies where play continued after an `out` bounce (Rally Mode). */
  playedOnAfterOutRallies: number;
  firstServeInPct: number | null;
  pointsWon: number;
  pointsLost: number;
  biomechTraits?: BiomechTraitScore[];
  coachNotes?: string | null;
  originSource?: string;
}

/** Top-level session row (`tennis_matches`). */
export interface TennisMatch {
  id: string;
  title: string | null;
  playedOn: string;
  sessionType: TennisSessionType;
  source: "web" | "ios";
  status: TennisMatchStatus;
  court: CourtCalibrationV1 | null;
  doubles: boolean;
  fps: number | null;
  ralliesExpected: number | null;
  ralliesDone: number;
  score: TennisMatchScore | null;
  stats: Partial<TennisSessionSummary>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Session detail with rallies, shots, points and the computed summary. */
export interface TennisMatchDetail extends TennisMatch {
  rallies: TennisRally[];
  points: TennisPoint[];
  summary: TennisSessionSummary;
}

/** Aggregate statistics across all sessions returned by `GET /api/tennis/sessions`. */
export interface TennisAllSessionsSummary {
  totalSessions: number;
  totalRallies: number;
  totalShots: number;
  longestRally: number;
  avgRallyLength: number;
  avgSpeedMph: number | null;
  maxSpeedMph: number | null;
  serveSpeedAvg: number | null;
  serveSpeedMax: number | null;
  fhSpeedAvg: number | null;
  fhSpeedMax: number | null;
  bhSpeedAvg: number | null;
  bhSpeedMax: number | null;
  netClearanceAvgM: number | null;
  deepPct: number;
  bestInStreak: number;
  inCallRate: number;
}

/** Enriched session item returned by `GET /api/tennis/sessions` for the iOS Home Screen and web tools. */
export interface TennisSessionListItem extends TennisMatch {
  matchId: string;
  totalRallies: number;
  totalShots: number;
  bestInStreak: number;
  longestRally: number;
  avgRallyLength: number;
  avgSpeedMph: number | null;
  maxSpeedMph: number | null;
  serveSpeedAvg: number | null;
  serveSpeedMax: number | null;
  fhSpeedAvg: number | null;
  fhSpeedMax: number | null;
  bhSpeedAvg: number | null;
  bhSpeedMax: number | null;
  netClearanceAvgM: number | null;
  deepPct: number;
  inPct: number;
  outCount: number;
  scoreFormatted: string | null;
}

/** Input parameters for building a Modal `POST /jobs` request payload. */
export interface ModalJobRequestInput {
  matchId: string;
  rallyIdx?: number | null;
  source?: "web" | "ios" | "ios_library";
  sessionType?: TennisSessionType;
  /** Optional court calibration; pass `null` or omit when skipping calibration for GPU auto-detect. */
  court?: ModalCourtJson | CourtCalibrationV1 | null;
  doubles?: boolean;
  sizeBytes: number;
  fileName?: string;
  mimeType?: string;
  title?: string | null;
  playedOn?: string | null;
  /** Whether to run 65-joint 3D pose biomechanics + ATP pro comparison (defaults to `true`). */
  biomech?: boolean;
}

/** JSON payload sent to Modal `POST /jobs`. */
export interface ModalJobRequestPayload {
  match_id: string;
  rally_idx: number | null;
  source: "web" | "ios" | "ios_library";
  session_type: TennisSessionType;
  court: ModalCourtJson | null;
  doubles: boolean;
  size_bytes: number;
  content_type: "video/quicktime" | "video/mp4";
  title: string | null;
  played_on: string | null;
  biomech: boolean;
}

/** Response payload of `GET /api/tennis/sessions`. */
export interface TennisSessionsResponse {
  summary: TennisAllSessionsSummary;
  sessions: TennisSessionListItem[];
}

/** `match.status` webhook: processing started (with `rallies_expected`) or failed. */
export interface MatchStatusEvent {
  type: "match.status";
  eventId: string | null;
  matchId: string;
  status: "processing" | "failed";
  error: string | null;
  ralliesExpected: number | null;
  sessionType: TennisSessionType | null;
  source: "web" | "ios" | null;
  originSource?: "ios_library";
  fps: number | null;
  doubles?: boolean | null;
  court?: CourtCalibrationV1 | Record<string, unknown> | null;
}

/** `rally.ready` webhook: one processed rally and its shots, plus optional session metadata (e.g. from iOS). */
export interface RallyReadyEvent {
  type: "rally.ready";
  eventId: string | null;
  matchId: string;
  rally: TennisRally;
  sessionType: TennisSessionType | null;
  source: "web" | "ios" | null;
  originSource?: "ios_library";
  doubles: boolean | null;
  court: CourtCalibrationV1 | Record<string, unknown> | null;
  score: TennisMatchScore | null;
  stats: Partial<TennisSessionSummary> | null;
  points: TennisPoint[];
}

/** `match.ready` webhook: all rallies processed. */
export interface MatchReadyEvent {
  type: "match.ready";
  eventId: string | null;
  matchId: string;
  ralliesDone: number | null;
  score: TennisMatchScore | null;
  sessionType: TennisSessionType | null;
  source: "web" | "ios" | null;
  originSource?: "ios_library";
  doubles: boolean | null;
  court: CourtCalibrationV1 | Record<string, unknown> | null;
  stats: Partial<TennisSessionSummary> | null;
  points: TennisPoint[];
}

/** Webhook event sent by the Modal `tennis-rally` app to `/api/tennis/webhook`. */
export type TennisWebhookEvent = MatchStatusEvent | RallyReadyEvent | MatchReadyEvent;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks whether a string is a canonical (8-4-4-4-12 hex) UUID, as accepted by the Modal API.
 *
 * @param value - Candidate UUID string.
 * @returns `true` if `value` is a canonical UUID.
 */
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

/**
 * Returns the 4 outer (doubles) court corners in metres, in tap order
 * `[nearLeft, nearRight, farRight, farLeft]`. The outer corners are tapped for both singles and
 * doubles sessions, matching `COURT_M[0..3]` on the backend.
 *
 * @returns The 4 `[x_m, y_m]` outer corners.
 */
export function getOuterCourtCornersM(): Quad {
  const w = ITF_DOUBLES_HALF_WIDTH_M;
  const l = ITF_HALF_LENGTH_M;
  return [
    [-w, -l],
    [w, -l],
    [w, l],
    [-w, l],
  ];
}

/** Solves the 8x8 system `A x = b` by Gaussian elimination with partial pivoting. */
function solveLinear8x8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(M[pivotRow][col]) < 1e-10) {
      throw new Error("Degenerate or collinear court corner configuration.");
    }
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    const pivot = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/**
 * Computes the planar homography mapping 4 source points onto 4 destination points with the
 * Direct Linear Transform, normalised so `h33 = 1`.
 *
 * @param src - 4 source points (e.g. tapped pixels).
 * @param dst - 4 destination points (e.g. court metres), in the same order as `src`.
 * @returns Row-major 3x3 homography.
 * @throws Error when 3 or more points are collinear.
 */
export function computeHomography4pt(src: Quad, dst: Quad): HomographyMatrix {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solveLinear8x8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Inverts a 3x3 homography (adjugate / determinant), normalised so the last element is 1.
 *
 * @param H - Row-major 3x3 homography.
 * @returns The inverse homography.
 * @throws Error when `H` is singular.
 */
export function invertHomography(H: HomographyMatrix): HomographyMatrix {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    throw new Error("Singular homography matrix cannot be inverted.");
  }
  const adj: HomographyMatrix = [
    A,
    -(b * i - c * h),
    b * f - c * e,
    B,
    a * i - c * g,
    -(a * f - c * d),
    C,
    -(a * h - b * g),
    a * e - b * d,
  ];
  const scale = Math.abs(adj[8]) > 1e-12 ? adj[8] : det;
  return adj.map((v) => v / scale) as HomographyMatrix;
}

/**
 * Applies a homography to a 2D point (with the projective divide).
 *
 * @param H - Row-major 3x3 homography.
 * @param pt - Source point `[u, v]`.
 * @returns The projected point `[x, y]`.
 * @throws Error when the point maps to infinity.
 */
export function applyHomography(H: HomographyMatrix, pt: Point2D): Point2D {
  const [u, v] = pt;
  const w = H[6] * u + H[7] * v + H[8];
  if (Math.abs(w) < 1e-12) {
    throw new Error("Point projects to infinity under homography.");
  }
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

/**
 * Converts 4 tapped court corners from the UI's `[Far-Left, Far-Right, Near-Left, Near-Right]`
 * tap order into the `[Near-Left, Near-Right, Far-Right, Far-Left]` counter-clockwise order
 * consumed by `validateCourtCalibration`. If the first pair of taps is already on the near
 * baseline (lower in the image frame, larger `v`), returns the points unchanged.
 *
 * @param cornersPx - Up to 4 tapped corner points `[u, v]` in image pixels.
 * @returns Corners ordered as `[Near-Left, Near-Right, Far-Right, Far-Left]` when 4 points are present.
 */
export function normalizeTappedCornersToQuad(cornersPx: Point2D[]): Point2D[] {
  if (cornersPx.length !== 4) return cornersPx;
  const [p0, p1, p2, p3] = cornersPx;
  const firstPairMidY = 0.5 * (p0[1] + p1[1]);
  const secondPairMidY = 0.5 * (p2[1] + p3[1]);
  const [nearA, nearB, farA, farB] =
    firstPairMidY < secondPairMidY ? [p2, p3, p0, p1] : [p0, p1, p2, p3];
  const [nearLeft, nearRight] = nearA[0] <= nearB[0] ? [nearA, nearB] : [nearB, nearA];
  const [farLeft, farRight] = farA[0] <= farB[0] ? [farA, farB] : [farB, farA];
  return [nearLeft, nearRight, farRight, farLeft];
}

/**
 * Formats a session's capture source into a human-friendly badge label
 * (`"📱 iPhone Live"`, `"🖼️ Camera Roll"`, or `"💻 Web Upload"`).
 *
 * @param source - Stored session `source` (`"ios"`, `"ios_library"`, or `"web"`).
 * @param stats - Optional session `stats` record that may carry `originSource` / `source`.
 * @returns Display badge string with icon.
 */
export function formatSessionSource(
  source: string | null | undefined,
  stats?: Record<string, unknown> | null,
): string {
  const raw =
    source === "ios_library" ||
    stats?.originSource === "ios_library" ||
    stats?.origin_source === "ios_library" ||
    stats?.source === "ios_library"
      ? "ios_library"
      : source;
  if (raw === "ios_library") return "🖼️ Camera Roll";
  if (raw === "ios") return "📱 iPhone Live";
  return "💻 Web Upload";
}

/**
 * Validates the Frame-0 taps (4 outer corners in `[nearLeft, nearRight, farRight, farLeft]` order,
 * plus optionally the `[left, right]` net-post tops) and computes both `Z = 0` homographies.
 *
 * @param input - Frame size, tapped corners, optional net posts, and the singles/doubles flag.
 * @returns `{ valid, errors, calibration }`; `calibration` is `null` when invalid.
 */
export function validateCourtCalibration(input: {
  imageSize: [number, number];
  cornersPx: Point2D[];
  netPostsPx?: Point2D[];
  doubles?: boolean;
}): { valid: boolean; errors: string[]; calibration: CourtCalibrationV1 | null } {
  const errors: string[] = [];
  const [width, height] = input.imageSize;
  const doubles = Boolean(input.doubles);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
    errors.push("Image dimensions must be at least 100x100 pixels.");
  }
  if (input.cornersPx.length !== 4) {
    errors.push("Exactly 4 outer court corners (Near-Left, Near-Right, Far-Right, Far-Left) are required.");
    return { valid: false, errors, calibration: null };
  }

  const corners = input.cornersPx as Quad;
  corners.forEach(([u, v], idx) => {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > width || v < 0 || v > height) {
      errors.push(`Corner ${idx + 1} lies outside the video frame bounds.`);
    }
  });

  const [nearLeft, nearRight, farRight, farLeft] = corners;
  if (nearLeft[0] >= nearRight[0]) errors.push("Near-Left corner must be to the left of Near-Right corner.");
  if (farLeft[0] >= farRight[0]) errors.push("Far-Left corner must be to the left of Far-Right corner.");
  const nearMidY = 0.5 * (nearLeft[1] + nearRight[1]);
  const farMidY = 0.5 * (farLeft[1] + farRight[1]);
  if (nearMidY <= farMidY + 20) {
    errors.push("Near baseline must be lower in the video frame than the far baseline.");
  }

  const crossSigns = corners.map((p0, i) => {
    const p1 = corners[(i + 1) % 4];
    const p2 = corners[(i + 2) % 4];
    return Math.sign((p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]));
  });
  if (!crossSigns.every((s) => s > 0) && !crossSigns.every((s) => s < 0)) {
    errors.push("Selected court corners do not form a valid convex quadrilateral.");
  }

  let netPosts: [Point2D, Point2D] | undefined;
  if (input.netPostsPx && input.netPostsPx.length > 0) {
    if (input.netPostsPx.length !== 2) {
      errors.push("Provide both Left and Right net-post tops (or omit both).");
    } else {
      const [leftPost, rightPost] = input.netPostsPx;
      [leftPost, rightPost].forEach(([u, v], idx) => {
        if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > width || v < 0 || v > height) {
          errors.push(`Net post ${idx + 1} lies outside the video frame bounds.`);
        }
      });
      if (leftPost[0] >= rightPost[0]) errors.push("Left net post must be to the left of Right net post.");
      // Post tops sit 1.07 m above the court, so they may project slightly above the far baseline.
      const postMidY = 0.5 * (leftPost[1] + rightPost[1]);
      if (postMidY >= nearMidY || postMidY <= farMidY - 0.5 * (nearMidY - farMidY)) {
        errors.push("Net posts must sit vertically between the near and far baselines.");
      }
      netPosts = [leftPost, rightPost];
    }
  }

  if (errors.length > 0) return { valid: false, errors, calibration: null };

  try {
    const homographyToCourt = computeHomography4pt(corners, getOuterCourtCornersM());
    return {
      valid: true,
      errors: [],
      calibration: {
        version: 1,
        imageSize: [width, height],
        cornersPx: corners,
        ...(netPosts ? { netPostsPx: netPosts } : {}),
        doubles,
        homographyToCourt,
        homographyToImage: invertHomography(homographyToCourt),
      },
    };
  } catch (err) {
    return {
      valid: false,
      errors: [err instanceof Error ? err.message : "Failed to compute court homography."],
      calibration: null,
    };
  }
}

/**
 * Scales tapped calibration points from a screenshot/preview resolution to the video's native frame
 * dimensions. Returns `points` unchanged when `fromSize` and `toSize` match.
 *
 * @param points - Tapped points `[u, v]` in `fromSize` pixel coordinates.
 * @param fromSize - Resolution `[width, height]` of the calibration image/canvas.
 * @param toSize - Native resolution `[width, height]` of the video.
 * @returns Scaled points in `toSize` pixel coordinates.
 */
export function scaleCalibrationPoints(
  points: Point2D[],
  fromSize: [number, number],
  toSize: [number, number],
): Point2D[] {
  const [fromW, fromH] = fromSize;
  const [toW, toH] = toSize;
  if (
    !Number.isFinite(fromW) ||
    !Number.isFinite(fromH) ||
    !Number.isFinite(toW) ||
    !Number.isFinite(toH) ||
    fromW <= 0 ||
    fromH <= 0 ||
    toW <= 0 ||
    toH <= 0 ||
    (fromW === toW && fromH === toH)
  ) {
    return points;
  }
  const scaleX = toW / fromW;
  const scaleY = toH / fromH;
  return points.map(([u, v]) => [Math.round(u * scaleX), Math.round(v * scaleY)]);
}

/**
 * Builds the `localStorage` key used to persist an in-progress resumable browser upload for a video file
 * so interrupted uploads resume from `received_parts` instead of minting a new match UUID.
 *
 * @param file - File metadata (`name`, `size`, `lastModified`).
 * @returns Deterministic storage key.
 */
export function getUploadResumeKey(file: { name: string; size: number; lastModified: number }): string {
  return `tennis_upload_v1:${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Converts a shot timestamp (`tBounceS` or `tHitS`) to clip-local seconds relative to `rallyStartS`
 * for seeking trimmed `/clips/{match_id}/{rally_idx}.mp4` segments.
 *
 * @param timestampS - Shot timestamp in seconds (session-global or clip-local), or `null`.
 * @param rallyStartS - Rally `start_s` in seconds.
 * @returns Non-negative clip-local timestamp in seconds, or `null`.
 */
export function toClipLocalTimeS(timestampS: number | null, rallyStartS: number): number | null {
  if (timestampS === null || !Number.isFinite(timestampS)) return null;
  const start = Number.isFinite(rallyStartS) && rallyStartS > 0 ? rallyStartS : 0;
  const local = timestampS >= start ? timestampS - start : timestampS;
  return Math.max(0, Number(local.toFixed(4)));
}

/**
 * Converts a calibration into the `court` object for the Modal `POST /jobs` request, reordering the
 * tapped corners into `COURT_M` order `[farLeft, farRight, nearLeft, nearRight]`.
 *
 * @param cal - Validated calibration.
 * @returns The Modal `court` JSON (`size`, `court_px`, `posts_px`).
 */
export function toModalCourtJson(cal: CourtCalibrationV1): ModalCourtJson {
  const [nearLeft, nearRight, farRight, farLeft] = cal.cornersPx;
  return {
    size: cal.imageSize,
    court_px: [farLeft, farRight, nearLeft, nearRight],
    posts_px: cal.netPostsPx ?? null,
  };
}

/**
 * Builds the JSON request body for Modal `POST /jobs`, defaulting `biomech: true` so every uploaded
 * video receives full offline SwingVision ball speed, shot classification, and 3D biomechanics analysis.
 * Supports optional court calibration (`court: null`) when the user skips manual corner tapping to use
 * GPU auto-detection.
 *
 * @param input - Match metadata, optional calibration (`ModalCourtJson` | `CourtCalibrationV1` | `null`), and file info.
 * @returns Normalized `ModalJobRequestPayload` for `POST /jobs`.
 */
export function buildJobRequest(input: ModalJobRequestInput): ModalJobRequestPayload {
  let modalCourt: ModalCourtJson | null = null;
  if (input.court) {
    if ("cornersPx" in input.court) {
      modalCourt = toModalCourtJson(input.court);
    } else if ("court_px" in input.court) {
      modalCourt = input.court;
    }
  }
  const isMov =
    input.mimeType === "video/quicktime" ||
    Boolean(input.fileName && /\.mov$/i.test(input.fileName));
  return {
    match_id: input.matchId,
    rally_idx: input.rallyIdx ?? null,
    source: input.source ?? "web",
    session_type: input.sessionType === "match" ? "match" : "rally",
    court: modalCourt,
    doubles: Boolean(input.doubles),
    size_bytes: input.sizeBytes,
    content_type: isMov ? "video/quicktime" : "video/mp4",
    title: input.title?.trim() ? input.title.trim() : null,
    played_on: input.playedOn?.trim() ? input.playedOn.trim() : null,
    biomech: input.biomech ?? true,
  };
}

/**
 * Converts court metres into SVG minimap coordinates. The near baseline (`Y = -11.885 m`) is drawn at
 * the bottom and the far baseline at the top; the view always spans the doubles court plus `padM`.
 *
 * @param xM - Lateral position in metres (`+X` = right, seen from the near baseline).
 * @param yM - Longitudinal position in metres (`+Y` = far side).
 * @param viewBox - Optional `width`, `height` (SVG units) and `padM` (metres of apron), default 280x520 / 2 m.
 * @returns `{ x, y }` in SVG units, rounded to 2 decimals.
 */
export function courtToSvg(
  xM: number,
  yM: number,
  viewBox: { width?: number; height?: number; padM?: number } = {},
): { x: number; y: number } {
  const width = viewBox.width ?? 280;
  const height = viewBox.height ?? 520;
  const padM = viewBox.padM ?? 2.0;
  const totalWidthM = 2 * (ITF_DOUBLES_HALF_WIDTH_M + padM);
  const totalLengthM = 2 * (ITF_HALF_LENGTH_M + padM);
  const normX = (xM + ITF_DOUBLES_HALF_WIDTH_M + padM) / totalWidthM;
  const normY = (ITF_HALF_LENGTH_M + padM - yM) / totalLengthM;
  return {
    x: Number((normX * width).toFixed(2)),
    y: Number((normY * height).toFixed(2)),
  };
}

/**
 * Classifies a shot's direction from its hit and bounce positions, matching Python `rally_api._direction`:
 * - `"middle"` when `|bounceX| < ITF_SINGLES_HALF_WIDTH_M / 3` (`1.372 m`) or the ball did not cross the net.
 * - `"cross"` when `hitX` and `bounceX` have opposite signs (`hitX * bounceX < 0`).
 * - `"dtl"` when `hitX` and `bounceX` are on the same wing.
 *
 * @param hitX - Hit X in metres.
 * @param hitY - Hit Y in metres.
 * @param bounceX - Bounce X in metres.
 * @param bounceY - Bounce Y in metres.
 * @returns `"middle"`, `"cross"`, or `"dtl"`.
 */
export function classifyDirection(
  hitX: number,
  hitY: number,
  bounceX: number,
  bounceY: number,
): TennisDirection {
  if (!Number.isFinite(bounceX) || Math.abs(bounceX) < ITF_SINGLES_HALF_WIDTH_M / 3) return "middle";
  if (Number.isFinite(hitY) && Number.isFinite(bounceY) && hitY * bounceY > 0) return "middle";
  return hitX * bounceX < 0 ? "cross" : "dtl";
}

/**
 * Classifies a bounce into a depth zone, using the same rules as the Python/Swift line caller:
 * - `"net"`: the hitter is known and the ball bounced on the hitter's own half (never crossed).
 * - `"out_long"`: `|Y| > 11.885` and the baseline excess is at least the sideline excess.
 * - `"out_wide"`: outside the sideline (4.115 m singles, 5.485 m doubles).
 * - `"short"`: `|Y| <= 6.40` (service boxes).
 * - `"deep"`: `6.40 < |Y| <= 11.885` (the deep target zone).
 * - `"unknown"`: non-finite coordinates.
 *
 * @param bounceX - Bounce X in metres.
 * @param bounceY - Bounce Y in metres.
 * @param doubles - Whether doubles sidelines apply (default `false`).
 * @param hitter - Optional hitter end, used to detect netted balls.
 * @returns The depth zone.
 */
export function classifyDepthZone(
  bounceX: number,
  bounceY: number,
  doubles = false,
  hitter: TennisHitter | null = null,
): DepthZone {
  if (!Number.isFinite(bounceX) || !Number.isFinite(bounceY)) return "unknown";
  if ((hitter === "near" && bounceY < 0) || (hitter === "far" && bounceY > 0)) return "net";
  const halfW = doubles ? ITF_DOUBLES_HALF_WIDTH_M : ITF_SINGLES_HALF_WIDTH_M;
  const overX = Math.abs(bounceX) - halfW;
  const overY = Math.abs(bounceY) - ITF_HALF_LENGTH_M;
  if (overY > 0 && overY >= overX) return "out_long";
  if (overX > 0) return "out_wide";
  if (overY > 0) return "out_long";
  return Math.abs(bounceY) <= ITF_SERVICE_LINE_M ? "short" : "deep";
}

/**
 * Counts consecutive shots before the first `out` call (`in`, `close`, and `unknown` count toward the
 * streak, matching Python `scorekeeper.in_streak` and Swift `RallyCounter.recordBounce`).
 *
 * @param shots - Shots of one rally, in order.
 * @returns The rally's in-streak.
 */
export function computeInStreak(shots: Pick<TennisShot, "call">[]): number {
  let streak = 0;
  for (const s of shots) {
    if (s.call === "out") break;
    if (s.call === "in" || s.call === "close" || s.call === "unknown") streak += 1;
  }
  return streak;
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function mean1(values: number[]): number | null {
  return values.length > 0 ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

function mean2(values: number[]): number | null {
  return values.length > 0 ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

function max1(values: number[]): number | null {
  return values.length > 0 ? round1(Math.max(...values)) : null;
}

/**
 * Summarises a session for the dashboards. Computes SwingVision offline speed & shot analytics
 * (`avgSpeedMph`, `maxSpeedMph`, `serveSpeedAvg`, `serveSpeedMax`, `fhSpeedAvg`, `fhSpeedMax`,
 * `bhSpeedAvg`, `bhSpeedMax`, `netClearanceAvgM`, `deepPct`, `longestRally`, `avgRallyLength`),
 * plus Match Mode serve % and points won/lost.
 *
 * @param params - Session type, rallies, optional points, doubles flag, whether to hide 1-shot feeds
 *   from the average (default: hidden in Rally Mode), and optional Phase-3 biomechanics / coach notes.
 * @returns The `TennisSessionSummary`.
 */
export function summarizeSession(params: {
  sessionType: TennisSessionType;
  rallies: TennisRally[];
  points?: TennisPoint[];
  doubles?: boolean;
  hideOneShotFeeds?: boolean;
  biomechTraits?: BiomechTraitScore[];
  coachNotes?: string | null;
}): TennisSessionSummary {
  const { sessionType, rallies, points = [], doubles = false, biomechTraits, coachNotes } = params;
  const hideOneShotFeeds = params.hideOneShotFeeds ?? sessionType === "rally";
  const lengthOf = (r: TennisRally): number => Math.max(r.shotCount, r.shots.length);
  const qualifying = hideOneShotFeeds ? rallies.filter((r) => lengthOf(r) >= 2) : rallies;

  let totalShots = 0;
  let longestRally = 0;
  let longestInStreak = 0;
  let rallies10Plus = 0;
  let playedOnAfterOutRallies = 0;
  let deepCount = 0;
  let shortCount = 0;
  let depthEligible = 0;
  let inOrClose = 0;
  let outCount = 0;
  let closeCount = 0;
  let firstServes = 0;
  let firstServesIn = 0;
  const allSpeeds: number[] = [];
  const fhSpeeds: number[] = [];
  const bhSpeeds: number[] = [];
  const serveSpeeds: number[] = [];
  const netClearances: number[] = [];

  for (const rally of rallies) {
    const len = lengthOf(rally);
    totalShots += len;
    longestRally = Math.max(longestRally, len);
    if (len >= 10) rallies10Plus += 1;
    longestInStreak = Math.max(longestInStreak, rally.inStreak, computeInStreak(rally.shots));

    const firstOut = rally.shots.findIndex((s) => s.call === "out");
    if (firstOut >= 0 && firstOut < rally.shots.length - 1) playedOnAfterOutRallies += 1;

    rally.shots.forEach((shot, i) => {
      const stroke = (shot.stroke ?? "").toLowerCase();
      if (shot.speedMph !== null && shot.speedMph > 0) {
        allSpeeds.push(shot.speedMph);
        if (stroke === "fh" || stroke === "forehand") fhSpeeds.push(shot.speedMph);
        else if (stroke === "bh" || stroke === "backhand") bhSpeeds.push(shot.speedMph);
        else if (stroke === "serve") serveSpeeds.push(shot.speedMph);
      }
      if (shot.netClearanceM !== null && Number.isFinite(shot.netClearanceM)) {
        netClearances.push(shot.netClearanceM);
      }
      if (stroke === "serve" && i === 0) {
        firstServes += 1;
        if (shot.call === "in" || shot.call === "close") firstServesIn += 1;
      }
      if (shot.call === "in" || shot.call === "close") {
        inOrClose += 1;
        if (shot.call === "close") closeCount += 1;
      } else if (shot.call === "out") {
        outCount += 1;
      }

      const zone: DepthZone =
        shot.depthZone && shot.depthZone !== "unknown"
          ? shot.depthZone
          : shot.bounceX !== null && shot.bounceY !== null
            ? classifyDepthZone(shot.bounceX, shot.bounceY, doubles, shot.hitter)
            : "unknown";
      if (stroke !== "serve" && (zone === "deep" || zone === "short" || zone === "out_long" || zone === "out_wide")) {
        depthEligible += 1;
        if (zone === "deep") deepCount += 1;
        if (zone === "short") shortCount += 1;
      }
    });
  }

  const called = inOrClose + outCount;
  const qualifyingShots = qualifying.reduce((acc, r) => acc + lengthOf(r), 0);
  const deepZonePct = depthEligible > 0 ? round1((deepCount / depthEligible) * 100) : 0;

  return {
    sessionType,
    totalRallies: rallies.length,
    qualifyingRallies: qualifying.length,
    totalShots,
    longestRally,
    longestInStreak,
    avgRallyLength: qualifying.length > 0 ? round1(qualifyingShots / qualifying.length) : 0,
    rallies10Plus,
    deepZonePct,
    deepPct: deepZonePct,
    shortZonePct: depthEligible > 0 ? round1((shortCount / depthEligible) * 100) : 0,
    avgSpeedMph: mean1(allSpeeds),
    maxSpeedMph: max1(allSpeeds),
    fhSpeedAvg: mean1(fhSpeeds),
    fhSpeedMax: max1(fhSpeeds),
    bhSpeedAvg: mean1(bhSpeeds),
    bhSpeedMax: max1(bhSpeeds),
    serveSpeedAvg: mean1(serveSpeeds),
    serveSpeedMax: max1(serveSpeeds),
    netClearanceAvgM: mean2(netClearances),
    inPct: called > 0 ? round1((inOrClose / called) * 100) : 0,
    outCount,
    closeCount,
    playedOnAfterOutRallies,
    firstServeInPct: firstServes > 0 ? round1((firstServesIn / firstServes) * 100) : null,
    pointsWon: points.filter((p) => p.winner === "me").length,
    pointsLost: points.filter((p) => p.winner === "opp").length,
    ...(biomechTraits ? { biomechTraits } : {}),
    ...(coachNotes !== undefined ? { coachNotes } : {}),
  };
}

/**
 * Aggregates session-level SwingVision speed & shot statistics across a list of `TennisMatch` rows
 * for the iOS Home Screen, web `/tennis` dashboard, and `GET /api/tennis/sessions`, returning both
 * the top-level summary (`totalSessions`, `totalRallies`, `totalShots`, `longestRally`,
 * `avgRallyLength`, `avgSpeedMph`, `maxSpeedMph`, `serveSpeedAvg`, `serveSpeedMax`, `fhSpeedAvg`,
 * `fhSpeedMax`, `bhSpeedAvg`, `bhSpeedMax`, `netClearanceAvgM`, `deepPct`, plus backward-compatible
 * `bestInStreak` and `inCallRate: 0`) and enriched session items.
 *
 * @param matches - Sessions ordered newest first (from `listTennisMatches` / `getTennisMatches`).
 * @returns `{ summary, sessions }`.
 */
export function summarizeAllSessions(matches: TennisMatch[]): TennisSessionsResponse {
  let totalRallies = 0;
  let totalShots = 0;
  let longestRallyMax = 0;
  let bestInStreak = 0;
  const avgRallyLengths: number[] = [];
  const avgSpeeds: number[] = [];
  const maxSpeeds: number[] = [];
  const serveAvgs: number[] = [];
  const serveMaxes: number[] = [];
  const fhAvgs: number[] = [];
  const fhMaxes: number[] = [];
  const bhAvgs: number[] = [];
  const bhMaxes: number[] = [];
  const netClearances: number[] = [];
  const deepPcts: number[] = [];

  const sessions: TennisSessionListItem[] = matches.map((m) => {
    const s = m.stats as Record<string, unknown>;
    const rallies = num(s.totalRallies ?? s.total_rallies ?? s.rallies) ?? m.ralliesDone ?? 0;
    const shots = num(s.totalShots ?? s.total_shots) ?? 0;
    const longestRally = num(s.longestRally ?? s.longest_rally) ?? 0;
    const streak = num(s.longestInStreak ?? s.longest_in_streak) ?? longestRally;
    const avgRallyLength =
      num(s.avgRallyLength ?? s.avg_rally_length) ??
      (rallies > 0 && shots > 0 ? round1(shots / rallies) : 0);

    const fhSpeedAvg = num(s.fhSpeedAvg ?? s.fh_speed_avg);
    const fhSpeedMax = num(s.fhSpeedMax ?? s.fh_speed_max) ?? fhSpeedAvg;
    const bhSpeedAvg = num(s.bhSpeedAvg ?? s.bh_speed_avg);
    const bhSpeedMax = num(s.bhSpeedMax ?? s.bh_speed_max) ?? bhSpeedAvg;
    const serveSpeedAvg = num(s.serveSpeedAvg ?? s.serve_speed_avg);
    const serveSpeedMax = num(s.serveSpeedMax ?? s.serve_speed_max) ?? serveSpeedAvg;

    const strokeAvgs = [fhSpeedAvg, bhSpeedAvg, serveSpeedAvg].filter(
      (v): v is number => v !== null && v > 0,
    );
    const strokeMaxes = [serveSpeedMax, fhSpeedMax, bhSpeedMax].filter(
      (v): v is number => v !== null && v > 0,
    );

    const avgSpeedMph = num(s.avgSpeedMph ?? s.avg_speed_mph) ?? mean1(strokeAvgs);
    const maxSpeedMph = num(s.maxSpeedMph ?? s.max_speed_mph) ?? max1(strokeMaxes);
    const netClearanceAvgM = num(s.netClearanceAvgM ?? s.net_clearance_avg_m);
    const deepPct = num(s.deepPct ?? s.deep_pct ?? s.deepZonePct ?? s.deep_zone_pct) ?? 0;
    const inPct = num(s.inPct ?? s.in_pct) ?? 0;
    const outCount = num(s.outCount ?? s.out_count) ?? 0;

    totalRallies += rallies;
    totalShots += shots;
    longestRallyMax = Math.max(longestRallyMax, longestRally);
    bestInStreak = Math.max(bestInStreak, streak);

    if (avgRallyLength > 0) avgRallyLengths.push(avgRallyLength);
    if (avgSpeedMph !== null && avgSpeedMph > 0) avgSpeeds.push(avgSpeedMph);
    if (maxSpeedMph !== null && maxSpeedMph > 0) maxSpeeds.push(maxSpeedMph);
    if (serveSpeedAvg !== null && serveSpeedAvg > 0) serveAvgs.push(serveSpeedAvg);
    if (serveSpeedMax !== null && serveSpeedMax > 0) serveMaxes.push(serveSpeedMax);
    if (fhSpeedAvg !== null && fhSpeedAvg > 0) fhAvgs.push(fhSpeedAvg);
    if (fhSpeedMax !== null && fhSpeedMax > 0) fhMaxes.push(fhSpeedMax);
    if (bhSpeedAvg !== null && bhSpeedAvg > 0) bhAvgs.push(bhSpeedAvg);
    if (bhSpeedMax !== null && bhSpeedMax > 0) bhMaxes.push(bhSpeedMax);
    if (netClearanceAvgM !== null && Number.isFinite(netClearanceAvgM)) {
      netClearances.push(netClearanceAvgM);
    }
    if (deepPct > 0 || shots > 0) {
      if (deepPct > 0) deepPcts.push(deepPct);
    }

    return {
      ...m,
      matchId: m.id,
      totalRallies: rallies,
      totalShots: shots,
      bestInStreak: streak,
      longestRally,
      avgRallyLength,
      avgSpeedMph,
      maxSpeedMph,
      serveSpeedAvg,
      serveSpeedMax,
      fhSpeedAvg,
      fhSpeedMax,
      bhSpeedAvg,
      bhSpeedMax,
      netClearanceAvgM,
      deepPct,
      inPct,
      outCount,
      scoreFormatted: m.score ? formatScore(m.score) : null,
    };
  });

  return {
    summary: {
      totalSessions: matches.length,
      totalRallies,
      totalShots,
      longestRally: longestRallyMax,
      avgRallyLength:
        avgRallyLengths.length > 0
          ? (mean1(avgRallyLengths) ?? 0)
          : totalRallies > 0 && totalShots > 0
            ? round1(totalShots / totalRallies)
            : 0,
      avgSpeedMph: mean1(avgSpeeds),
      maxSpeedMph: max1(maxSpeeds),
      serveSpeedAvg: mean1(serveAvgs),
      serveSpeedMax: max1(serveMaxes),
      fhSpeedAvg: mean1(fhAvgs),
      fhSpeedMax: max1(fhMaxes),
      bhSpeedAvg: mean1(bhAvgs),
      bhSpeedMax: max1(bhMaxes),
      netClearanceAvgM: mean2(netClearances),
      deepPct: mean1(deepPcts) ?? 0,
      bestInStreak,
      inCallRate: 0,
    },
    sessions,
  };
}

const POINT_LABELS = ["0", "15", "30", "40"] as const;

function formatPointPair(
  rawMe: string | number | undefined,
  rawOpp: string | number | undefined,
  tiebreak = false,
): [string, string] {
  if (typeof rawMe === "number" && typeof rawOpp === "number" && Number.isFinite(rawMe) && Number.isFinite(rawOpp)) {
    const a = Math.max(0, Math.trunc(rawMe));
    const b = Math.max(0, Math.trunc(rawOpp));
    if (tiebreak) return [String(a), String(b)];
    if (a >= 3 && b >= 3) {
      if (a === b) return ["40", "40"];
      return a > b ? ["Ad", "40"] : ["40", "Ad"];
    }
    return [POINT_LABELS[a] ?? String(a), POINT_LABELS[b] ?? String(b)];
  }
  return [String(rawMe ?? "0"), String(rawOpp ?? "0")];
}

/**
 * Formats a Match Mode scoreboard. Uses the backend's `display` or `formatted` string when present.
 *
 * @param score - Scoreboard or `null`.
 * @returns e.g. `"6-4, 3-2 (40-15)"`, `"6-3, 6-4"`, or `"No score recorded"`.
 */
export function formatScore(score: TennisMatchScore | null | undefined): string {
  if (!score) return "No score recorded";
  if (score.display) return score.display;
  if (score.formatted) return score.formatted;
  const parts = (score.sets ?? []).map(([me, opp]) => `${me}-${opp}`);
  const [gMe, gOpp] = score.games ?? [0, 0];
  const rawPts = typeof score.points === "string" ? score.points.split("-") : (score.points ?? ["0", "0"]);
  const [pMe, pOpp] = formatPointPair(rawPts[0], rawPts[1], Boolean(score.tiebreak));
  const pointsInPlay = pMe !== "0" || pOpp !== "0";
  if (gMe > 0 || gOpp > 0 || pointsInPlay) parts.push(`${gMe}-${gOpp}`);
  const base = parts.length > 0 ? parts.join(", ") : "0-0";
  return pointsInPlay ? `${base} (${pMe}-${pOpp})` : base;
}

/**
 * Resolves a rally's clip URL against the Modal app base URL. Clips are served by Modal
 * (`GET /clips/{match_id}/{rally_idx}.mp4`, HTTP Range) and never stored in Supabase.
 *
 * @param clipUrl - Stored `clip_url` (relative path or absolute URL), or `null`.
 * @param modalBase - Modal app base URL (`NEXT_PUBLIC_TENNIS_MODAL_URL`), or `undefined` if unset.
 * @returns An absolute URL, or `null` if the clip is relative and no base URL is configured.
 */
export function resolveClipUrl(clipUrl: string | null, modalBase: string | undefined): string | null {
  if (!clipUrl) return null;
  if (/^https?:\/\//.test(clipUrl)) return clipUrl;
  if (!modalBase) return null;
  return `${modalBase.replace(/\/$/, "")}/${clipUrl.replace(/^\//, "")}`;
}

/**
 * Determines the SVG bounce dot fill, stroke, and label from the shot's stroke type and depth zone:
 * - `serve`: amber
 * - `deep` (6.40m to 11.885m): emerald
 * - `short` (service boxes): cyan
 * - other: slate
 *
 * @param shot - Shot with `stroke` and `depthZone`.
 * @returns `{ fill, stroke, label }`.
 */
export function bounceStyle(shot: Pick<TennisShot, "stroke" | "depthZone">): {
  fill: string;
  stroke: string;
  label: string;
} {
  const stroke = (shot.stroke ?? "").toLowerCase();
  if (stroke === "serve") {
    return { fill: "#f59e0b", stroke: "#b45309", label: "Serve" };
  }
  if (shot.depthZone === "deep") {
    return { fill: "#10b981", stroke: "#047857", label: "Deep Zone" };
  }
  if (shot.depthZone === "short") {
    return { fill: "#06b6d4", stroke: "#0e7490", label: "Short" };
  }
  return { fill: "#94a3b8", stroke: "#475569", label: "Other" };
}

const utf8 = new TextEncoder();

/**
 * Constant-time string comparison (XOR-accumulate over the UTF-8 bytes; only the length can leak).
 * Uses no `node:` imports so this module stays importable from the client uploader.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Hex HMAC-SHA256 via Web Crypto (available in Node 18+, the Edge runtime and browsers). */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, utf8.encode(message));
  return Array.from(new Uint8Array(sig), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks the `Authorization: Bearer <secret>` header on `/api/tennis/webhook` in constant time.
 * Fails closed: `500` when the secret is not configured, `401` for a missing or wrong token.
 *
 * @param authHeader - Raw `Authorization` header.
 * @param secret - Expected secret (defaults to `process.env.TENNIS_WEBHOOK_SECRET`).
 * @returns `{ ok, status, error? }`.
 */
export function verifyWebhookAuth(
  authHeader: string | null | undefined,
  secret: string | undefined = process.env.TENNIS_WEBHOOK_SECRET,
): { ok: boolean; status: 200 | 401 | 500; error?: string } {
  if (!secret) {
    return { ok: false, status: 500, error: "TENNIS_WEBHOOK_SECRET is not configured." };
  }
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (!constantTimeEqual(authHeader.slice("Bearer ".length), secret)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true, status: 200 };
}

/**
 * Mints a Modal upload token `"{scope}.{exp}.{hex HMAC-SHA256(secret, "{scope}.{exp}")}"`, the format
 * `rally_api.verify_token` checks. `scope` is a match UUID (or `"any"` for a device token).
 *
 * @param scope - Match UUID or `"any"`.
 * @param expUnixS - Expiry in Unix seconds.
 * @param secret - Shared secret (defaults to `process.env.TENNIS_JOB_SECRET`).
 * @returns Promise of the `X-Job-Token` value.
 * @throws Error (rejected promise) when the secret is not configured.
 */
export async function signModalJobToken(
  scope: string,
  expUnixS: number,
  secret: string | undefined = process.env.TENNIS_JOB_SECRET,
): Promise<string> {
  if (!secret) throw new Error("TENNIS_JOB_SECRET is not configured.");
  const exp = Math.floor(expUnixS);
  return `${scope}.${exp}.${await hmacSha256Hex(secret, `${scope}.${exp}`)}`;
}

function num(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function str(val: unknown): string | null {
  return typeof val === "string" ? val : null;
}

function boolOrNull(val: unknown): boolean | null {
  return typeof val === "boolean" ? val : null;
}

function parseCall(val: unknown): TennisCall {
  return val === "in" || val === "out" || val === "close" ? val : "unknown";
}

function parseHitter(val: unknown): TennisHitter | null {
  return val === "near" || val === "far" ? val : null;
}

function parseDirection(val: unknown): TennisDirection | null {
  return val === "cross" || val === "dtl" || val === "middle" ? val : null;
}

function parseDepthZone(val: unknown): DepthZone | null {
  return val === "deep" || val === "short" || val === "out_long" || val === "out_wide" || val === "net" || val === "unknown"
    ? val
    : null;
}

function parseSessionType(val: unknown): TennisSessionType | null {
  return val === "rally" || val === "match" ? val : null;
}

function parseSource(val: unknown): "web" | "ios" | null {
  if (val === "ios_library") return "ios";
  return val === "web" || val === "ios" ? val : null;
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

function parsePlayerSide(val: unknown): "me" | "opp" | null {
  if (val === "me" || val === "near") return "me";
  if (val === "opp" || val === "far") return "opp";
  return null;
}

/** Normalises court calibration JSON from either Web (`CourtCalibrationV1`), Modal (`ModalCourtJson` / `cal.to_json()`), or iOS. */
function normalizeWebhookCourt(
  raw: unknown,
  doublesFallback = false,
): CourtCalibrationV1 | Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version === 1 && Array.isArray(obj.cornersPx)) {
    return obj as unknown as CourtCalibrationV1;
  }
  if (Array.isArray(obj.size) && obj.size.length === 2 && Array.isArray(obj.court_px) && obj.court_px.length === 4) {
    const [farLeft, farRight, nearLeft, nearRight] = obj.court_px as Quad;
    const cornersPx: Quad = [nearLeft, nearRight, farRight, farLeft];
    const postsPx =
      Array.isArray(obj.posts_px) && obj.posts_px.length === 2 ? (obj.posts_px as [Point2D, Point2D]) : undefined;
    const validated = validateCourtCalibration({
      imageSize: [Number(obj.size[0]), Number(obj.size[1])],
      cornersPx,
      netPostsPx: postsPx,
      doubles: typeof obj.doubles === "boolean" ? obj.doubles : doublesFallback,
    });
    if (validated.calibration) return validated.calibration;
  }
  if (
    Array.isArray(obj.size) &&
    obj.size.length === 2 &&
    Array.isArray(obj.H0) &&
    obj.H0.length === 3 &&
    obj.H0.every((row) => Array.isArray(row) && row.length === 3)
  ) {
    const flatH0 = (obj.H0 as number[][]).flat().map(Number);
    if (flatH0.length === 9 && flatH0.every(Number.isFinite)) {
      try {
        const scale = Math.abs(flatH0[8]) > 1e-12 ? flatH0[8] : 1;
        const homographyToCourt = flatH0.map((v) => v / scale) as HomographyMatrix;
        const homographyToImage = invertHomography(homographyToCourt);
        const cornersPx = getOuterCourtCornersM().map((pt) => {
          const [u, v] = applyHomography(homographyToImage, pt);
          return [Number(u.toFixed(2)), Number(v.toFixed(2))] as Point2D;
        }) as Quad;
        return {
          ...obj,
          version: 1,
          imageSize: [Number(obj.size[0]), Number(obj.size[1])],
          cornersPx,
          doubles: typeof obj.doubles === "boolean" ? obj.doubles : doublesFallback,
          homographyToCourt,
          homographyToImage,
        } as CourtCalibrationV1;
      } catch {
        // Fall through if H0 is singular.
      }
    }
  }
  return obj;
}

/** Normalises `points` array from webhook payloads or `tennis_points` rows. */
function parseWebhookPoints(raw: unknown): TennisPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, idx) => {
    const p = asRecord(item);
    const winner = parsePlayerSide(p.winner) ?? "me";
    const server = parsePlayerSide(p.server);
    const src = p.source === "watch" || p.source === "web" || p.source === "auto" ? p.source : "auto";
    return {
      pointIdx: num(p.point_idx ?? p.pointIdx) ?? idx,
      winner,
      server,
      source: src,
      bookmarked: Boolean(p.bookmarked),
      atS: num(p.at_s ?? p.atS ?? p.timestamp_s ?? p.timestampS ?? p.t_s ?? p.end_s),
    };
  });
}

/** Normalises a single biomechanics trait row from either camelCase or snake_case payloads. */
function normalizeBiomechTrait(raw: unknown): BiomechTraitScore | null {
  const t = asRecord(raw);
  const trait = str(t.trait ?? t.name);
  const strokeRaw = (str(t.stroke) ?? "fh").toLowerCase();
  const stroke: "fh" | "bh" | "serve" =
    strokeRaw === "bh" || strokeRaw === "backhand"
      ? "bh"
      : strokeRaw === "serve"
        ? "serve"
        : "fh";
  const userValue = num(t.userValue ?? t.user_value ?? t.mean ?? t.value);
  const proMean = num(t.proMean ?? t.pro_mean) ?? 0;
  const proStd = num(t.proStd ?? t.pro_std) ?? 1;
  const zScore = num(t.zScore ?? t.z_score) ?? (userValue !== null && proStd > 0 ? (userValue - proMean) / proStd : 0);
  if (!trait || userValue === null) return null;
  return {
    trait,
    stroke,
    userValue: round1(userValue),
    proMean: round1(proMean),
    proStd: round1(proStd),
    zScore: Number(zScore.toFixed(2)),
    unit: str(t.unit) ?? "deg",
  };
}

/** Normalises `stats` from webhook payloads or `tennis_matches.stats` (handling both camelCase & snake_case + Phase 3 `biomechanics`). */
function normalizeStatsRecord(raw: unknown): Partial<TennisSessionSummary> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const s = raw as Record<string, unknown>;
  const out: Partial<TennisSessionSummary> & Record<string, unknown> = { ...s };

  const biomechObj = asRecord(s.biomechanics);
  const rawTraits = Array.isArray(s.biomechTraits)
    ? s.biomechTraits
    : Array.isArray(s.biomech_traits)
      ? s.biomech_traits
      : Array.isArray(s.biomechanics)
        ? s.biomechanics
        : Array.isArray(biomechObj.traits)
          ? biomechObj.traits
          : Array.isArray(biomechObj.biomech_traits)
            ? biomechObj.biomech_traits
            : Array.isArray(biomechObj.biomechTraits)
              ? biomechObj.biomechTraits
              : null;
  if (rawTraits) {
    const traits = rawTraits.map(normalizeBiomechTrait).filter((t): t is BiomechTraitScore => t !== null);
    out.biomechTraits = traits;
  }

  const coachNotes =
    str(s.coachNotes) ?? str(s.coach_notes) ?? str(biomechObj.coachNotes) ?? str(biomechObj.coach_notes);
  if (coachNotes !== null) {
    out.coachNotes = coachNotes;
  }
  const originSource = str(s.originSource) ?? str(s.origin_source);
  if (originSource !== null) {
    out.originSource = originSource;
  }
  return out;
}

/** Maps a snake_case shot (webhook payload or `tennis_shots` row) to a `TennisShot`. */
function mapShot(raw: unknown, rallyIdx: number, fallbackIdx: number): TennisShot {
  const s = asRecord(raw);
  const hitX = num(s.hit_x ?? s.hitX);
  const hitY = num(s.hit_y ?? s.hitY);
  const bounceX = num(s.bounce_x ?? s.bounceX);
  const bounceY = num(s.bounce_y ?? s.bounceY);
  const rawDir = parseDirection(s.direction);
  const direction =
    rawDir ??
    (hitX !== null && hitY !== null && bounceX !== null && bounceY !== null
      ? classifyDirection(hitX, hitY, bounceX, bounceY)
      : null);
  const rawLiveCall = s.live_call ?? s.liveCall;
  return {
    rallyIdx,
    shotIdx: num(s.shot_idx ?? s.shotIdx) ?? fallbackIdx,
    hitter: parseHitter(s.hitter),
    stroke: str(s.stroke),
    direction,
    depthZone: parseDepthZone(s.depth_zone ?? s.depthZone),
    tHitS: num(s.t_hit_s ?? s.tHitS),
    tBounceS: num(s.t_bounce_s ?? s.tBounceS),
    hitX,
    hitY,
    bounceX,
    bounceY,
    speedMph: num(s.speed_mph ?? s.speedMph),
    netClearanceM: num(s.net_clearance_m ?? s.netClearanceM),
    call: parseCall(s.call),
    marginM: num(s.margin_m ?? s.marginM),
    sigmaM: num(s.sigma_m ?? s.sigmaM),
    liveCall: rawLiveCall ? parseCall(rawLiveCall) : null,
  };
}

/** Maps a snake_case rally (webhook payload or `tennis_rallies` row) plus its shots to a `TennisRally`. */
function mapRally(raw: Record<string, unknown>, shots: TennisShot[]): TennisRally {
  return {
    rallyIdx: num(raw.rally_idx) ?? 0,
    startS: num(raw.start_s) ?? 0,
    endS: num(raw.end_s) ?? 0,
    shotCount: num(raw.shot_count) ?? shots.length,
    inStreak: num(raw.in_streak) ?? computeInStreak(shots),
    bookmarked: Boolean(raw.bookmarked),
    clipUrl: str(raw.clip_url),
    ballTrack: Array.isArray(raw.ball_track) ? (raw.ball_track as Array<[number, number, number]>) : null,
    driftPx: num(raw.drift_px),
    shots,
  };
}

const explicitPointsEvents = new WeakSet<TennisWebhookEvent>();

function parseOriginSource(raw: Record<string, unknown>, nested?: Record<string, unknown>): "ios_library" | undefined {
  const stats = asRecord(raw.stats);
  if (
    raw.source === "ios_library" ||
    nested?.source === "ios_library" ||
    raw.origin_source === "ios_library" ||
    raw.originSource === "ios_library" ||
    stats.origin_source === "ios_library" ||
    stats.originSource === "ios_library" ||
    stats.source === "ios_library"
  ) {
    return "ios_library";
  }
  return undefined;
}

/**
 * Validates and normalises a webhook body from the Modal `tennis-rally` app
 * (`match.status`, `rally.ready`, or `match.ready`; snake_case fields matching the SQL columns).
 *
 * @param raw - Parsed JSON body.
 * @returns The typed `TennisWebhookEvent`.
 * @throws Error prefixed `INVALID_ARGUMENT:` when the body is malformed.
 */
export function parseWebhookEvent(raw: unknown): TennisWebhookEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("INVALID_ARGUMENT: webhook body must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const matchId = str(obj.match_id)?.trim() ?? "";
  if (!isValidUuid(matchId)) {
    throw new Error("INVALID_ARGUMENT: match_id must be a valid UUID.");
  }
  const eventId = str(obj.event_id);

  switch (obj.type) {
    case "match.failed":
    case "match.status": {
      const status = obj.type === "match.failed" ? "failed" : obj.status;
      if (status !== "processing" && status !== "failed") {
        throw new Error("INVALID_ARGUMENT: match.status requires status processing|failed.");
      }
      const doubles = boolOrNull(obj.doubles);
      const court = normalizeWebhookCourt(obj.court, doubles ?? false);
      const originSource = parseOriginSource(obj);
      return {
        type: "match.status",
        eventId,
        matchId,
        status,
        error: str(obj.error),
        ralliesExpected: num(obj.rallies_expected),
        sessionType: parseSessionType(obj.session_type),
        source: parseSource(obj.source),
        ...(originSource ? { originSource } : {}),
        fps: num(obj.fps),
        ...(doubles !== null ? { doubles } : {}),
        ...(court !== null ? { court } : {}),
      };
    }
    case "rally.ready": {
      const r = asRecord(obj.rally);
      const rallyIdx = num(r.rally_idx);
      if (rallyIdx === null || rallyIdx < 0 || !Number.isInteger(rallyIdx) || num(r.start_s) === null || num(r.end_s) === null) {
        throw new Error("INVALID_ARGUMENT: rally.ready requires rally.rally_idx, start_s and end_s.");
      }
      const rawShots = Array.isArray(obj.shots) ? obj.shots : Array.isArray(r.shots) ? r.shots : [];
      const shots = rawShots.map((s, i) => mapShot(s, rallyIdx, i));
      // Propagate rally-level or event-level live_call (e.g. from iOS live calls) onto the decisive shot if not set per-shot.
      const fallbackLiveCall = r.live_call ?? obj.live_call;
      if (fallbackLiveCall && shots.length > 0 && shots.every((s) => s.liveCall === null)) {
        if (Array.isArray(fallbackLiveCall)) {
          shots.forEach((s, idx) => {
            if (idx < fallbackLiveCall.length && fallbackLiveCall[idx]) {
              s.liveCall = parseCall(fallbackLiveCall[idx]);
            }
          });
        } else {
          const parsedLive = parseCall(fallbackLiveCall);
          const targetShot = shots.find((s) => s.call === "out" || s.call === "close") ?? shots[shots.length - 1];
          targetShot.liveCall = parsedLive;
        }
      }
      const bookmarked = Boolean(r.bookmarked ?? obj.bookmarked);
      const doubles = boolOrNull(obj.doubles ?? r.doubles);
      const score =
        obj.score && typeof obj.score === "object"
          ? (obj.score as TennisMatchScore)
          : r.score && typeof r.score === "object"
            ? (r.score as TennisMatchScore)
            : null;
      const rawPoints = obj.points ?? r.points ?? (score ? asRecord(score).history ?? asRecord(score).points_log : undefined);
      const originSource = parseOriginSource(obj, r);
      const evt: RallyReadyEvent = {
        type: "rally.ready",
        eventId,
        matchId,
        rally: mapRally({ ...r, bookmarked }, shots),
        sessionType: parseSessionType(obj.session_type ?? r.session_type),
        source: parseSource(obj.source ?? r.source),
        ...(originSource ? { originSource } : {}),
        doubles,
        court: normalizeWebhookCourt(obj.court ?? r.court, doubles ?? false),
        score,
        stats: obj.stats && typeof obj.stats === "object" ? normalizeStatsRecord(obj.stats) : null,
        points: parseWebhookPoints(rawPoints),
      };
      if (Array.isArray(rawPoints)) explicitPointsEvents.add(evt);
      return evt;
    }
    case "session.finalize":
    case "match.ready": {
      const doubles = boolOrNull(obj.doubles);
      const score = obj.score && typeof obj.score === "object" ? (obj.score as TennisMatchScore) : null;
      const rawPoints = obj.points ?? (score ? asRecord(score).history ?? asRecord(score).points_log : undefined);
      const originSource = parseOriginSource(obj);
      const evt: MatchReadyEvent = {
        type: "match.ready",
        eventId,
        matchId,
        ralliesDone: num(obj.rallies_done),
        score,
        sessionType: parseSessionType(obj.session_type),
        source: parseSource(obj.source),
        ...(originSource ? { originSource } : {}),
        doubles,
        court: normalizeWebhookCourt(obj.court, doubles ?? false),
        stats: obj.stats && typeof obj.stats === "object" ? normalizeStatsRecord(obj.stats) : null,
        points: parseWebhookPoints(rawPoints),
      };
      if (Array.isArray(rawPoints)) explicitPointsEvents.add(evt);
      return evt;
    }
    default:
      throw new Error("INVALID_ARGUMENT: unsupported webhook event type.");
  }
}

/**
 * Applies a webhook event to Postgres with idempotent upserts (service-role client; no Storage).
 * Replays are no-ops, late `match.status` events never move a `ready` session backwards, and
 * `rally.ready` preserves `bookmarked`, `live_call`, `session_type`, `doubles`, `court`, `score`,
 * `stats`, and `points` while transitioning iOS sessions to `ready` once rallies are present.
 *
 * @param event - Parsed webhook event.
 * @param client - Optional Supabase client override for testing.
 * @returns `{ matchId }`.
 * @throws Error when a database write fails.
 */
export async function applyWebhookEvent(
  event: TennisWebhookEvent,
  client?: ReturnType<typeof getServiceClient>,
): Promise<{ matchId: string }> {
  const supabase = client ?? getServiceClient();
  const now = new Date().toISOString();

  let resolvedCourt = event.court ?? null;
  if (resolvedCourt && "H0" in resolvedCourt) {
    const { data: existingMatch } = await supabase
      .from("tennis_matches")
      .select("court")
      .eq("id", event.matchId)
      .maybeSingle();
    const existingCourt = asRecord(existingMatch?.court);
    if (Array.isArray(existingCourt.cornersPx)) {
      resolvedCourt = {
        ...resolvedCourt,
        cornersPx: existingCourt.cornersPx as Quad,
        ...(Array.isArray(existingCourt.netPostsPx)
          ? { netPostsPx: existingCourt.netPostsPx as [Point2D, Point2D] }
          : {}),
      } as CourtCalibrationV1;
    }
  }

  // Web sessions are created by createTennisMatch; iOS sessions first appear here.
  const seed: Record<string, unknown> = { id: event.matchId, source: "ios", status: "processing" };
  if (event.source) seed.source = event.source;
  if (event.sessionType) seed.session_type = event.sessionType;
  if (typeof event.doubles === "boolean") seed.doubles = event.doubles;
  if (resolvedCourt) seed.court = resolvedCourt;
  if (event.originSource) seed.stats = { originSource: event.originSource };

  const { error: seedErr } = await supabase
    .from("tennis_matches")
    .upsert(seed, { onConflict: "id", ignoreDuplicates: true });
  if (seedErr) throw new Error(`tennis_matches insert failed: ${seedErr.message}`);

  if (event.type === "match.status") {
    const metaUpdate: Record<string, unknown> = { updated_at: now };
    if (event.error !== null) metaUpdate.error = event.error;
    if (event.ralliesExpected !== null) metaUpdate.rallies_expected = event.ralliesExpected;
    if (event.sessionType !== null) metaUpdate.session_type = event.sessionType;
    if (event.source !== null) metaUpdate.source = event.source;
    if (event.fps !== null) metaUpdate.fps = event.fps;
    if (typeof event.doubles === "boolean") metaUpdate.doubles = event.doubles;
    if (resolvedCourt) metaUpdate.court = resolvedCourt;
    if (event.status === "failed") {
      metaUpdate.status = "failed";
    }
    const { error: metaErr } = await supabase
      .from("tennis_matches")
      .update(metaUpdate)
      .eq("id", event.matchId);
    if (metaErr) throw new Error(`tennis_matches update failed: ${metaErr.message}`);

    if (event.status === "processing") {
      const { error } = await supabase
        .from("tennis_matches")
        .update({ status: "processing", updated_at: now })
        .eq("id", event.matchId)
        .neq("status", "ready");
      if (error) throw new Error(`tennis_matches update failed: ${error.message}`);
    }
  }

  if (event.type === "rally.ready") {
    const r = event.rally;
    const rallyRow: Record<string, unknown> = {
      match_id: event.matchId,
      rally_idx: r.rallyIdx,
      start_s: r.startS,
      end_s: r.endS,
      shot_count: r.shotCount,
      in_streak: r.inStreak,
      clip_url: r.clipUrl,
      ball_track: r.ballTrack,
      drift_px: r.driftPx,
    };
    if (r.bookmarked) rallyRow.bookmarked = true;

    const { error: rallyErr } = await supabase
      .from("tennis_rallies")
      .upsert(rallyRow, { onConflict: "match_id,rally_idx" });
    if (rallyErr) throw new Error(`tennis_rallies upsert failed: ${rallyErr.message}`);

    if (r.shots.length > 0) {
      const { error: shotsErr } = await supabase.from("tennis_shots").upsert(
        r.shots.map((s) => ({
          match_id: event.matchId,
          rally_idx: r.rallyIdx,
          shot_idx: s.shotIdx,
          hitter: s.hitter,
          stroke: s.stroke,
          direction: s.direction,
          depth_zone: s.depthZone ?? "unknown",
          t_hit_s: s.tHitS,
          t_bounce_s: s.tBounceS,
          hit_x: s.hitX,
          hit_y: s.hitY,
          bounce_x: s.bounceX,
          bounce_y: s.bounceY,
          speed_mph: s.speedMph,
          net_clearance_m: s.netClearanceM,
          call: s.call,
          margin_m: s.marginM,
          sigma_m: s.sigmaM,
          live_call: s.liveCall,
        })),
        { onConflict: "match_id,rally_idx,shot_idx" },
      );
      if (shotsErr) throw new Error(`tennis_shots upsert failed: ${shotsErr.message}`);
    }
    const { error: delShotsErr } = await supabase
      .from("tennis_shots")
      .delete()
      .eq("match_id", event.matchId)
      .eq("rally_idx", r.rallyIdx)
      .gte("shot_idx", r.shots.length);
    if (delShotsErr) throw new Error(`tennis_shots delete failed: ${delShotsErr.message}`);

    const matchMetaUpdate: Record<string, unknown> = { updated_at: now };
    if (event.sessionType !== null) matchMetaUpdate.session_type = event.sessionType;
    if (event.source !== null) matchMetaUpdate.source = event.source;
    if (event.doubles !== null) matchMetaUpdate.doubles = event.doubles;
    if (resolvedCourt !== null) matchMetaUpdate.court = resolvedCourt;
    if (Object.keys(matchMetaUpdate).length > 1) {
      const { error: metaErr } = await supabase
        .from("tennis_matches")
        .update(matchMetaUpdate)
        .eq("id", event.matchId);
      if (metaErr) throw new Error(`tennis_matches update failed: ${metaErr.message}`);
    }
  }

  if (event.type === "rally.ready" || event.type === "match.ready") {
    if (event.points.length > 0) {
      const { error: pointsErr } = await supabase.from("tennis_points").upsert(
        event.points.map((p) => ({
          match_id: event.matchId,
          point_idx: p.pointIdx,
          winner: p.winner,
          server: p.server,
          source: p.source,
          bookmarked: p.bookmarked,
          at_s: p.atS,
        })),
        { onConflict: "match_id,point_idx" },
      );
      if (pointsErr) throw new Error(`tennis_points upsert failed: ${pointsErr.message}`);
    }
    if (event.type === "match.ready" && (event.points.length > 0 || explicitPointsEvents.has(event))) {
      const { error: delPointsErr } = await supabase
        .from("tennis_points")
        .delete()
        .eq("match_id", event.matchId)
        .gte("point_idx", event.points.length);
      if (delPointsErr) throw new Error(`tennis_points delete failed: ${delPointsErr.message}`);
    }
  }

  if (event.type === "match.ready") {
    const matchUpdate: Record<string, unknown> = { status: "ready", error: null, updated_at: now };
    if (event.score !== null) matchUpdate.score = event.score;
    if (event.sessionType !== null) matchUpdate.session_type = event.sessionType;
    if (event.source !== null) matchUpdate.source = event.source;
    if (event.doubles !== null) matchUpdate.doubles = event.doubles;
    if (resolvedCourt !== null) matchUpdate.court = resolvedCourt;
    const { error } = await supabase.from("tennis_matches").update(matchUpdate).eq("id", event.matchId);
    if (error) throw new Error(`tennis_matches update failed: ${error.message}`);
  }

  const detail = await getTennisMatch(event.matchId, true, supabase);
  if (detail) {
    const eventStats = event.type === "rally.ready" || event.type === "match.ready" ? event.stats : null;
    const mergedBiomechTraits = eventStats?.biomechTraits ?? detail.stats.biomechTraits;
    const mergedCoachNotes =
      eventStats?.coachNotes !== undefined ? eventStats.coachNotes : detail.stats.coachNotes;
    const rawBiomech =
      eventStats && "biomechanics" in eventStats
        ? (eventStats as Record<string, unknown>).biomechanics
        : detail.stats && "biomechanics" in detail.stats
          ? (detail.stats as Record<string, unknown>).biomechanics
          : undefined;
    const originSource =
      event.originSource ??
      (eventStats && "originSource" in eventStats ? str((eventStats as Record<string, unknown>).originSource) : null) ??
      (detail.stats && "originSource" in detail.stats ? str((detail.stats as Record<string, unknown>).originSource) : null);
    const mergedStats: TennisSessionSummary & Record<string, unknown> = {
      ...detail.summary,
      ...(mergedBiomechTraits ? { biomechTraits: mergedBiomechTraits } : {}),
      ...(mergedCoachNotes !== undefined ? { coachNotes: mergedCoachNotes } : {}),
      ...(rawBiomech !== undefined ? { biomechanics: rawBiomech } : {}),
      ...(originSource ? { originSource } : {}),
    };

    const statsUpdate: Record<string, unknown> = {
      rallies_done: detail.rallies.length,
      stats: mergedStats,
      updated_at: now,
    };
    if (
      event.type === "rally.ready" &&
      event.score !== null &&
      event.points.length >= detail.points.length
    ) {
      statsUpdate.score = event.score;
    }
    const isCameraRoll = originSource === "ios_library";
    const allExpectedRalliesPresent =
      detail.ralliesExpected !== null
        ? detail.rallies.length >= detail.ralliesExpected
        : detail.source === "ios" && !isCameraRoll;
    if (event.type === "rally.ready" && detail.rallies.length > 0 && allExpectedRalliesPresent) {
      statsUpdate.status = "ready";
      statsUpdate.error = null;
    } else if (
      event.type === "match.status" &&
      event.status === "processing" &&
      detail.status === "ready" &&
      detail.ralliesExpected !== null &&
      detail.rallies.length < detail.ralliesExpected
    ) {
      statsUpdate.status = "processing";
    }

    const { error } = await supabase
      .from("tennis_matches")
      .update(statsUpdate)
      .eq("id", event.matchId);
    if (error) throw new Error(`tennis_matches stats update failed: ${error.message}`);
  }
  return { matchId: event.matchId };
}

function mapMatchRow(row: Record<string, unknown>): TennisMatch {
  const status = row.status;
  const doubles = Boolean(row.doubles);
  const court = normalizeWebhookCourt(row.court, doubles) as CourtCalibrationV1 | null;
  return {
    id: String(row.id),
    title: str(row.title),
    playedOn: String(row.played_on ?? ""),
    sessionType: row.session_type === "match" ? "match" : "rally",
    source: row.source === "ios" || row.source === "ios_library" ? "ios" : "web",
    status: status === "processing" || status === "ready" || status === "failed" ? status : "uploading",
    court,
    doubles,
    fps: num(row.fps),
    ralliesExpected: num(row.rallies_expected),
    ralliesDone: num(row.rallies_done) ?? 0,
    score: row.score && typeof row.score === "object" ? (row.score as TennisMatchScore) : null,
    stats: normalizeStatsRecord(row.stats),
    error: str(row.error),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * Lists sessions, newest first, optionally filtered by session type. Uses the public (RLS) client.
 *
 * @param filter - `"all"` (default), `"rally"`, or `"match"`.
 * @param client - Optional Supabase client override for testing.
 * @returns Sessions; an empty array if the query fails (logged).
 */
export async function getTennisMatches(
  filter: TennisSessionType | "all" = "all",
  client?: ReturnType<typeof getServiceClient>,
): Promise<TennisMatch[]> {
  const supabase = client ?? getSupabase();
  let query = supabase
    .from("tennis_matches")
    .select("*")
    .order("played_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (filter !== "all") query = query.eq("session_type", filter);
  const { data, error } = await query;
  if (error) {
    console.error("[tennis] getTennisMatches failed", error);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapMatchRow);
}

/**
 * Alias for `getTennisMatches`: lists tennis sessions ordered newest first, optionally filtered by
 * session type (`"all"` | `"rally"` | `"match"`).
 *
 * @param filter - `"all"` (default), `"rally"`, or `"match"`.
 * @param client - Optional Supabase client override for testing.
 * @returns Sessions; an empty array if the query fails (logged).
 */
export const listTennisMatches = getTennisMatches;

/**
 * Loads one session with its rallies, shots and points, and computes its summary.
 *
 * @param id - Session UUID.
 * @param useServiceRole - Use the service-role client (webhook handler) instead of the public client.
 * @param client - Optional Supabase client override for testing.
 * @returns The session detail, or `null` for an invalid UUID or a missing session.
 * @throws Error when a child-table query fails.
 */
export async function getTennisMatch(
  id: string,
  useServiceRole = false,
  client?: ReturnType<typeof getServiceClient>,
): Promise<TennisMatchDetail | null> {
  if (!isValidUuid(id)) return null;
  const supabase = client ?? (useServiceRole ? getServiceClient() : getSupabase());
  const [matchRes, rallyRes, shotRes, pointRes] = await Promise.all([
    supabase.from("tennis_matches").select("*").eq("id", id).maybeSingle(),
    supabase.from("tennis_rallies").select("*").eq("match_id", id).order("rally_idx"),
    supabase.from("tennis_shots").select("*").eq("match_id", id).order("rally_idx").order("shot_idx"),
    supabase.from("tennis_points").select("*").eq("match_id", id).order("point_idx"),
  ]);
  if (matchRes.error) throw new Error(`tennis_matches query failed: ${matchRes.error.message}`);
  if (!matchRes.data) return null;
  for (const res of [rallyRes, shotRes, pointRes]) {
    if (res.error) throw new Error(`tennis child query failed: ${res.error.message}`);
  }

  const match = mapMatchRow(matchRes.data as Record<string, unknown>);
  const shotsByRally = new Map<number, TennisShot[]>();
  for (const row of (shotRes.data ?? []) as Array<Record<string, unknown>>) {
    const rallyIdx = num(row.rally_idx) ?? 0;
    const list = shotsByRally.get(rallyIdx) ?? [];
    list.push(mapShot(row, rallyIdx, list.length));
    shotsByRally.set(rallyIdx, list);
  }
  const rallies = ((rallyRes.data ?? []) as Array<Record<string, unknown>>).map((row) =>
    mapRally(row, shotsByRally.get(num(row.rally_idx) ?? 0) ?? []),
  );
  const dbPoints = parseWebhookPoints(pointRes.data ?? []);
  const fallbackScorePoints =
    dbPoints.length === 0 && match.score
      ? parseWebhookPoints(asRecord(match.score).history ?? asRecord(match.score).points_log)
      : [];
  const points = dbPoints.length > 0 ? dbPoints : fallbackScorePoints;

  const summary = summarizeSession({
    sessionType: match.sessionType,
    rallies,
    points,
    doubles: match.doubles,
    biomechTraits: match.stats.biomechTraits,
    coachNotes: match.stats.coachNotes,
  });
  return { ...match, rallies, points, summary };
}
