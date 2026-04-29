import type {
  BlowoutRecord,
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  FantasyStanding,
  FantasyTrade,
  FantasyWeeklyAverage,
  ScoreRecord,
  TradeLeaderboardRow,
} from "./types";

/**
 * Returns true if `week` is part of the regular season for `season`.
 * Regular season = weeks strictly before the league's playoff_week_start.
 * If the league row has no playoff_week_start, falls back to week <= 14.
 */
export function isRegularSeason(
  season: number,
  week: number,
  leagues: FantasyLeague[],
): boolean {
  const league = leagues.find((l) => l.season === season);
  const start = league?.playoff_week_start ?? 15;
  return week < start;
}

/** Filter matchups to regular season only, using each league's playoff_week_start. */
export function regularSeasonOnly(
  matchups: FantasyMatchup[],
  leagues: FantasyLeague[],
): FantasyMatchup[] {
  return matchups.filter((m) => isRegularSeason(m.season, m.week, leagues));
}

/**
 * Build season standings from matchup rows.
 *
 * "Unrealized" record is the all-play record: for each week, how many of the
 * other 11 owners' scores would this owner have beaten? Over a 3-week stretch
 * with 12 teams, that's out of 33 hypothetical games.
 */
export function buildStandings(
  matchups: FantasyMatchup[],
  owners: FantasyOwner[],
  season: number,
): FantasyStanding[] {
  const seasonRows = matchups.filter((m) => m.season === season);
  if (seasonRows.length === 0) return [];

  const ownerById = new Map(owners.map((o) => [o.user_id, o]));

  // Group scores by week so we can compute the all-play record.
  const byWeek = new Map<number, FantasyMatchup[]>();
  for (const m of seasonRows) {
    const list = byWeek.get(m.week) ?? [];
    list.push(m);
    byWeek.set(m.week, list);
  }

  // Aggregate per owner.
  type Acc = {
    wins: number;
    losses: number;
    ties: number;
    unrealized_wins: number;
    unrealized_losses: number;
    points_for: number;
    points_against: number;
    games: number;
  };
  const acc = new Map<string, Acc>();
  const blank = (): Acc => ({
    wins: 0, losses: 0, ties: 0,
    unrealized_wins: 0, unrealized_losses: 0,
    points_for: 0, points_against: 0, games: 0,
  });

  for (const [, weekRows] of byWeek) {
    // For all-play we need every owner's score this week.
    const scores = weekRows.map((r) => ({ owner_id: r.owner_id, points: r.points }));

    for (const m of weekRows) {
      const a = acc.get(m.owner_id) ?? blank();
      a.points_for += m.points;
      a.points_against += m.opponent_points;
      a.games += 1;
      if (m.result === "W") a.wins += 1;
      else if (m.result === "L") a.losses += 1;
      else a.ties += 1;

      // All-play: count opponents with strictly lower score this week.
      // Ties count as half a win each (rare; matches typical sheet behavior).
      let lower = 0;
      let equal = 0;
      for (const s of scores) {
        if (s.owner_id === m.owner_id) continue;
        if (s.points < m.points) lower += 1;
        else if (s.points === m.points) equal += 1;
      }
      const totalOthers = scores.length - 1;
      a.unrealized_wins += lower;
      a.unrealized_losses += totalOthers - lower - equal;
      // Equal scores don't add to either bucket — they're effectively pushes.

      acc.set(m.owner_id, a);
    }
  }

  // League-wide PPG (mean of per-owner avg_ppg).
  const perOwnerAvgPpg: number[] = [];
  for (const [, a] of acc) {
    if (a.games > 0) perOwnerAvgPpg.push(a.points_for / a.games);
  }
  const leagueAvgPpg = perOwnerAvgPpg.length
    ? perOwnerAvgPpg.reduce((s, n) => s + n, 0) / perOwnerAvgPpg.length
    : 0;

  const rows: FantasyStanding[] = [];
  for (const [owner_id, a] of acc) {
    const owner = ownerById.get(owner_id);
    const avg_ppg = a.games > 0 ? a.points_for / a.games : 0;
    const avg_ppga = a.games > 0 ? a.points_against / a.games : 0;
    rows.push({
      owner_id,
      display_name: owner?.display_name ?? owner_id,
      wins: a.wins,
      losses: a.losses,
      ties: a.ties,
      unrealized_wins: a.unrealized_wins,
      unrealized_losses: a.unrealized_losses,
      avg_ppg,
      avg_ppga,
      avg_diff: avg_ppg - avg_ppga,
      ppg_vs_avg: avg_ppg - leagueAvgPpg,
    });
  }

  // Default sort: most wins, then most unrealized wins, then highest PPG.
  rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.unrealized_wins !== a.unrealized_wins) {
      return b.unrealized_wins - a.unrealized_wins;
    }
    return b.avg_ppg - a.avg_ppg;
  });

  return rows;
}

