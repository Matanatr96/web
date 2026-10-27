import { describe, it, expect } from "vitest";
import { computeHallOfFame, assignManagerArchetype } from "@/lib/fantasy";
import type {
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  HallOfFameEntry,
} from "@/lib/types";

function makeOwner(user_id: string, display_name: string): FantasyOwner {
  return {
    user_id,
    display_name,
    avatar: null,
  };
}

let nextMatchupRowId = 1;

function makeMatchup(overrides: {
  season: number;
  week: number;
  owner_id: string;
  opponent_id: string;
  points: number;
  opponent_points: number;
}): FantasyMatchup {
  const result =
    overrides.points > overrides.opponent_points
      ? "W"
      : overrides.points < overrides.opponent_points
      ? "L"
      : "T";
  return {
    id: nextMatchupRowId++,
    season: overrides.season,
    week: overrides.week,
    owner_id: overrides.owner_id,
    opponent_id: overrides.opponent_id,
    points: overrides.points,
    opponent_points: overrides.opponent_points,
    result,
  };
}

function makePairMatchups(
  season: number,
  week: number,
  ownerA: string,
  ptsA: number,
  ownerB: string,
  ptsB: number,
): FantasyMatchup[] {
  return [
    makeMatchup({
      season,
      week,
      owner_id: ownerA,
      opponent_id: ownerB,
      points: ptsA,
      opponent_points: ptsB,
    }),
    makeMatchup({
      season,
      week,
      owner_id: ownerB,
      opponent_id: ownerA,
      points: ptsB,
      opponent_points: ptsA,
    }),
  ];
}

describe("computeHallOfFame", () => {
  it("returns empty array when matchups, owners, or leagues are empty", () => {
    expect(computeHallOfFame([], [], [])).toEqual([]);
  });

  it("computes hardware, regular-season stats, and skips hardware/last for in-progress seasons", () => {
    const owners = [
      makeOwner("u1", "DynastyDan"),
      makeOwner("u2", "RegularSeasonKing"),
      makeOwner("u3", "BoomOrBustBob"),
      makeOwner("u4", "TacoTom"),
    ];

    const leagues: FantasyLeague[] = [
      {
        league_id: "league-2024",
        season: 2024,
        name: "KFL",
        playoff_week_start: 3,
        winners_bracket: [
          { r: 1, m: 1, p: null, t1: "u1", t2: "u4", w: "u1", l: "u4" },
          { r: 1, m: 2, p: null, t1: "u2", t2: "u3", w: "u2", l: "u3" },
          { r: 2, m: 3, p: 1, t1: "u1", t2: "u2", w: "u1", l: "u2" },
          { r: 2, m: 4, p: 3, t1: "u3", t2: "u4", w: "u3", l: "u4" },
        ],
      },
      {
        league_id: "league-2025",
        season: 2025,
        name: "KFL",
        playoff_week_start: 3,
        winners_bracket: [
          { r: 1, m: 1, p: null, t1: "u1", t2: "u3", w: "u3", l: "u1" },
          { r: 1, m: 2, p: null, t1: "u2", t2: "u4", w: "u2", l: "u4" },
          { r: 2, m: 3, p: 1, t1: "u3", t2: "u2", w: "u3", l: "u2" },
          { r: 2, m: 4, p: 3, t1: "u1", t2: "u4", w: "u1", l: "u4" },
        ],
      },
      // In-progress 2026 season (p=1 has w: null)
      {
        league_id: "league-2026",
        season: 2026,
        name: "KFL",
        playoff_week_start: 3,
        winners_bracket: [
          { r: 2, m: 3, p: 1, t1: null, t2: null, w: null, l: null },
        ],
      },
    ];

    const matchups: FantasyMatchup[] = [
      // 2024 Week 1 & Week 2 (regular season)
      ...makePairMatchups(2024, 1, "u2", 150, "u4", 80),
      ...makePairMatchups(2024, 1, "u1", 130, "u3", 100),
      ...makePairMatchups(2024, 2, "u2", 145, "u3", 95),
      ...makePairMatchups(2024, 2, "u1", 125, "u4", 75),
      // 2025 Week 1 & Week 2 (regular season)
      ...makePairMatchups(2025, 1, "u2", 155, "u4", 70),
      ...makePairMatchups(2025, 1, "u1", 120, "u3", 110),
      ...makePairMatchups(2025, 2, "u2", 140, "u1", 115),
      ...makePairMatchups(2025, 2, "u3", 105, "u4", 65),
      // 2026 Week 1 (in-progress regular season — should count toward wins/PPG, NOT hardware/last)
      ...makePairMatchups(2026, 1, "u2", 160, "u4", 60),
      ...makePairMatchups(2026, 1, "u1", 135, "u3", 90),
    ];

    const hof = computeHallOfFame(matchups, owners, leagues, "balanced");
    expect(hof).toHaveLength(4);

    for (const entry of hof) {
      expect(entry.legacy_score).toBeGreaterThanOrEqual(0);
      expect(entry.legacy_score).toBeLessThanOrEqual(100);
      expect(entry.completed_seasons).toBe(2);
      expect(entry.seasons_played).toBe(3);
    }

    const u1 = hof.find((e) => e.owner_id === "u1")!;
    const u2 = hof.find((e) => e.owner_id === "u2")!;
    const u3 = hof.find((e) => e.owner_id === "u3")!;
    const u4 = hof.find((e) => e.owner_id === "u4")!;

    // Hardware checks across 2024 & 2025 only
    expect(u1.firsts).toBe(1);
    expect(u1.seconds).toBe(0);
    expect(u1.thirds).toBe(1);
    expect(u1.lasts).toBe(0);

    expect(u2.firsts).toBe(0);
    expect(u2.seconds).toBe(2);
    expect(u2.wins).toBe(5); // 2 in 2024 + 2 in 2025 + 1 in 2026
    expect(u2.reg_season_firsts).toBe(2);

    expect(u3.firsts).toBe(1);
    expect(u3.thirds).toBe(1);

    // u4 finished last in 2024 and 2025, NOT penalized yet for in-progress 2026
    expect(u4.lasts).toBe(2);
    expect(u4.wins).toBe(0);
    expect(u4.losses).toBe(5);
    expect(u4.archetype).toBe("THE LEAGUE'S WORST");

    // Season finishes include 2026 as "In Progress"
    expect(u1.season_finishes.map((s) => ({ season: s.season, finish: s.finish }))).toEqual([
      { season: 2026, finish: "In Progress" },
      { season: 2025, finish: "3rd" },
      { season: 2024, finish: "1st" },
    ]);

    // Mode switching shifts scores as expected:
    // In "rings" mode, ring-winner u3 gains relative to ringless u2 compared to "dominance" mode
    const ringsHof = computeHallOfFame(matchups, owners, leagues, "rings");
    const domHof = computeHallOfFame(matchups, owners, leagues, "dominance");

    const u3Rings = ringsHof.find((e) => e.owner_id === "u3")!.legacy_score;
    const u2Rings = ringsHof.find((e) => e.owner_id === "u2")!.legacy_score;
    const u3Dom = domHof.find((e) => e.owner_id === "u3")!.legacy_score;
    const u2Dom = domHof.find((e) => e.owner_id === "u2")!.legacy_score;

    expect(u3Rings - u2Rings).toBeGreaterThan(u3Dom - u2Dom);
  });
});

