import { describe, it, expect } from "vitest";
import {
  buildStandings,
  buildWeeklyAverages,
  computeScheduleLottery,
  mean,
  stdev,
  percentile,
  isRegularSeason,
  regularSeasonOnly,
  topScoringRecords,
  lowestScoringRecords,
  biggestBlowouts,
  buildTradeLeaderboard,
} from "./fantasy";
import type {
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  FantasyTrade,
} from "./types";

const owners: FantasyOwner[] = [
  { user_id: "a", display_name: "Alice", avatar: null },
  { user_id: "b", display_name: "Bob",   avatar: null },
  { user_id: "c", display_name: "Cara",  avatar: null },
  { user_id: "d", display_name: "Dan",   avatar: null },
];

// 4-team, 1-week league. Scores: a=100, b=90, c=80, d=70. Pairs: a-b, c-d.
const week1: FantasyMatchup[] = [
  { id: 1, season: 2024, week: 1, owner_id: "a", opponent_id: "b", points: 100, opponent_points: 90,  result: "W" },
  { id: 2, season: 2024, week: 1, owner_id: "b", opponent_id: "a", points: 90,  opponent_points: 100, result: "L" },
  { id: 3, season: 2024, week: 1, owner_id: "c", opponent_id: "d", points: 80,  opponent_points: 70,  result: "W" },
  { id: 4, season: 2024, week: 1, owner_id: "d", opponent_id: "c", points: 70,  opponent_points: 80,  result: "L" },
];

describe("buildStandings", () => {
  it("computes records, all-play, PPG/PPGA, and league-relative avg", () => {
    const rows = buildStandings(week1, owners, 2024);
    const a = rows.find((r) => r.owner_id === "a")!;
    const b = rows.find((r) => r.owner_id === "b")!;
    const c = rows.find((r) => r.owner_id === "c")!;
    const d = rows.find((r) => r.owner_id === "d")!;

    // Real records.
    expect(a.wins).toBe(1); expect(a.losses).toBe(0);
    expect(d.wins).toBe(0); expect(d.losses).toBe(1);

    // All-play: a beats 3 others; b beats 1; c beats 1; d beats 0.
    // (b and c both scored more than d; both lost to a.)
    expect(a.unrealized_wins).toBe(3);
    expect(a.unrealized_losses).toBe(0);
    expect(b.unrealized_wins).toBe(2);
    expect(c.unrealized_wins).toBe(1);
    expect(d.unrealized_wins).toBe(0);

    // Averages.
    expect(a.avg_ppg).toBe(100);
    expect(a.avg_ppga).toBe(90);
    expect(a.avg_diff).toBe(10);

    // League avg PPG = mean(100,90,80,70) = 85.
    expect(a.ppg_vs_avg).toBe(15);
    expect(d.ppg_vs_avg).toBe(-15);

    // Default sort: by wins desc, then all-play wins desc, then PPG desc.
    // a (1W, 3 ap), c (1W, 1 ap), b (0W, 2 ap), d (0W, 0 ap).
    expect(rows.map((r) => r.owner_id)).toEqual(["a", "c", "b", "d"]);
  });

  it("returns empty for unseen season", () => {
    expect(buildStandings(week1, owners, 2099)).toEqual([]);
  });
});

describe("buildWeeklyAverages", () => {
  it("averages points per week across seasons, with null for unplayed", () => {
    const rows = buildWeeklyAverages(week1, [2024, 2023], 3);
    expect(rows).toHaveLength(3);
    // Week 1 2024: mean(100,90,80,70) = 85. Week 1 2023: null.
    expect(rows[0].averages[2024]).toBe(85);
    expect(rows[0].averages[2023]).toBeNull();
    expect(rows[1].averages[2024]).toBeNull();
  });
});

describe("stats helpers", () => {
  it("mean / stdev / percentile", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
    expect(percentile(85, [70, 80, 90, 100])).toBe(50);
    expect(percentile(100, [70, 80, 90, 100])).toBe(100);
  });
});

