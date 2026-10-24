import { describe, expect, it } from "vitest";
import {
  applyHomography,
  applyWebhookEvent,
  classifyDepthZone,
  classifyDirection,
  computeHomography4pt,
  computeInStreak,
  courtToSvg,
  formatScore,
  getOuterCourtCornersM,
  getTennisMatch,
  getUploadResumeKey,
  invertHomography,
  isValidUuid,
  listTennisMatches,
  parseWebhookEvent,
  type Point2D,
  type Quad,
  resolveClipUrl,
  scaleCalibrationPoints,
  signModalJobToken,
  summarizeAllSessions,
  summarizeSession,
  type TennisMatch,
  type TennisRally,
  type TennisShot,
  toClipLocalTimeS,
  toModalCourtJson,
  validateCourtCalibration,
  verifyWebhookAuth,
} from "../tennis";

const MATCH_ID = "123e4567-e89b-42d3-a456-426614174000";

/** Tapped outer corners `[nearLeft, nearRight, farRight, farLeft]` of a fence-mounted 1080p view. */
const CORNERS_PX: Quad = [
  [260, 960],
  [1660, 960],
  [1380, 280],
  [540, 280],
];
const POSTS_PX: [Point2D, Point2D] = [
  [200, 560],
  [1720, 560],
];

function shot(partial: Partial<TennisShot> & Pick<TennisShot, "rallyIdx" | "shotIdx">): TennisShot {
  return {
    hitter: null,
    stroke: null,
    direction: null,
    depthZone: null,
    tHitS: null,
    tBounceS: null,
    hitX: null,
    hitY: null,
    bounceX: null,
    bounceY: null,
    speedMph: null,
    netClearanceM: null,
    call: "unknown",
    marginM: null,
    sigmaM: null,
    liveCall: null,
    ...partial,
  };
}

function rally(partial: Partial<TennisRally> & Pick<TennisRally, "rallyIdx" | "shotCount">): TennisRally {
  return {
    startS: 0,
    endS: 1,
    inStreak: 0,
    bookmarked: false,
    clipUrl: null,
    ballTrack: null,
    driftPx: null,
    shots: [],
    ...partial,
  };
}

describe("isValidUuid", () => {
  it("accepts canonical UUIDs only", () => {
    expect({
      v4: isValidUuid(MATCH_ID),
      upper: isValidUuid(MATCH_ID.toUpperCase()),
      short: isValidUuid("not-a-uuid"),
      jobSuffix: isValidUuid(`${MATCH_ID}.r3`),
    }).toEqual({ v4: true, upper: true, short: false, jobSuffix: false });
  });
});

describe("court geometry", () => {
  it("returns the outer doubles corners in tap order", () => {
    expect(getOuterCourtCornersM()).toEqual([
      [-5.485, -11.885],
      [5.485, -11.885],
      [5.485, 11.885],
      [-5.485, 11.885],
    ]);
  });

  it("computes a 4-point DLT homography that round-trips through its inverse", () => {
    const H = computeHomography4pt(CORNERS_PX, getOuterCourtCornersM());
    const Hinv = invertHomography(H);
    const toCourt = CORNERS_PX.map((p) => applyHomography(H, p).map((v) => Number(v.toFixed(6))));
    const toImage = getOuterCourtCornersM().map((p) => applyHomography(Hinv, p).map((v) => Number(v.toFixed(6))));

    expect({ h33: H[8], hinv33: Hinv[8], toCourt, toImage }).toEqual({
      h33: 1,
      hinv33: 1,
      toCourt: getOuterCourtCornersM(),
      toImage: CORNERS_PX,
    });
  });

  it("maps the image centre-line midpoint of a symmetric view onto X = 0", () => {
    const H = computeHomography4pt(CORNERS_PX, getOuterCourtCornersM());
    const [x, y] = applyHomography(H, [960, 600]);
    expect({ onCentreLine: Math.abs(x) < 1e-9, insideCourt: Math.abs(y) < 11.885 }).toEqual({
      onCentreLine: true,
      insideCourt: true,
    });
  });

  it("rejects collinear corners and singular matrices", () => {
    const collinear: Quad = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    expect(() => computeHomography4pt(collinear, getOuterCourtCornersM())).toThrow(
      "Degenerate or collinear court corner configuration.",
    );
    expect(() => invertHomography([1, 2, 3, 2, 4, 6, 0, 0, 0])).toThrow(
      "Singular homography matrix cannot be inverted.",
    );
  });
});