/**
 * League average points per week, across seasons. Returns one row per week
 * number (1..maxWeek), with `null` for season/week pairs not yet played.
 */
export function buildWeeklyAverages(
  matchups: FantasyMatchup[],
  seasons: number[],
  maxWeek = 14,
): FantasyWeeklyAverage[] {
  // Group: season -> week -> total/count
  const tally = new Map<string, { total: number; count: number }>();
  const key = (s: number, w: number) => `${s}:${w}`;

  for (const m of matchups) {
    if (!seasons.includes(m.season)) continue;
    const k = key(m.season, m.week);
    const t = tally.get(k) ?? { total: 0, count: 0 };
    t.total += m.points;
    t.count += 1;
    tally.set(k, t);
  }

  const rows: FantasyWeeklyAverage[] = [];
  for (let week = 1; week <= maxWeek; week++) {
    const averages: Record<number, number | null> = {};
    for (const season of seasons) {
      const t = tally.get(key(season, week));
      averages[season] = t && t.count > 0 ? t.total / t.count : null;
    }
    rows.push({ week, averages });
  }
  return rows;
}

/** Sample mean. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, n) => s + n, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator). */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const sq = values.reduce((s, n) => s + (n - m) ** 2, 0);
  return Math.sqrt(sq / (values.length - 1));
}

export function zScore(value: number, values: number[]): number {
  const sd = stdev(values);
  if (sd === 0) return 0;
  return (value - mean(values)) / sd;
}

/** Percentile (0–100) of `value` within `values`, using <= count / n. */
export function percentile(value: number, values: number[]): number {
  if (values.length === 0) return 0;
  const below = values.filter((v) => v <= value).length;
  return (below / values.length) * 100;
}

function nameFor(owners: FantasyOwner[], userId: string | null): string {
  if (!userId) return "—";
  return owners.find((o) => o.user_id === userId)?.display_name ?? userId;
}

/**
 * Top N single-game scores across all matchups passed in.
 * Pass already-filtered (e.g. regular-season) matchups for season-specific records.
 */
export function topScoringRecords(
  matchups: FantasyMatchup[],
  owners: FantasyOwner[],
  limit = 10,
): ScoreRecord[] {
  return [...matchups]
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((m) => ({
      season: m.season,
      week: m.week,
      owner_id: m.owner_id,
      display_name: nameFor(owners, m.owner_id),
      points: m.points,
    }));
}

/** Bottom N single-game scores. Excludes 0-point rows (likely unplayed weeks). */
export function lowestScoringRecords(
  matchups: FantasyMatchup[],
  owners: FantasyOwner[],
  limit = 10,
): ScoreRecord[] {
  return [...matchups]
    .filter((m) => m.points > 0)
    .sort((a, b) => a.points - b.points)
    .slice(0, limit)
    .map((m) => ({
      season: m.season,
      week: m.week,
      owner_id: m.owner_id,
      display_name: nameFor(owners, m.owner_id),
      points: m.points,
    }));
}

/**
 * Largest single-game point differentials (winner perspective).
 * Each head-to-head appears once (we only emit the winning side).
 */
export function biggestBlowouts(
  matchups: FantasyMatchup[],
  owners: FantasyOwner[],
  limit = 10,
): BlowoutRecord[] {
  return matchups
    .filter((m) => m.result === "W" && m.opponent_id != null)
    .map((m) => ({
      season: m.season,
      week: m.week,
      owner_id: m.owner_id,
      display_name: nameFor(owners, m.owner_id),
      points: m.points,
      opponent_id: m.opponent_id as string,
      opponent_name: nameFor(owners, m.opponent_id),
      differential: m.points - m.opponent_points,
    }))
    .sort((a, b) => b.differential - a.differential)
    .slice(0, limit);
}

/**
 * Trade count per owner across all trades passed in. Owners that have never
 * traded are still included (count = 0) so the leaderboard shows everyone.
 */
export function buildTradeLeaderboard(
  trades: FantasyTrade[],
  owners: FantasyOwner[],
): TradeLeaderboardRow[] {
  const counts = new Map<string, number>();
  for (const o of owners) counts.set(o.user_id, 0);
  for (const t of trades) {
    for (const uid of t.user_ids) {
      counts.set(uid, (counts.get(uid) ?? 0) + 1);
    }
  }
  const rows: TradeLeaderboardRow[] = [];
  for (const [user_id, trade_count] of counts) {
    const owner = owners.find((o) => o.user_id === user_id);
    rows.push({
      owner_id: user_id,
      display_name: owner?.display_name ?? user_id,
      trade_count,
    });
  }
  rows.sort((a, b) => b.trade_count - a.trade_count || a.display_name.localeCompare(b.display_name));
  return rows;
}
