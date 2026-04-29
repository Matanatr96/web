import { describe, it, expect } from "vitest";
import {
  buildStandings,
  buildWeeklyAverages,
  mean,
  stdev,
  percentile,
} from "./fantasy";
import type { FantasyMatchup, FantasyOwner } from "./types";

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