describe("validateCourtCalibration", () => {
  it("accepts valid taps and returns both homographies", () => {
    const H = computeHomography4pt(CORNERS_PX, getOuterCourtCornersM());
    expect(
      validateCourtCalibration({ imageSize: [1920, 1080], cornersPx: CORNERS_PX, netPostsPx: POSTS_PX, doubles: true }),
    ).toEqual({
      valid: true,
      errors: [],
      calibration: {
        version: 1,
        imageSize: [1920, 1080],
        cornersPx: CORNERS_PX,
        netPostsPx: POSTS_PX,
        doubles: true,
        homographyToCourt: H,
        homographyToImage: invertHomography(H),
      },
    });
  });

  it("reports every ordering error for mirrored, upside-down taps", () => {
    expect(
      validateCourtCalibration({
        imageSize: [1920, 1080],
        cornersPx: [
          [1660, 280],
          [260, 280],
          [540, 960],
          [1380, 960],
        ],
      }),
    ).toEqual({
      valid: false,
      errors: [
        "Near-Left corner must be to the left of Near-Right corner.",
        "Far-Left corner must be to the left of Far-Right corner.",
        "Near baseline must be lower in the video frame than the far baseline.",
      ],
      calibration: null,
    });
  });

  it("rejects missing corners, out-of-frame taps, and bad net posts", () => {
    expect({
      threeCorners: validateCourtCalibration({ imageSize: [1920, 1080], cornersPx: CORNERS_PX.slice(0, 3) }),
      outOfFrame: validateCourtCalibration({
        imageSize: [1920, 1080],
        cornersPx: [[260, 1200], CORNERS_PX[1], CORNERS_PX[2], CORNERS_PX[3]],
      }),
      onePost: validateCourtCalibration({ imageSize: [1920, 1080], cornersPx: CORNERS_PX, netPostsPx: [POSTS_PX[0]] }),
      postsBelowNearBaseline: validateCourtCalibration({
        imageSize: [1920, 1080],
        cornersPx: CORNERS_PX,
        netPostsPx: [
          [200, 1000],
          [1720, 1000],
        ],
      }),
    }).toEqual({
      threeCorners: {
        valid: false,
        errors: ["Exactly 4 outer court corners (Near-Left, Near-Right, Far-Right, Far-Left) are required."],
        calibration: null,
      },
      outOfFrame: { valid: false, errors: ["Corner 1 lies outside the video frame bounds."], calibration: null },
      onePost: {
        valid: false,
        errors: ["Provide both Left and Right net-post tops (or omit both)."],
        calibration: null,
      },
      postsBelowNearBaseline: {
        valid: false,
        errors: ["Net posts must sit vertically between the near and far baselines."],
        calibration: null,
      },
    });
  });

  it("converts a calibration to the Modal court.json in COURT_M order", () => {
    const { calibration } = validateCourtCalibration({
      imageSize: [1920, 1080],
      cornersPx: CORNERS_PX,
      netPostsPx: POSTS_PX,
    });
    const withoutPosts = validateCourtCalibration({ imageSize: [1920, 1080], cornersPx: CORNERS_PX }).calibration;

    expect({ withPosts: toModalCourtJson(calibration!), withoutPosts: toModalCourtJson(withoutPosts!) }).toEqual({
      withPosts: {
        size: [1920, 1080],
        court_px: [
          [540, 280],
          [1380, 280],
          [260, 960],
          [1660, 960],
        ],
        posts_px: POSTS_PX,
      },
      withoutPosts: {
        size: [1920, 1080],
        court_px: [
          [540, 280],
          [1380, 280],
          [260, 960],
          [1660, 960],
        ],
        posts_px: null,
      },
    });
  });
});

describe("courtToSvg", () => {
  it("maps court metres into the minimap viewBox (near baseline at the bottom)", () => {
    expect({
      centre: courtToSvg(0, 0),
      nearLeftSingles: courtToSvg(-4.115, -11.885),
      farRightSingles: courtToSvg(4.115, 11.885),
      custom: courtToSvg(0, 0, { width: 100, height: 200, padM: 0 }),
    }).toEqual({
      centre: { x: 140, y: 260 },
      nearLeftSingles: { x: 63.03, y: 482.55 },
      farRightSingles: { x: 216.97, y: 37.45 },
      custom: { x: 50, y: 100 },
    });
  });
});

describe("classifyDirection", () => {
  it("labels cross-court, down-the-line, and middle shots (matching Python 4.115 / 3 threshold)", () => {
    expect({
      cross: classifyDirection(3.2, -11.5, -3.1, 9.8),
      dtl: classifyDirection(3.2, -11.5, 3.0, 10.2),
      middleBounce: classifyDirection(3.2, -11.5, 1.2, 8.5),
      outsideMiddleBounce: classifyDirection(0.2, -11.5, 2.8, 9.0),
      didNotCross: classifyDirection(3.2, -11.5, -3.0, -5.0),
    }).toEqual({
      cross: "cross",
      dtl: "dtl",
      middleBounce: "middle",
      outsideMiddleBounce: "dtl",
      didNotCross: "middle",
    });
  });
});