describe("assignManagerArchetype", () => {
  const baseEntry: HallOfFameEntry = {
    owner_id: "u1",
    display_name: "Manager",
    seasons_played: 5,
    completed_seasons: 5,
    wins: 40,
    losses: 30,
    ties: 0,
    win_pct: 40 / 70,
    unrealized_wins: 420,
    unrealized_losses: 350,
    all_play_pct: 420 / 770,
    avg_ppg: 140,
    points_for: 9800,
    firsts: 0,
    seconds: 0,
    thirds: 0,
    lasts: 0,
    reg_season_firsts: 0,
    playoff_appearances: 3,
    playoff_wins: 2,
    archetype: "",
    legacy_score: 70,
    breakdown: {
      hardware_pts: 10,
      win_rate_pts: 20,
      dominance_pts: 20,
      playoff_pts: 10,
      toilet_penalty_pts: 0,
      raw_total: 60,
    },
    season_finishes: [],
  };

  it("assigns THE DYNASTY for 2+ rings and 0 last places", () => {
    expect(
      assignManagerArchetype(
        { ...baseEntry, firsts: 2, lasts: 0 },
        1,
        12,
        45,
        145,
      ),
    ).toBe("THE DYNASTY");
  });

  it("assigns BOOM OR BUST for 2+ rings and at least 1 last place", () => {
    expect(
      assignManagerArchetype(
        { ...baseEntry, firsts: 2, lasts: 1 },
        2,
        12,
        45,
        145,
      ),
    ).toBe("BOOM OR BUST");
  });

  it("assigns GIANT SLAYER for 1 ring and sub-.500 regular-season win rate", () => {
    expect(
      assignManagerArchetype(
        { ...baseEntry, firsts: 1, wins: 30, losses: 40, win_pct: 30 / 70 },
        4,
        12,
        45,
        145,
      ),
    ).toBe("GIANT SLAYER");
  });

  it("assigns REGULAR SEASON KING for 0 rings, max wins, and runner-up hardware", () => {
    expect(
      assignManagerArchetype(
        { ...baseEntry, firsts: 0, seconds: 1, wins: 45 },
        3,
        12,
        45,
        145,
      ),
    ).toBe("REGULAR SEASON KING");
  });

  it("assigns SCORING MACHINE for 0 rings and highest career PPG", () => {
    expect(
      assignManagerArchetype(
        { ...baseEntry, firsts: 0, seconds: 0, wins: 41, avg_ppg: 145 },
        4,
        12,
        45,
        145,
      ),
    ).toBe("SCORING MACHINE");
  });

  it("assigns THE LEAGUE'S WORST to the bottom-ranked ringless manager", () => {
    expect(
      assignManagerArchetype(
        { ...baseEntry, firsts: 0, lasts: 2, win_pct: 0.35 },
        12,
        12,
        45,
        145,
      ),
    ).toBe("THE LEAGUE'S WORST");
  });
});