describe("regular season filtering", () => {
  const leagues: FantasyLeague[] = [
    { season: 2024, league_id: "x", name: "KFL", playoff_week_start: 15, winners_bracket: null },
    { season: 2023, league_id: "y", name: "KFL", playoff_week_start: null, winners_bracket: null },
  ];

  it("uses each league's playoff_week_start, falls back to 15", () => {
    expect(isRegularSeason(2024, 14, leagues)).toBe(true);
    expect(isRegularSeason(2024, 15, leagues)).toBe(false);
    expect(isRegularSeason(2023, 14, leagues)).toBe(true);
    expect(isRegularSeason(2023, 15, leagues)).toBe(false);
  });

  it("regularSeasonOnly drops playoff weeks", () => {
    const matchups: FantasyMatchup[] = [
      { id: 1, season: 2024, week: 14, owner_id: "a", opponent_id: "b", points: 100, opponent_points: 90, result: "W" },
      { id: 2, season: 2024, week: 15, owner_id: "a", opponent_id: "b", points: 80,  opponent_points: 70, result: "W" },
    ];
    expect(regularSeasonOnly(matchups, leagues)).toHaveLength(1);
    expect(regularSeasonOnly(matchups, leagues)[0].week).toBe(14);
  });
});

describe("record helpers", () => {
  const recOwners: FantasyOwner[] = [
    { user_id: "a", display_name: "Alice", avatar: null },
    { user_id: "b", display_name: "Bob",   avatar: null },
  ];
  const recMatchups: FantasyMatchup[] = [
    { id: 1, season: 2024, week: 1, owner_id: "a", opponent_id: "b", points: 150, opponent_points: 60, result: "W" },
    { id: 2, season: 2024, week: 1, owner_id: "b", opponent_id: "a", points: 60,  opponent_points: 150, result: "L" },
    { id: 3, season: 2024, week: 2, owner_id: "a", opponent_id: "b", points: 90,  opponent_points: 100, result: "L" },
    { id: 4, season: 2024, week: 2, owner_id: "b", opponent_id: "a", points: 100, opponent_points: 90, result: "W" },
  ];

  it("topScoringRecords sorts desc and resolves names", () => {
    const top = topScoringRecords(recMatchups, recOwners, 2);
    expect(top[0]).toMatchObject({ owner_id: "a", display_name: "Alice", points: 150 });
    expect(top[1]).toMatchObject({ owner_id: "b", points: 100 });
  });

  it("lowestScoringRecords excludes 0s and sorts asc", () => {
    const withZero: FantasyMatchup[] = [
      ...recMatchups,
      { id: 99, season: 2024, week: 18, owner_id: "a", opponent_id: null, points: 0, opponent_points: 0, result: "T" },
    ];
    const low = lowestScoringRecords(withZero, recOwners, 2);
    expect(low[0].points).toBe(60);
    expect(low.every((r) => r.points > 0)).toBe(true);
  });

  it("biggestBlowouts emits one row per matchup with differential", () => {
    const blow = biggestBlowouts(recMatchups, recOwners, 5);
    expect(blow).toHaveLength(2);
    expect(blow[0]).toMatchObject({
      owner_id: "a", opponent_id: "b", differential: 90,
    });
    expect(blow[1].differential).toBe(10);
  });
});