describe("classifyDepthZone", () => {
  it("matches the backend depth-zone rules", () => {
    expect({
      deep: classifyDepthZone(2.5, 9.4),
      short: classifyDepthZone(-1.8, 4.2),
      onServiceLine: classifyDepthZone(0, 6.4),
      onBaseline: classifyDepthZone(0, -11.885),
      outLong: classifyDepthZone(1.0, 12.15),
      outWideSingles: classifyDepthZone(4.4, 8.0),
      inDoubleAlley: classifyDepthZone(4.4, 8.0, true),
      cornerWiderThanLong: classifyDepthZone(4.4, 12.0),
      cornerLongerThanWide: classifyDepthZone(4.2, 12.5),
      nettedByNear: classifyDepthZone(0.5, -3.0, false, "near"),
      nettedByFar: classifyDepthZone(0.5, 3.0, false, "far"),
      crossedByNear: classifyDepthZone(0.5, 3.0, false, "near"),
      unknown: classifyDepthZone(Number.NaN, 1),
    }).toEqual({
      deep: "deep",
      short: "short",
      onServiceLine: "short",
      onBaseline: "deep",
      outLong: "out_long",
      outWideSingles: "out_wide",
      inDoubleAlley: "deep",
      cornerWiderThanLong: "out_wide",
      cornerLongerThanWide: "out_long",
      nettedByNear: "net",
      nettedByFar: "net",
      crossedByNear: "short",
      unknown: "unknown",
    });
  });
});

describe("computeInStreak", () => {
  it("counts in/close/unknown calls before the first out (matching Python/Swift)", () => {
    expect({
      mixed: computeInStreak([{ call: "in" }, { call: "unknown" }, { call: "close" }, { call: "out" }, { call: "in" }]),
      outFirst: computeInStreak([{ call: "out" }, { call: "in" }]),
      empty: computeInStreak([]),
    }).toEqual({ mixed: 3, outFirst: 0, empty: 0 });
  });
});

describe("calibration & clip-time helpers", () => {
  it("scales screenshot calibration points to native video resolution", () => {
    expect({
      scaled: scaleCalibrationPoints(
        [
          [520, 1920],
          [3320, 1920],
        ],
        [3840, 2160],
        [1920, 1080],
      ),
      sameSize: scaleCalibrationPoints([[260, 960]], [1920, 1080], [1920, 1080]),
    }).toEqual({
      scaled: [
        [260, 960],
        [1660, 960],
      ],
      sameSize: [[260, 960]],
    });
  });

  it("builds deterministic localStorage upload resume keys and converts timestamps to clip-local seconds", () => {
    expect({
      key: getUploadResumeKey({ name: "rally.mov", size: 1048576, lastModified: 1700000000000 }),
      sessionGlobal: toClipLocalTimeS(14.25, 12.5),
      alreadyLocal: toClipLocalTimeS(1.75, 12.5),
      zeroStart: toClipLocalTimeS(2.1, 0),
      missing: toClipLocalTimeS(null, 12.5),
    }).toEqual({
      key: "tennis_upload_v1:rally.mov:1048576:1700000000000",
      sessionGlobal: 1.75,
      alreadyLocal: 1.75,
      zeroStart: 2.1,
      missing: null,
    });
  });
});

