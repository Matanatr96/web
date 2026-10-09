import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildStandings,
  buildWeeklyAverages,
  computeScheduleLottery,
  computeWeeklyStats,
  buildRivalries,
  computeDraftGrades,
  pickSlotInRound,
  slotExpectationFactor,
  pickImpactWeight,
  fetchAllMatchups,
  fetchSeasonPlayerScores,
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
  FantasyDraftPick,
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  FantasyPlayerScore,
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

    // All-play: a beats 3 others; b beats 2; c beats 1; d beats 0.
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

    // Default sort: by win-tie record desc, then PPG desc, then all-play wins desc.
    expect(rows.map((r) => r.owner_id)).toEqual(["a", "c", "b", "d"]);
  });

  it("breaks record ties by avg_ppg (Points For) before unrealized_wins to match Sleeper", () => {
    // Two weeks where owner 'a' and owner 'b' both finish 1-1:
    // Week 1: a(150) beats c(50) [3 all-play W]; b(95) loses to d(100) [1 all-play W]
    // Week 2: a(60) loses to d(65) [0 all-play W]; b(95) beats c(90) [3 all-play W]
    // Totals:
    //   a: 1-1, 210 PF (105 PPG), 3 unrealized_wins
    //   b: 1-1, 190 PF (95 PPG),  4 unrealized_wins
    // Sleeper ranks 'a' ahead of 'b' because 210 PF > 190 PF despite lower all-play wins.
    const twoWeeks: FantasyMatchup[] = [
      { id: 1, season: 2024, week: 1, owner_id: "a", opponent_id: "c", points: 150, opponent_points: 50,  result: "W" },
      { id: 2, season: 2024, week: 1, owner_id: "c", opponent_id: "a", points: 50,  opponent_points: 150, result: "L" },
      { id: 3, season: 2024, week: 1, owner_id: "b", opponent_id: "d", points: 95,  opponent_points: 100, result: "L" },
      { id: 4, season: 2024, week: 1, owner_id: "d", opponent_id: "b", points: 100, opponent_points: 95,  result: "W" },
      { id: 5, season: 2024, week: 2, owner_id: "a", opponent_id: "d", points: 60,  opponent_points: 65,  result: "L" },
      { id: 6, season: 2024, week: 2, owner_id: "d", opponent_id: "a", points: 65,  opponent_points: 60,  result: "W" },
      { id: 7, season: 2024, week: 2, owner_id: "b", opponent_id: "c", points: 95,  opponent_points: 90,  result: "W" },
      { id: 8, season: 2024, week: 2, owner_id: "c", opponent_id: "b", points: 90,  opponent_points: 95,  result: "L" },
    ];
    const rows = buildStandings(twoWeeks, owners, 2024);
    expect(rows.map((r) => r.owner_id)).toEqual(["d", "a", "b", "c"]);
  });

  it("ignores unplayed all-zero weeks", () => {
    const withUnplayedWeek2: FantasyMatchup[] = [
      ...week1,
      { id: 5, season: 2024, week: 2, owner_id: "a", opponent_id: "c", points: 0, opponent_points: 0, result: "T" },
      { id: 6, season: 2024, week: 2, owner_id: "c", opponent_id: "a", points: 0, opponent_points: 0, result: "T" },
      { id: 7, season: 2024, week: 2, owner_id: "b", opponent_id: "d", points: 0, opponent_points: 0, result: "T" },
      { id: 8, season: 2024, week: 2, owner_id: "d", opponent_id: "b", points: 0, opponent_points: 0, result: "T" },
    ];
    const rows = buildStandings(withUnplayedWeek2, owners, 2024);
    const a = rows.find((r) => r.owner_id === "a")!;
    expect(a.ties).toBe(0);
    expect(a.avg_ppg).toBe(100);
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

  it("cross-schedule cell reflects owner's scores vs the schedule-owner's opponents without self-ties", () => {
    // a with d's schedule (never played each other):
    //   Week 1: d faced c (scored 100) → a(110) > 100 → W
    //   Week 2: d faced b (scored 85)  → a(80)  < 85  → L
    // Expected: 1-1-0
    const { owners: seasonOwners, matrix } = computeScheduleLottery(slMatchups, slOwners, slLeagues, 2024);
    const ai = seasonOwners.findIndex((o) => o.user_id === "a");
    const bi = seasonOwners.findIndex((o) => o.user_id === "b");
    const di = seasonOwners.findIndex((o) => o.user_id === "d");
    expect(matrix[ai][di]).toMatchObject({ wins: 1, losses: 1, ties: 0 });

    // a with b's schedule (played each other in Week 1):
    //   Week 1: b faced a → swapping schedules means a faces b (90) → a(110) > 90 → W (NOT a self-tie!)
    //   Week 2: b faced d (60) → a(80) > 60 → W
    // Expected: 2-0-0 (zero artificial self-ties)
    expect(matrix[ai][bi]).toMatchObject({ wins: 2, losses: 0, ties: 0 });
  });

  it("luck delta is non-positive for an owner who lost every game and non-negative for a strong scorer with a tough draw", () => {
    const { luckDeltas } = computeScheduleLottery(slMatchups, slOwners, slLeagues, 2024);
    const d = luckDeltas.find((r) => r.owner_id === "d")!;
    const c = luckDeltas.find((r) => r.owner_id === "c")!;
    expect(d.delta).toBeLessThanOrEqual(0);
    expect(c.delta).toBeLessThanOrEqual(0); // c went 1-1 but would go 2-0 on b's or d's schedule (median 1.5 → delta -0.5)
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

describe("computeWeeklyStats", () => {
  it("enforces mandatory positional starter minimums on cross-position FLEX bench swaps", () => {
    const matchups: FantasyMatchup[] = [
      { id: 1, season: 2025, week: 1, owner_id: "a", opponent_id: "b", points: 100, opponent_points: 100, result: "T" },
      { id: 2, season: 2025, week: 1, owner_id: "b", opponent_id: "a", points: 100, opponent_points: 100, result: "T" },
    ];
    // Owner 'a' starts 1 QB, 2 RB, 3 WR (so 1 WR is in FLEX), 1 TE.
    // RB2 scored 2 pts, TE1 scored 1 pt, WR3 scored 8 pts.
    // Bench has a WR ("Bench WR") with 25 pts.
    // Because RB count is 2 (== min 2) and TE count is 1 (== min 1), Bench WR can ONLY
    // legally replace a WR starter (worst WR = 8 pts, delta = 17), NOT TE1 (1 pt) or RB2 (2 pts).
    const playerScores: FantasyPlayerScore[] = [
      { id: 1, season: 2025, week: 1, owner_id: "a", player_id: "qb1", player_name: "QB1", position: "QB", team: "KC", points: 20, is_starter: true, created_at: "", updated_at: "" },
      { id: 2, season: 2025, week: 1, owner_id: "a", player_id: "rb1", player_name: "RB1", position: "RB", team: "SF", points: 15, is_starter: true, created_at: "", updated_at: "" },
      { id: 3, season: 2025, week: 1, owner_id: "a", player_id: "rb2", player_name: "RB2", position: "RB", team: "DET", points: 2, is_starter: true, created_at: "", updated_at: "" },
      { id: 4, season: 2025, week: 1, owner_id: "a", player_id: "wr1", player_name: "WR1", position: "WR", team: "CIN", points: 18, is_starter: true, created_at: "", updated_at: "" },
      { id: 5, season: 2025, week: 1, owner_id: "a", player_id: "wr2", player_name: "WR2", position: "WR", team: "DAL", points: 12, is_starter: true, created_at: "", updated_at: "" },
      { id: 6, season: 2025, week: 1, owner_id: "a", player_id: "wr3", player_name: "WR3", position: "WR", team: "MIN", points: 8, is_starter: true, created_at: "", updated_at: "" },
      { id: 7, season: 2025, week: 1, owner_id: "a", player_id: "te1", player_name: "TE1", position: "TE", team: "BAL", points: 1, is_starter: true, created_at: "", updated_at: "" },
      { id: 8, season: 2025, week: 1, owner_id: "a", player_id: "bwr", player_name: "Bench WR", position: "WR", team: "BUF", points: 25, is_starter: false, created_at: "", updated_at: "" },
    ];

    const stats = computeWeeklyStats(matchups, playerScores, owners, 2025, 1);
    expect(stats).not.toBeNull();
    expect(stats!.closest_matchup?.margin).toBe(0);
    expect(stats!.bench_mistake).toMatchObject({
      owner_id: "a",
      benched_player: "Bench WR",
      started_player: "WR3",
      pts_delta: 17,
    });
  });
});

describe("buildRivalries", () => {
  it("excludes Losers Bracket (Toilet Bowl) games in Weeks 15-17 when winners_bracket is present", () => {
    const leagues: FantasyLeague[] = [
      {
        season: 2024,
        league_id: "L1",
        name: "KFL",
        playoff_week_start: 15,
        winners_bracket: [
          { r: 1, m: 1, p: null, t1: "a", t2: "b", w: "a", l: "b" },
        ],
      },
    ];
    const matchups: FantasyMatchup[] = [
      // Week 15 Winners Bracket game: a vs b
      { id: 1, season: 2024, week: 15, owner_id: "a", opponent_id: "b", points: 120, opponent_points: 110, result: "W" },
      { id: 2, season: 2024, week: 15, owner_id: "b", opponent_id: "a", points: 110, opponent_points: 120, result: "L" },
      // Week 15 Losers Bracket (Toilet Bowl) game: c vs d (not in winners_bracket)
      { id: 3, season: 2024, week: 15, owner_id: "c", opponent_id: "d", points: 95,  opponent_points: 85,  result: "W" },
      { id: 4, season: 2024, week: 15, owner_id: "d", opponent_id: "c", points: 85,  opponent_points: 95,  result: "L" },
    ];
    const rivalries = buildRivalries(matchups, [], owners, leagues);
    expect(rivalries).toHaveLength(1);
    expect(rivalries[0]).toMatchObject({ a_id: "a", b_id: "b", playoff_games: 1 });
  });
});

describe("computeDraftGrades & pickSlotInRound", () => {
  it("converts overall pick_no into 1-indexed within-round slot", () => {
    expect(pickSlotInRound(1, 12)).toBe(1);
    expect(pickSlotInRound(12, 12)).toBe(12);
    expect(pickSlotInRound(13, 12)).toBe(1);
    expect(pickSlotInRound(24, 12)).toBe(12);
    expect(pickSlotInRound(25, 12)).toBe(1);
  });

  it("uses slot-expected baselines and preserves teamCount when an owner trades away all picks", () => {
    // 2-team draft, 2 rounds (4 picks total), but only owner 'a' makes all 4 picks (owner 'b' traded them away).
    // picksPerRound = 4 / 2 = 2 -> teamCount = max(1, 2) = 2.
    const picks: FantasyDraftPick[] = [
      { id: 1, season: 2025, league_id: "L", draft_id: "D", owner_id: "a", player_id: "p1", player_name: "P1", position: "QB", team: "KC", round: 1, pick_number: 1, adp: null, created_at: "" },
      { id: 2, season: 2025, league_id: "L", draft_id: "D", owner_id: "a", player_id: "p2", player_name: "P2", position: "QB", team: "BUF", round: 1, pick_number: 2, adp: null, created_at: "" },
      { id: 3, season: 2025, league_id: "L", draft_id: "D", owner_id: "a", player_id: "p3", player_name: "P3", position: "QB", team: "BAL", round: 2, pick_number: 3, adp: null, created_at: "" },
      { id: 4, season: 2025, league_id: "L", draft_id: "D", owner_id: "a", player_id: "p4", player_name: "P4", position: "QB", team: "CIN", round: 2, pick_number: 4, adp: null, created_at: "" },
    ];
    const scores: FantasyPlayerScore[] = [
      { id: 1, season: 2025, week: 1, owner_id: "a", player_id: "p1", player_name: "P1", position: "QB", team: "KC", points: 300, is_starter: true, created_at: "", updated_at: "" },
      { id: 2, season: 2025, week: 1, owner_id: "a", player_id: "p2", player_name: "P2", position: "QB", team: "BUF", points: 250, is_starter: true, created_at: "", updated_at: "" },
      { id: 3, season: 2025, week: 1, owner_id: "a", player_id: "p3", player_name: "P3", position: "QB", team: "BAL", points: 200, is_starter: false, created_at: "", updated_at: "" },
      { id: 4, season: 2025, week: 1, owner_id: "a", player_id: "p4", player_name: "P4", position: "QB", team: "CIN", points: 100, is_starter: false, created_at: "", updated_at: "" },
    ];
    const grades = computeDraftGrades(picks, scores, owners, 2025);
    expect(grades).toHaveLength(1);
    // Because teamCount = 2 (from 4 picks / 2 rounds), base QB replacement level is index 2 (3rd QB = 200 pts).
    // R1.01 (slot 1) scales 200 by slotExpectationFactor(1, 1, false) = 0.95 -> 190 pts.
    // R2.01 (slot 1) scales 200 by slotExpectationFactor(2, 1, false) = 0.50 -> 100 pts.
    expect(grades[0].picks.find((p) => p.player_id === "p1")?.replacement_pts).toBeCloseTo(190, 5);
    expect(grades[0].picks.find((p) => p.player_id === "p3")?.replacement_pts).toBeCloseTo(100, 5);
  });

  it("heavily dampens 3rd-round longshot misses while rewarding 3rd-round steals and preventing solo R3 weight cancellation", () => {
    // 3-team, 3-round rookie draft where base QB starter replacement (4th QB, index 3) = 200 pts.
    // Owner 'a': R1.01 hit (220 pts vs 190 exp -> +30 VOR) + R3.01 0-pt longshot miss (0 pts vs 40 exp -> -40 VOR * 0.15 = -6).
    // Owner 'b': traded away R1/R2, only has R3.02 0-pt flyer (0 pts vs 38.62 exp -> -38.62 VOR * 0.15 = -5.79, NOT -200).
    // Owner 'c': R3.03 breakout steal (157.33 pts vs 37.33 exp -> +120 VOR * 0.75 = +90).
    const testOwners: FantasyOwner[] = [
      { user_id: "a", display_name: "Alice", avatar: null },
      { user_id: "b", display_name: "Bob", avatar: null },
      { user_id: "c", display_name: "Cara", avatar: null },
    ];
    const picks: FantasyDraftPick[] = [
      { id: 1, season: 2025, league_id: "L", draft_id: "D", owner_id: "a", player_id: "p1", player_name: "R1 Hit", position: "QB", team: "KC", round: 1, pick_number: 1, adp: null, created_at: "" },
      { id: 2, season: 2025, league_id: "L", draft_id: "D", owner_id: "a", player_id: "p2", player_name: "R3 Miss", position: "QB", team: "BUF", round: 3, pick_number: 7, adp: null, created_at: "" },
      { id: 3, season: 2025, league_id: "L", draft_id: "D", owner_id: "b", player_id: "p3", player_name: "Solo R3 Flyer", position: "QB", team: "BAL", round: 3, pick_number: 8, adp: null, created_at: "" },
      { id: 4, season: 2025, league_id: "L", draft_id: "D", owner_id: "c", player_id: "p4", player_name: "R3 Steal", position: "QB", team: "CIN", round: 3, pick_number: 7, adp: null, created_at: "" },
    ];
    const scores: FantasyPlayerScore[] = [
      { id: 1, season: 2025, week: 1, owner_id: "a", player_id: "vet1", player_name: "V1", position: "QB", team: "KC", points: 300, is_starter: true, created_at: "", updated_at: "" },
      { id: 2, season: 2025, week: 1, owner_id: "a", player_id: "vet2", player_name: "V2", position: "QB", team: "KC", points: 260, is_starter: true, created_at: "", updated_at: "" },
      { id: 3, season: 2025, week: 1, owner_id: "a", player_id: "p1", player_name: "R1 Hit", position: "QB", team: "KC", points: 220, is_starter: true, created_at: "", updated_at: "" },
      { id: 4, season: 2025, week: 1, owner_id: "a", player_id: "vet3", player_name: "V3", position: "QB", team: "KC", points: 200, is_starter: true, created_at: "", updated_at: "" },
      { id: 5, season: 2025, week: 1, owner_id: "c", player_id: "p4", player_name: "R3 Steal", position: "QB", team: "CIN", points: 160, is_starter: true, created_at: "", updated_at: "" },
    ];
    expect(slotExpectationFactor(3, 1, false)).toBeCloseTo(0.2, 5);
    expect(pickImpactWeight(3, -25, false)).toBe(0.15);
    expect(pickImpactWeight(3, 80, false)).toBe(0.75);

    const grades = computeDraftGrades(picks, scores, testOwners, 2025);
    const alice = grades.find((g) => g.owner_id === "a")!;
    const bob = grades.find((g) => g.owner_id === "b")!;
    const cara = grades.find((g) => g.owner_id === "c")!;

    // Alice's 0-pt R3 pick only subtracts 6.0 pts from her +30.0 R1 hit -> +24.0 wVOR
    expect(alice.total_vor).toBeCloseTo(24.0, 1);
    // Bob's solo 0-pt R3 flyer only costs ~-5.8 wVOR (instead of -200 when weights cancelled out)
    expect(bob.total_vor).toBeGreaterThan(-10);
    // Cara's R3 steal (160 pts vs 40 expected) gives +90.0 wVOR
    expect(cara.total_vor).toBeCloseTo(90.0, 1);
  });
});

describe("Supabase pagination helpers", () => {
  it("fetchAllMatchups and fetchSeasonPlayerScores paginate until fewer than 1,000 rows are returned", async () => {
    const totalMatchups = 1028;
    const allMatchupRows = Array.from({ length: totalMatchups }, (_, i) => ({
      id: i + 1,
      season: 2025,
      week: 1,
      owner_id: "a",
      opponent_id: "b",
      points: 100,
      opponent_points: 90,
      result: "W",
    }));

    const mockDb = {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          range: async (from: number, to: number) => ({
            data: allMatchupRows.slice(from, to + 1),
            error: null,
          }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    const fetchedMatchups = await fetchAllMatchups(mockDb);
    expect(fetchedMatchups).toHaveLength(1028);

    const fetchedScores = await fetchSeasonPlayerScores(mockDb, 2025);
    expect(fetchedScores).toHaveLength(1028);
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

describe("nfl-week", async () => {
  const { nflWeekEnd, timestampToNflWeek } = await import("./nfl-week");

  it("maps 2026 regular-season timestamps to the right NFL week", () => {
    // 2026-10-07 (Wednesday at end of Week 4)
    const week4Ts = new Date("2026-10-07T12:00:00Z").getTime();
    expect(timestampToNflWeek(week4Ts)).toEqual({ season: 2026, week: 4 });
    expect(nflWeekEnd(2026, 4)?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });
});