describe("computeScheduleLottery", () => {
  const slOwners: FantasyOwner[] = [
    { user_id: "a", display_name: "Alice", avatar: null },
    { user_id: "b", display_name: "Bob",   avatar: null },
    { user_id: "c", display_name: "Cara",  avatar: null },
    { user_id: "d", display_name: "Dan",   avatar: null },
  ];
  const slLeagues: FantasyLeague[] = [
    { season: 2024, league_id: "x", name: "KFL", playoff_week_start: 15, winners_bracket: null },
  ];

  // 4-team, 2-week regular season. Pairings:
  //   Week 1: a(110) vs b(90) → a wins;  c(100) vs d(70) → c wins
  //   Week 2: a(80)  vs c(95) → a loses; b(85)  vs d(60) → b wins
  // Actual records: a 1-1, b 1-1, c 1-1, d 0-2
  const slMatchups: FantasyMatchup[] = [
    { id: 1, season: 2024, week: 1, owner_id: "a", opponent_id: "b", points: 110, opponent_points: 90,  result: "W" },
    { id: 2, season: 2024, week: 1, owner_id: "b", opponent_id: "a", points: 90,  opponent_points: 110, result: "L" },
    { id: 3, season: 2024, week: 1, owner_id: "c", opponent_id: "d", points: 100, opponent_points: 70,  result: "W" },
    { id: 4, season: 2024, week: 1, owner_id: "d", opponent_id: "c", points: 70,  opponent_points: 100, result: "L" },
    { id: 5, season: 2024, week: 2, owner_id: "a", opponent_id: "c", points: 80,  opponent_points: 95,  result: "L" },
    { id: 6, season: 2024, week: 2, owner_id: "c", opponent_id: "a", points: 95,  opponent_points: 80,  result: "W" },
    { id: 7, season: 2024, week: 2, owner_id: "b", opponent_id: "d", points: 85,  opponent_points: 60,  result: "W" },
    { id: 8, season: 2024, week: 2, owner_id: "d", opponent_id: "b", points: 60,  opponent_points: 85,  result: "L" },
  ];

  it("diagonal equals each owner's actual record", () => {
    const { owners: seasonOwners, matrix } = computeScheduleLottery(slMatchups, slOwners, slLeagues, 2024);
    const idxOf = (id: string) => seasonOwners.findIndex((o) => o.user_id === id);

    const ai = idxOf("a");
    expect(matrix[ai][ai]).toMatchObject({ wins: 1, losses: 1, ties: 0 });

    const di = idxOf("d");
    expect(matrix[di][di]).toMatchObject({ wins: 0, losses: 2, ties: 0 });
  });

  it("cross-schedule cell reflects owner's scores vs the schedule-owner's opponents", () => {
    // a with d's schedule: face d's opponents each week.
    //   Week 1: d faced c (scored 100) → a(110) > 100 → W
    //   Week 2: d faced b (scored 85)  → a(80)  < 85  → L
    // Expected: 1-1
    const { owners: seasonOwners, matrix } = computeScheduleLottery(slMatchups, slOwners, slLeagues, 2024);
    const ai = seasonOwners.findIndex((o) => o.user_id === "a");
    const di = seasonOwners.findIndex((o) => o.user_id === "d");
    expect(matrix[ai][di]).toMatchObject({ wins: 1, losses: 1, ties: 0 });
  });

  it("luck delta is positive for an owner with an easy schedule", () => {
    // d scored 70 and 60 (weakest). With any other schedule they would have
    // faced the same or tougher opponents, so delta should be ≤ 0.
    // c scored 100 and 95 (second strongest) but faced tough opponents both
    // weeks; with easier schedules they'd win more → delta should be ≥ 0.
    const { luckDeltas } = computeScheduleLottery(slMatchups, slOwners, slLeagues, 2024);
    const d = luckDeltas.find((r) => r.owner_id === "d")!;
    const c = luckDeltas.find((r) => r.owner_id === "c")!;
    expect(d.delta).toBeLessThanOrEqual(0);
    expect(c.delta).toBeGreaterThanOrEqual(0);
  });

  it("returns empty matrix and luckDeltas for an unknown season", () => {
    const { owners: seasonOwners, matrix, luckDeltas } = computeScheduleLottery(
      slMatchups, slOwners, slLeagues, 1999,
    );
    expect(seasonOwners).toHaveLength(0);
    expect(matrix).toHaveLength(0);
    expect(luckDeltas).toHaveLength(0);
  });
});

describe("buildTradeLeaderboard", () => {
  const owners: FantasyOwner[] = [
    { user_id: "a", display_name: "Alice", avatar: null },
    { user_id: "b", display_name: "Bob",   avatar: null },
    { user_id: "c", display_name: "Cara",  avatar: null },
  ];
  const trades: FantasyTrade[] = [
    { id: "t1", season: 2024, week: 3, status: "complete", created_ms: 1, user_ids: ["a", "b"], payload: {} },
    { id: "t2", season: 2024, week: 5, status: "complete", created_ms: 2, user_ids: ["a", "c"], payload: {} },
    { id: "t3", season: 2024, week: 7, status: "complete", created_ms: 3, user_ids: ["a", "b"], payload: {} },
  ];

  it("counts trades per owner and includes zero-trade owners", () => {
    const rows = buildTradeLeaderboard(trades, owners);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ owner_id: "a", trade_count: 3 });
    expect(rows[1]).toMatchObject({ owner_id: "b", trade_count: 2 });
    expect(rows[2]).toMatchObject({ owner_id: "c", trade_count: 1 });
  });

  it("returns zero-count rows when there are no trades", () => {
    const rows = buildTradeLeaderboard([], owners);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.trade_count === 0)).toBe(true);
  });
});