describe("summarizeSession", () => {
  const rallyModeRallies: TennisRally[] = [
    // 1-shot aborted feed: hidden from the average in Rally Mode.
    rally({
      rallyIdx: 0,
      shotCount: 1,
      inStreak: 1,
      shots: [shot({ rallyIdx: 0, shotIdx: 0, stroke: "feed", depthZone: "short", speedMph: 48, call: "in" })],
    }),
    // 12-shot rally; shot 4 lands long but the players play on.
    rally({
      rallyIdx: 1,
      shotCount: 12,
      inStreak: 3,
      bookmarked: true,
      shots: [
        shot({ rallyIdx: 1, shotIdx: 0, stroke: "fh", depthZone: "deep", speedMph: 68, call: "in" }),
        shot({ rallyIdx: 1, shotIdx: 1, stroke: "bh", depthZone: "deep", speedMph: 62, call: "close" }),
        shot({ rallyIdx: 1, shotIdx: 2, stroke: "fh", depthZone: "deep", speedMph: 72, call: "in" }),
        shot({ rallyIdx: 1, shotIdx: 3, stroke: "fh", depthZone: "out_long", speedMph: 74, call: "out" }),
        shot({ rallyIdx: 1, shotIdx: 4, stroke: "bh", depthZone: "short", speedMph: 58, call: "in" }),
      ],
    }),
    // 4-shot rally with no per-shot rows yet.
    rally({ rallyIdx: 2, shotCount: 4, inStreak: 4 }),
  ];

  it("computes Rally Mode streaks, depth %, speeds and play-on-after-out", () => {
    expect(summarizeSession({ sessionType: "rally", rallies: rallyModeRallies })).toEqual({
      sessionType: "rally",
      totalRallies: 3,
      qualifyingRallies: 2,
      totalShots: 17,
      longestRally: 12,
      longestInStreak: 4,
      avgRallyLength: 8,
      rallies10Plus: 1,
      deepZonePct: 50,
      shortZonePct: 33.3,
      fhSpeedAvg: 71.3,
      bhSpeedAvg: 60,
      serveSpeedMax: null,
      inPct: 83.3,
      outCount: 1,
      closeCount: 1,
      playedOnAfterOutRallies: 1,
      firstServeInPct: null,
      pointsWon: 0,
      pointsLost: 0,
    });
  });

  it("includes 1-shot feeds in the average when asked and uses doubles sidelines when recomputing depth zones", () => {
    const s = summarizeSession({ sessionType: "rally", rallies: rallyModeRallies, hideOneShotFeeds: false });
    const doublesAlleyRally = [
      rally({
        rallyIdx: 0,
        shotCount: 2,
        shots: [
          shot({ rallyIdx: 0, shotIdx: 0, stroke: "fh", bounceX: 4.8, bounceY: 9.2, depthZone: null, call: "in" }),
        ],
      }),
    ];
    const singlesSummary = summarizeSession({ sessionType: "rally", rallies: doublesAlleyRally, doubles: false });
    const doublesSummary = summarizeSession({ sessionType: "rally", rallies: doublesAlleyRally, doubles: true });
    expect({
      qualifyingRallies: s.qualifyingRallies,
      avgRallyLength: s.avgRallyLength,
      singlesDeepPct: singlesSummary.deepZonePct,
      doublesDeepPct: doublesSummary.deepZonePct,
    }).toEqual({
      qualifyingRallies: 3,
      avgRallyLength: 5.7,
      singlesDeepPct: 0,
      doublesDeepPct: 100,
    });
  });

  it("computes Match Mode serve and point stats", () => {
    const matchRallies: TennisRally[] = [
      rally({
        rallyIdx: 0,
        shotCount: 2,
        inStreak: 1,
        shots: [
          shot({ rallyIdx: 0, shotIdx: 0, stroke: "serve", depthZone: "short", speedMph: 105, call: "in" }),
          shot({ rallyIdx: 0, shotIdx: 1, stroke: "fh", depthZone: "out_long", speedMph: 70, call: "out" }),
        ],
      }),
      rally({
        rallyIdx: 1,
        shotCount: 1,
        shots: [shot({ rallyIdx: 1, shotIdx: 0, stroke: "serve", depthZone: "out_long", speedMph: 110, call: "out" })],
      }),
    ];
    expect(
      summarizeSession({
        sessionType: "match",
        rallies: matchRallies,
        points: [
          { pointIdx: 0, winner: "me", server: "me", source: "watch", bookmarked: false, atS: 3 },
          { pointIdx: 1, winner: "opp", server: "me", source: "watch", bookmarked: false, atS: 9 },
          { pointIdx: 2, winner: "me", server: "me", source: "auto", bookmarked: true, atS: 15 },
        ],
        coachNotes: "Turn the shoulders earlier.",
      }),
    ).toEqual({
      sessionType: "match",
      totalRallies: 2,
      qualifyingRallies: 2,
      totalShots: 3,
      longestRally: 2,
      longestInStreak: 1,
      avgRallyLength: 1.5,
      rallies10Plus: 0,
      deepZonePct: 0,
      shortZonePct: 0,
      fhSpeedAvg: 70,
      bhSpeedAvg: null,
      serveSpeedMax: 110,
      inPct: 33.3,
      outCount: 2,
      closeCount: 0,
      playedOnAfterOutRallies: 0,
      firstServeInPct: 50,
      pointsWon: 2,
      pointsLost: 1,
      coachNotes: "Turn the shoulders earlier.",
    });
  });

  it("returns zeros for an empty session", () => {
    expect(summarizeSession({ sessionType: "rally", rallies: [] })).toEqual({
      sessionType: "rally",
      totalRallies: 0,
      qualifyingRallies: 0,
      totalShots: 0,
      longestRally: 0,
      longestInStreak: 0,
      avgRallyLength: 0,
      rallies10Plus: 0,
      deepZonePct: 0,
      shortZonePct: 0,
      fhSpeedAvg: null,
      bhSpeedAvg: null,
      serveSpeedMax: null,
      inPct: 0,
      outCount: 0,
      closeCount: 0,
      playedOnAfterOutRallies: 0,
      firstServeInPct: null,
      pointsWon: 0,
      pointsLost: 0,
    });
  });
});

describe("formatScore", () => {
  it("formats scoreboards", () => {
    expect({
      none: formatScore(null),
      inProgress: formatScore({ sets: [[6, 4]], games: [3, 2], points: ["40", "15"] }),
      setsOnly: formatScore({
        sets: [
          [6, 3],
          [6, 4],
        ],
        games: [0, 0],
        points: ["0", "0"],
      }),
      backendDisplay: formatScore({ sets: [], games: [5, 4], points: "AD-40", display: "5-4 (AD-40)" }),
      stringPoints: formatScore({ sets: [], games: [1, 0], points: "30-15" }),
    }).toEqual({
      none: "No score recorded",
      inProgress: "6-4, 3-2 (40-15)",
      setsOnly: "6-3, 6-4",
      backendDisplay: "5-4 (AD-40)",
      stringPoints: "1-0 (30-15)",
    });
  });
});

describe("resolveClipUrl", () => {
  it("joins relative Modal clip paths onto the base URL", () => {
    expect({
      relative: resolveClipUrl(`/clips/${MATCH_ID}/2.mp4`, "https://tennis.modal.run/"),
      absolute: resolveClipUrl("https://cdn.example/clip.mp4", undefined),
      noBase: resolveClipUrl(`/clips/${MATCH_ID}/2.mp4`, undefined),
      noClip: resolveClipUrl(null, "https://tennis.modal.run"),
    }).toEqual({
      relative: `https://tennis.modal.run/clips/${MATCH_ID}/2.mp4`,
      absolute: "https://cdn.example/clip.mp4",
      noBase: null,
      noClip: null,
    });
  });
});

describe("webhook auth and job tokens", () => {
  it("fails closed and compares Bearer tokens", () => {
    expect({
      noSecret: verifyWebhookAuth("Bearer secret123", ""),
      noHeader: verifyWebhookAuth(null, "secret123"),
      notBearer: verifyWebhookAuth("Basic secret123", "secret123"),
      wrongSameLength: verifyWebhookAuth("Bearer secret124", "secret123"),
      wrongLength: verifyWebhookAuth("Bearer s", "secret123"),
      ok: verifyWebhookAuth("Bearer secret123", "secret123"),
    }).toEqual({
      noSecret: { ok: false, status: 500, error: "TENNIS_WEBHOOK_SECRET is not configured." },
      noHeader: { ok: false, status: 401, error: "unauthorized" },
      notBearer: { ok: false, status: 401, error: "unauthorized" },
      wrongSameLength: { ok: false, status: 401, error: "unauthorized" },
      wrongLength: { ok: false, status: 401, error: "unauthorized" },
      ok: { ok: true, status: 200 },
    });
  });

  it("mints X-Job-Tokens byte-identical to rally_api.mint_token", async () => {
    // Expected value from Python: hmac.new(b"secret123", f"{scope}.{exp}".encode(), sha256).hexdigest()
    const expected = `${MATCH_ID}.1767225600.4f743e5313804768b603cc543f885bc66e0d7add802a75c07153cb7bfff5d103`;
    expect({
      exact: await signModalJobToken(MATCH_ID, 1767225600, "secret123"),
      fractionalExpFloored: await signModalJobToken(MATCH_ID, 1767225600.9, "secret123"),
    }).toEqual({ exact: expected, fractionalExpFloored: expected });
    await expect(signModalJobToken(MATCH_ID, 1767225600, "")).rejects.toThrow("TENNIS_JOB_SECRET is not configured.");
  });
});

describe("parseWebhookEvent", () => {
  it("parses rally.ready into a rally with shots and preserves bookmarked, live_call, session metadata, and points", () => {
    expect(
      parseWebhookEvent({
        event_id: "evt-1",
        type: "rally.ready",
        match_id: MATCH_ID,
        session_type: "match",
        source: "ios",
        doubles: true,
        live_call: "out",
        score: { sets: [[1, 0]], games: [2, 1], points: ["30", "15"] },
        points: [{ point_idx: 0, winner: "near", server: "near", source: "watch", bookmarked: true, at_s: 23.8 }],
        rally: {
          rally_idx: 2,
          start_s: 12.5,
          end_s: 24,
          shot_count: 2,
          in_streak: 1,
          clip_url: `/clips/${MATCH_ID}/2.mp4`,
          ball_track: [[12500, 640, 360]],
          drift_px: 0.8,
          bookmarked: true,
        },
        shots: [
          {
            shot_idx: 0,
            hitter: "near",
            stroke: "fh",
            direction: "cross",
            depth_zone: "deep",
            t_hit_s: 12.6,
            t_bounce_s: 13.4512,
            hit_x: 2.8,
            hit_y: -11.4,
            bounce_x: -2.9,
            bounce_y: 9.6,
            speed_mph: 73.5,
            net_clearance_m: 0.62,
            call: "in",
            margin_m: -0.85,
            sigma_m: 0.032,
          },
          { shot_idx: 1, hitter: "far", stroke: "bh", call: "out", depth_zone: "bogus" },
        ],
      }),
    ).toEqual({
      type: "rally.ready",
      eventId: "evt-1",
      matchId: MATCH_ID,
      sessionType: "match",
      source: "ios",
      doubles: true,
      court: null,
      score: { sets: [[1, 0]], games: [2, 1], points: ["30", "15"] },
      stats: null,
      points: [{ pointIdx: 0, winner: "me", server: "me", source: "watch", bookmarked: true, atS: 23.8 }],
      rally: {
        rallyIdx: 2,
        startS: 12.5,
        endS: 24,
        shotCount: 2,
        inStreak: 1,
        bookmarked: true,
        clipUrl: `/clips/${MATCH_ID}/2.mp4`,
        ballTrack: [[12500, 640, 360]],
        driftPx: 0.8,
        shots: [
          {
            rallyIdx: 2,
            shotIdx: 0,
            hitter: "near",
            stroke: "fh",
            direction: "cross",
            depthZone: "deep",
            tHitS: 12.6,
            tBounceS: 13.4512,
            hitX: 2.8,
            hitY: -11.4,
            bounceX: -2.9,
            bounceY: 9.6,
            speedMph: 73.5,
            netClearanceM: 0.62,
            call: "in",
            marginM: -0.85,
            sigmaM: 0.032,
            liveCall: null,
          },
          shot({ rallyIdx: 2, shotIdx: 1, hitter: "far", stroke: "bh", call: "out", liveCall: "out" }),
        ],
      },
    });
  });

  it("parses match.status and match.ready (including Phase 3 biomechanics and points)", () => {
    expect({
      processing: parseWebhookEvent({
        event_id: "evt-2",
        type: "match.status",
        match_id: MATCH_ID,
        status: "processing",
        rallies_expected: 24,
        session_type: "rally",
        source: "web",
        fps: 59.94,
      }),
      failed: parseWebhookEvent({ type: "match.status", match_id: MATCH_ID, status: "failed", error: "no court" }),
      ready: parseWebhookEvent({
        event_id: "evt-3",
        type: "match.ready",
        match_id: MATCH_ID,
        status: "ready",
        rallies_done: 24,
        stats: {
          longest_rally: 31,
          biomechanics: {
            traits: [{ trait: "Hip-Shoulder Separation", stroke: "fh", user_value: 38.2, pro_mean: 42.0, pro_std: 4.0, unit: "deg" }],
            coach_notes: "Rotate hips earlier through contact.",
          },
        },
        score: null,
      }),
    }).toEqual({
      processing: {
        type: "match.status",
        eventId: "evt-2",
        matchId: MATCH_ID,
        status: "processing",
        error: null,
        ralliesExpected: 24,
        sessionType: "rally",
        source: "web",
        fps: 59.94,
      },
      failed: {
        type: "match.status",
        eventId: null,
        matchId: MATCH_ID,
        status: "failed",
        error: "no court",
        ralliesExpected: null,
        sessionType: null,
        source: null,
        fps: null,
      },
      ready: {
        type: "match.ready",
        eventId: "evt-3",
        matchId: MATCH_ID,
        ralliesDone: 24,
        score: null,
        sessionType: null,
        source: null,
        doubles: null,
        court: null,
        stats: {
          longest_rally: 31,
          biomechanics: {
            traits: [{ trait: "Hip-Shoulder Separation", stroke: "fh", user_value: 38.2, pro_mean: 42.0, pro_std: 4.0, unit: "deg" }],
            coach_notes: "Rotate hips earlier through contact.",
          },
          biomechTraits: [
            {
              trait: "Hip-Shoulder Separation",
              stroke: "fh",
              userValue: 38.2,
              proMean: 42,
              proStd: 4,
              zScore: -0.95,
              unit: "deg",
            },
          ],
          coachNotes: "Rotate hips earlier through contact.",
        },
        points: [],
      },
    });
  });

  it("rejects malformed events", () => {
    expect(() => parseWebhookEvent(null)).toThrow("INVALID_ARGUMENT: webhook body must be a JSON object.");
    expect(() => parseWebhookEvent([])).toThrow("INVALID_ARGUMENT: webhook body must be a JSON object.");
    expect(() => parseWebhookEvent({ type: "match.ready", match_id: "nope" })).toThrow(
      "INVALID_ARGUMENT: match_id must be a valid UUID.",
    );
    expect(() => parseWebhookEvent({ type: "rally_processed", match_id: MATCH_ID })).toThrow(
      "INVALID_ARGUMENT: unsupported webhook event type.",
    );
    expect(() => parseWebhookEvent({ type: "match.status", match_id: MATCH_ID, status: "ready" })).toThrow(
      "INVALID_ARGUMENT: match.status requires status processing|failed.",
    );
    expect(() => parseWebhookEvent({ type: "rally.ready", match_id: MATCH_ID, rally: { start_s: 1, end_s: 2 } })).toThrow(
      "INVALID_ARGUMENT: rally.ready requires rally.rally_idx, start_s and end_s.",
    );
  });
});

function createInMemorySupabase() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    tennis_matches: [],
    tennis_rallies: [],
    tennis_shots: [],
    tennis_points: [],
  };

  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        upsert(
          payload: Record<string, unknown> | Array<Record<string, unknown>>,
          opts?: { onConflict?: string; ignoreDuplicates?: boolean },
        ) {
          const items = Array.isArray(payload) ? payload : [payload];
          const conflictKeys = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
          for (const item of items) {
            const idx = rows.findIndex((r) => conflictKeys.every((k) => r[k] === item[k]));
            if (idx === -1) {
              rows.push({
                played_on: "2026-10-23",
                session_type: "rally",
                source: "ios",
                status: "processing",
                doubles: false,
                rallies_done: 0,
                stats: {},
                created_at: "2026-10-23T00:00:00.000Z",
                updated_at: "2026-10-23T00:00:00.000Z",
                ...item,
              });
            } else if (!opts?.ignoreDuplicates) {
              rows[idx] = { ...rows[idx], ...item };
            }
          }
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          const filters: Array<(r: Record<string, unknown>) => boolean> = [];
          const runUpdate = () => {
            for (let i = 0; i < rows.length; i++) {
              if (filters.every((fn) => fn(rows[i]))) {
                rows[i] = { ...rows[i], ...patch };
              }
            }
            return Promise.resolve({ error: null });
          };
          const builder = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val);
              return builder;
            },
            neq(col: string, val: unknown) {
              filters.push((r) => r[col] !== val);
              return builder;
            },
            // biome-ignore lint/suspicious/noThenProperty: Supabase query builder is a PromiseLike
            then<TResult1 = { error: null }, TResult2 = never>(
              onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              return runUpdate().then(onfulfilled, onrejected);
            },
          };
          return builder;
        },
        select(_cols: string) {
          const filters: Array<(r: Record<string, unknown>) => boolean> = [];
          const orders: string[] = [];
          const getFiltered = () => {
            const matched = rows.filter((r) => filters.every((fn) => fn(r)));
            for (const col of [...orders].reverse()) {
              matched.sort((a, b) => Number(a[col] ?? 0) - Number(b[col] ?? 0));
            }
            return matched;
          };
          const builder = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val);
              return builder;
            },
            order(col: string) {
              orders.push(col);
              return builder;
            },
            maybeSingle() {
              const matched = getFiltered();
              return Promise.resolve({ data: matched[0] ?? null, error: null });
            },
            // biome-ignore lint/suspicious/noThenProperty: Supabase query builder is a PromiseLike
            then<TResult1 = { data: Array<Record<string, unknown>>; error: null }, TResult2 = never>(
              onfulfilled?: (
                value: { data: Array<Record<string, unknown>>; error: null },
              ) => TResult1 | PromiseLike<TResult1>,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              return Promise.resolve({ data: getFiltered(), error: null }).then(onfulfilled, onrejected);
            },
          };
          return builder;
        },
      };
    },
  } as unknown as Parameters<typeof applyWebhookEvent>[1];
}

describe("applyWebhookEvent and getTennisMatch", () => {
  it("transitions iOS rally.ready sessions to ready, persists bookmarked/live_call/points/court, and merges Phase 3 biomechanics", async () => {
    const client = createInMemorySupabase();
    const modalCourt = {
      size: [1920, 1080],
      court_px: [CORNERS_PX[3], CORNERS_PX[2], CORNERS_PX[0], CORNERS_PX[1]],
      posts_px: POSTS_PX,
    };

    const rallyEvt = parseWebhookEvent({
      event_id: "evt-ios-1",
      type: "rally.ready",
      match_id: MATCH_ID,
      session_type: "match",
      source: "ios",
      doubles: true,
      court: modalCourt,
      score: { sets: [[1, 0]], games: [2, 1], points: ["30", "15"] },
      points: [{ point_idx: 0, winner: "near", server: "near", source: "watch", bookmarked: true, at_s: 15.2 }],
      rally: {
        rally_idx: 0,
        start_s: 10,
        end_s: 16,
        shot_count: 2,
        in_streak: 1,
        bookmarked: true,
        clip_url: `/clips/${MATCH_ID}/0.mp4`,
      },
      shots: [
        {
          shot_idx: 0,
          hitter: "near",
          stroke: "serve",
          t_hit_s: 10.2,
          t_bounce_s: 10.9,
          hit_x: 1.2,
          hit_y: -11.8,
          bounce_x: -1.8,
          bounce_y: 5.2,
          speed_mph: 108,
          call: "in",
          live_call: "in",
        },
        {
          shot_idx: 1,
          hitter: "far",
          stroke: "fh",
          t_hit_s: 11.4,
          t_bounce_s: 12.3,
          hit_x: -2.0,
          hit_y: 10.5,
          bounce_x: 4.8,
          bounce_y: -9.5,
          speed_mph: 74,
          call: "in",
          live_call: "out",
        },
      ],
    });

    await applyWebhookEvent(rallyEvt, client);
    const afterRally = await getTennisMatch(MATCH_ID, true, client);

    // Late match.status processing event must not move a ready session back to processing
    await applyWebhookEvent(
      parseWebhookEvent({
        type: "match.status",
        match_id: MATCH_ID,
        status: "processing",
      }),
      client,
    );

    // Phase 3 match.ready with biomechanics traits and coach notes
    await applyWebhookEvent(
      parseWebhookEvent({
        type: "match.ready",
        match_id: MATCH_ID,
        rallies_done: 1,
        stats: {
          biomechanics: {
            traits: [
              { trait: "Knee Bend", stroke: "serve", user_value: 44, pro_mean: 50, pro_std: 5, unit: "deg" },
            ],
            coach_notes: "Load the back leg deeper on the trophy pose.",
          },
        },
      }),
      client,
    );

    const finalDetail = await getTennisMatch(MATCH_ID, true, client);
    expect({
      statusAfterRally: afterRally?.status,
      sessionType: finalDetail?.sessionType,
      doubles: finalDetail?.doubles,
      courtCorners: finalDetail?.court?.cornersPx,
      rallyBookmarked: finalDetail?.rallies[0]?.bookmarked,
      secondShotLiveCall: finalDetail?.rallies[0]?.shots[1]?.liveCall,
      points: finalDetail?.points,
      deepZonePct: finalDetail?.summary.deepZonePct,
      pointsWon: finalDetail?.summary.pointsWon,
      biomechTraits: finalDetail?.summary.biomechTraits,
      coachNotes: finalDetail?.summary.coachNotes,
      finalStatus: finalDetail?.status,
    }).toEqual({
      statusAfterRally: "ready",
      sessionType: "match",
      doubles: true,
      courtCorners: CORNERS_PX,
      rallyBookmarked: true,
      secondShotLiveCall: "out",
      points: [{ pointIdx: 0, winner: "me", server: "me", source: "watch", bookmarked: true, atS: 15.2 }],
      deepZonePct: 100,
      pointsWon: 1,
      biomechTraits: [
        {
          trait: "Knee Bend",
          stroke: "serve",
          userValue: 44,
          proMean: 50,
          proStd: 5,
          zScore: -1.2,
          unit: "deg",
        },
      ],
      coachNotes: "Load the back leg deeper on the trophy pose.",
      finalStatus: "ready",
    });

    const listed = await listTennisMatches("all", client);
    const allSummary = summarizeAllSessions(listed);
    expect({
      summary: allSummary.summary,
      firstMatchId: allSummary.sessions[0]?.matchId,
      firstScoreFormatted: allSummary.sessions[0]?.scoreFormatted,
    }).toEqual({
      summary: {
        totalSessions: 1,
        totalRallies: 1,
        totalShots: 2,
        bestInStreak: 2,
        inCallRate: 100,
      },
      firstMatchId: MATCH_ID,
      firstScoreFormatted: "1-0, 2-1 (30-15)",
    });
  });

  it("summarizeAllSessions aggregates across multiple sessions and handles empty lists", () => {
    const baseMatch: TennisMatch = {
      id: MATCH_ID,
      title: "Morning Hit",
      playedOn: "2026-10-23",
      sessionType: "rally",
      source: "ios",
      status: "ready",
      court: null,
      doubles: false,
      fps: 60,
      ralliesExpected: 10,
      ralliesDone: 10,
      score: null,
      stats: {
        totalRallies: 10,
        totalShots: 60,
        longestRally: 18,
        longestInStreak: 15,
        inPct: 90,
        outCount: 6,
      },
      error: null,
      createdAt: "2026-10-23T08:00:00.000Z",
      updatedAt: "2026-10-23T08:30:00.000Z",
    };

    const secondMatch: TennisMatch = {
      ...baseMatch,
      id: "223e4567-e89b-42d3-a456-426614174000",
      title: "Evening Set",
      sessionType: "match",
      source: "web",
      ralliesDone: 8,
      score: { sets: [[6, 4]], games: [0, 0], points: ["0", "0"] },
      stats: {
        totalRallies: 8,
        totalShots: 40,
        longestRally: 12,
        longestInStreak: 12,
        inPct: 80,
        outCount: 8,
      },
    };

    const processingMatch: TennisMatch = {
      ...baseMatch,
      id: "323e4567-e89b-42d3-a456-426614174000",
      status: "processing",
      ralliesDone: 2,
      stats: {},
    };

    expect({
      empty: summarizeAllSessions([]).summary,
      multi: summarizeAllSessions([baseMatch, secondMatch, processingMatch]).summary,
      secondScore: summarizeAllSessions([baseMatch, secondMatch]).sessions[1]?.scoreFormatted,
    }).toEqual({
      empty: {
        totalSessions: 0,
        totalRallies: 0,
        totalShots: 0,
        bestInStreak: 0,
        inCallRate: 0,
      },
      multi: {
        totalSessions: 3,
        totalRallies: 20,
        totalShots: 100,
        bestInStreak: 15,
        inCallRate: 86,
      },
      secondScore: "6-4",
    });
  });
});
