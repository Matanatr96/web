import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BlowoutRecord,
  BracketEntry,
  DraftGradeRow,
  DraftPickGrade,
  FantasyDraftPick,
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  FantasyPlayerScore,
  FantasyStanding,
  FantasyTrade,
  FantasyWeeklyAverage,
  HallOfFameEntry,
  LegacyScoreBreakdown,
  LegacyScoreMode,
  Rivalry,
  RivalryGame,
  ScoreRecord,
  ScheduleLotteryResult,
  SeasonFinishSummary,
  TradeLeaderboardRow,
  WeeklyStats,
} from "./types";

const SUPABASE_PAGE_SIZE = 1000;

/**
 * Fetches all rows from `fantasy_matchups` across all seasons using deterministic
 * range pagination so PostgREST's 1,000-row per-request limit never truncates
 * multi-season matchup history.
 *
 * @param db - Supabase client instance.
 * @returns Complete list of `FantasyMatchup` rows across all seasons.
 */
export async function fetchAllMatchups(db: SupabaseClient): Promise<FantasyMatchup[]> {
  const all: FantasyMatchup[] = [];
  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const { data, error } = await db
      .from("fantasy_matchups")
      .select("*")
      .order("season", { ascending: false })
      .order("week", { ascending: true })
      .order("owner_id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as FantasyMatchup[];
    all.push(...rows);
    if (rows.length < SUPABASE_PAGE_SIZE) break;
  }
  return all;
}

/**
 * Fetches all rows from `fantasy_player_scores` for a given `season` using
 * deterministic range pagination so full-season player score tables (~3,400+
 * rows per season) are never truncated at 1,000 rows by PostgREST.
 *
 * @param db - Supabase client instance.
 * @param season - Four-digit NFL season year (e.g., 2025).
 * @returns Complete list of `FantasyPlayerScore` rows for the requested season.
 */
export async function fetchSeasonPlayerScores(
  db: SupabaseClient,
  season: number,
): Promise<FantasyPlayerScore[]> {
  const all: FantasyPlayerScore[] = [];
  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const { data, error } = await db
      .from("fantasy_player_scores")
      .select("*")
      .eq("season", season)
      .order("week", { ascending: true })
      .order("owner_id", { ascending: true })
      .order("player_id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as FantasyPlayerScore[];
    all.push(...rows);
    if (rows.length < SUPABASE_PAGE_SIZE) break;
  }
  return all;
}

const OWNER_COLORS = [
  "text-sky-600 dark:text-sky-400",
  "text-violet-600 dark:text-violet-400",
  "text-amber-600 dark:text-amber-400",
  "text-rose-600 dark:text-rose-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-orange-600 dark:text-orange-400",
  "text-pink-600 dark:text-pink-400",
  "text-teal-600 dark:text-teal-400",
];

/** Returns a map of user_id → Tailwind color class, stable across pages. */
export function ownerColorMap(owners: FantasyOwner[]): Map<string, string> {
  const sorted = [...owners].sort((a, b) => a.display_name.localeCompare(b.display_name));
  return new Map(sorted.map((o, i) => [o.user_id, OWNER_COLORS[i % OWNER_COLORS.length]]));
}

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
    // Skip unplayed all-zero weeks if any exist.
    if (weekRows.every((r) => r.points === 0 && r.opponent_points === 0)) continue;

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

  // Sort matching Sleeper standings: win-tie record desc, then PPG (points for) desc, then all-play wins desc.
  rows.sort((a, b) => {
    const aWinScore = a.wins + a.ties * 0.5;
    const bWinScore = b.wins + b.ties * 0.5;
    if (bWinScore !== aWinScore) return bWinScore - aWinScore;
    if (b.avg_ppg !== a.avg_ppg) return b.avg_ppg - a.avg_ppg;
    return b.unrealized_wins - a.unrealized_wins;
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
 * Schedule Lottery: for each owner, simulate their record under every other
 * owner's schedule of opponents for the given season.
 *
 * Algorithm:
 *   - For each week W, we have a set of (owner, score) pairs and a set of
 *     (schedule_owner → opponent) assignments.
 *   - Owner A "playing" schedule B's week W means A's actual score is compared
 *     against B's actual opponent's actual score that week.
 *   - Returns an NxN matrix plus a luck-delta leaderboard.
 */
export function computeScheduleLottery(
  matchups: FantasyMatchup[],
  owners: FantasyOwner[],
  leagues: FantasyLeague[],
  season: number,
): ScheduleLotteryResult {
  const seasonRows = regularSeasonOnly(
    matchups.filter((m) => m.season === season),
    leagues,
  );

  // Collect the owners who actually played this season.
  const ownerIds = [...new Set(seasonRows.map((m) => m.owner_id))].sort();
  const seasonOwners = ownerIds
    .map((id) => owners.find((o) => o.user_id === id))
    .filter((o): o is FantasyOwner => o != null);
  const n = seasonOwners.length;

  // Group matchups by week.
  const weeks = [...new Set(seasonRows.map((m) => m.week))].sort((a, b) => a - b);

  // matrix[ownerIdx][scheduleIdx] = { wins, losses, ties }
  const matrix: { wins: number; losses: number; ties: number }[][] = Array.from(
    { length: n },
    () => Array.from({ length: n }, () => ({ wins: 0, losses: 0, ties: 0 })),
  );

  for (const week of weeks) {
    const weekRows = seasonRows.filter((m) => m.week === week);

    // score[owner_id] = their actual points this week
    const score = new Map(weekRows.map((m) => [m.owner_id, m.points]));
    // opponentId[owner_id] = their actual opponent's user_id this week
    const opponentId = new Map(weekRows.map((m) => [m.owner_id, m.opponent_id]));
    // opponentScore[owner_id] = their actual opponent's points this week
    const opponentScore = new Map(weekRows.map((m) => [m.owner_id, m.opponent_points]));

    for (let oi = 0; oi < n; oi++) {
      const myId = seasonOwners[oi].user_id;
      const myScore = score.get(myId);
      if (myScore == null) continue;

      for (let si = 0; si < n; si++) {
        // Owner oi playing schedule-owner si's schedule: face si's actual opponent.
        // If si's actual opponent this week WAS oi (they played each other head-to-head),
        // swapping schedules means oi takes si's place in that game and faces si.
        const schedOwner = seasonOwners[si];
        const schedOpponentId = opponentId.get(schedOwner.user_id);
        const theirOpponentScore =
          schedOpponentId === myId
            ? score.get(schedOwner.user_id)
            : opponentScore.get(schedOwner.user_id);
        if (theirOpponentScore == null) continue;

        const cell = matrix[oi][si];
        if (myScore > theirOpponentScore) cell.wins += 1;
        else if (myScore < theirOpponentScore) cell.losses += 1;
        else cell.ties += 1;
      }
    }
  }

  // Luck delta: actual wins (diagonal) vs median across all N schedules.
  const winValue = (c: { wins: number; losses: number; ties: number }) =>
    c.wins + c.ties * 0.5;
  const luckDeltas = seasonOwners.map((owner, oi) => {
    const actual_wins = winValue(matrix[oi][oi]);
    const allWins = matrix[oi].map(winValue).sort((a, b) => a - b);
    const mid = Math.floor(allWins.length / 2);
    const median_wins =
      allWins.length % 2 === 0
        ? (allWins[mid - 1] + allWins[mid]) / 2
        : allWins[mid];
    return {
      owner_id: owner.user_id,
      display_name: owner.display_name,
      actual_wins,
      median_wins,
      delta: actual_wins - median_wins,
    };
  });

  luckDeltas.sort((a, b) => b.delta - a.delta);

  return { owners: seasonOwners, matrix, luckDeltas };
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

// FLEX-eligible positions that can be benched and compared cross-slot.
const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);
// Mandatory positional starter minimums in KFL (1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX).
const MIN_STARTERS_BY_POSITION: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
};

/**
 * Compute weekly stats for a given season+week from matchup and player score data.
 * Returns null if there are no matchups for that week.
 */
export function computeWeeklyStats(
  matchups: FantasyMatchup[],
  playerScores: FantasyPlayerScore[],
  owners: FantasyOwner[],
  season: number,
  week: number,
): WeeklyStats | null {
  const weekMatchups = matchups.filter(
    (m) => m.season === season && m.week === week && m.points > 0,
  );
  if (weekMatchups.length === 0) return null;

  const ownerName = (id: string) =>
    owners.find((o) => o.user_id === id)?.display_name ?? id;

  // Deduplicate to one row per owner (matchups has two rows per game).
  const byOwner = new Map<string, FantasyMatchup>();
  for (const m of weekMatchups) {
    if (!byOwner.has(m.owner_id)) byOwner.set(m.owner_id, m);
  }
  const ownerRows = [...byOwner.values()];

  const sorted = [...ownerRows].sort((a, b) => b.points - a.points);
  const highest_scorer = {
    owner_id: sorted[0].owner_id,
    display_name: ownerName(sorted[0].owner_id),
    points: sorted[0].points,
  };
  const lowest_scorer = {
    owner_id: sorted[sorted.length - 1].owner_id,
    display_name: ownerName(sorted[sorted.length - 1].owner_id),
    points: sorted[sorted.length - 1].points,
  };

  // Deduplicate head-to-head games (keep W rows and one row per T game) for blowout / closest.
  const seenPairs = new Set<string>();
  const gameRows: FantasyMatchup[] = [];
  for (const m of weekMatchups) {
    if (m.opponent_id == null) continue;
    if (m.result !== "W" && m.result !== "T") continue;
    const pk = pairKey(m.owner_id, m.opponent_id);
    if (seenPairs.has(pk)) continue;
    seenPairs.add(pk);
    gameRows.push(m);
  }
  const withMargin = gameRows.map((m) => ({
    winner_id: m.owner_id,
    winner_name: ownerName(m.owner_id),
    loser_id: m.opponent_id as string,
    loser_name: ownerName(m.opponent_id as string),
    margin: Math.abs(m.points - m.opponent_points),
    winner_points: m.points,
    loser_points: m.opponent_points,
  }));
  withMargin.sort((a, b) => b.margin - a.margin);
  const biggest_blowout = withMargin[0] ?? null;
  const closest_matchup = withMargin[withMargin.length - 1] ?? null;

  // Biggest bench mistake: max(bench_pts - legal_starter_pts) across all owners.
  const weekScores = playerScores.filter((p) => p.season === season && p.week === week);
  let bench_mistake = null;
  let maxDelta = -Infinity;

  for (const [ownerId] of byOwner) {
    const ownerScores = weekScores.filter((p) => p.owner_id === ownerId);
    const starters = ownerScores.filter((p) => p.is_starter);
    const bench = ownerScores.filter((p) => !p.is_starter && p.points > 0);

    // Count how many starters the owner started at each position so we only allow
    // cross-position FLEX swaps when the starter's position exceeds its mandatory
    // minimum (meaning at least one starter of that position occupies a FLEX slot).
    const starterCountByPos = new Map<string, number>();
    for (const s of starters) {
      if (s.position) {
        starterCountByPos.set(s.position, (starterCountByPos.get(s.position) ?? 0) + 1);
      }
    }

    for (const benchPlayer of bench) {
      const pos = benchPlayer.position;
      // Find starters the bench player could legally have replaced.
      const eligible = starters.filter((s) => {
        if (!pos || !s.position) return false;
        if (s.position === pos) return true;
        if (FLEX_POSITIONS.has(pos) && FLEX_POSITIONS.has(s.position)) {
          const minRequired = MIN_STARTERS_BY_POSITION[s.position] ?? 1;
          return (starterCountByPos.get(s.position) ?? 0) > minRequired;
        }
        return false;
      });
      if (eligible.length === 0) continue;

      // Compare against the worst-performing eligible starter.
      const worstStarter = eligible.reduce((a, b) => (a.points < b.points ? a : b));
      const delta = benchPlayer.points - worstStarter.points;
      if (delta > maxDelta) {
        maxDelta = delta;
        const ownerMatchup = byOwner.get(ownerId);
        bench_mistake = {
          owner_id: ownerId,
          display_name: ownerName(ownerId),
          benched_player: benchPlayer.player_name,
          benched_player_pts: benchPlayer.points,
          started_player: worstStarter.player_name,
          started_player_pts: worstStarter.points,
          position: pos,
          pts_delta: delta,
          won_matchup: ownerMatchup?.result === "W",
        };
      }
    }
  }

  return {
    season,
    week,
    highest_scorer,
    lowest_scorer,
    biggest_blowout,
    closest_matchup,
    bench_mistake,
  };
}

// Margin at-or-below which a game counts as "close" for rivalry heat.
const RIVALRY_CLOSE_MARGIN = 10;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build pairwise H2H dossiers for every owner pair that has played at least one
 * game (regular season or playoff). Includes a composite rivalry "heat" score
 * combining games played, close-game count, playoff stakes, trade entanglement,
 * and record balance.
 */
export function buildRivalries(
  matchups: FantasyMatchup[],
  trades: FantasyTrade[],
  owners: FantasyOwner[],
  leagues: FantasyLeague[],
): Rivalry[] {
  // Build lookup of verified Winners Bracket playoff matchups per season so
  // Losers Bracket (Toilet Bowl) consolation games in Weeks 15–17 are excluded.
  const winnersBracketPairsBySeason = new Map<number, Set<string>>();
  for (const l of leagues) {
    if (!l.winners_bracket || l.winners_bracket.length === 0) continue;
    const playoffStart = l.playoff_week_start ?? 15;
    const pairs = new Set<string>();
    for (const b of l.winners_bracket) {
      if (b.t1 && b.t2) {
        const week = playoffStart + (b.r - 1);
        pairs.add(`${week}|${pairKey(b.t1, b.t2)}`);
      }
    }
    winnersBracketPairsBySeason.set(l.season, pairs);
  }

  // Dedupe matchups: each game appears twice (once per owner). Keep one row
  // per (season, week, canonical-pair-key), with A = lexicographically smaller
  // user_id so the perspective is stable across the dataset.
  type DedupedGame = RivalryGame & { a_id: string; b_id: string };
  const seen = new Map<string, DedupedGame>();
  for (const m of matchups) {
    if (m.opponent_id == null) continue;
    const pk = pairKey(m.owner_id, m.opponent_id);
    const key = `${m.season}|${m.week}|${pk}`;
    if (seen.has(key)) continue;

    const reg = isRegularSeason(m.season, m.week, leagues);
    let is_playoff = !reg;
    if (!reg) {
      const wbSet = winnersBracketPairsBySeason.get(m.season);
      if (wbSet) {
        // When winners_bracket is populated for this season, skip Losers Bracket
        // (Toilet Bowl) games altogether so meaningless consolation games don't
        // distort H2H records or get a 3x playoff heat multiplier.
        if (!wbSet.has(`${m.week}|${pk}`)) continue;
        is_playoff = true;
      }
    }

    const aIsOwner = m.owner_id < m.opponent_id;
    const a_id = aIsOwner ? m.owner_id : m.opponent_id;
    const b_id = aIsOwner ? m.opponent_id : m.owner_id;
    const a_points = aIsOwner ? m.points : m.opponent_points;
    const b_points = aIsOwner ? m.opponent_points : m.points;
    const winner: "A" | "B" | "T" =
      a_points > b_points ? "A" : a_points < b_points ? "B" : "T";
    seen.set(key, {
      a_id,
      b_id,
      season: m.season,
      week: m.week,
      is_playoff,
      a_points,
      b_points,
      winner,
    });
  }

  // Count trades per canonical pair. A multi-party trade contributes one count
  // per participating pair.
  const tradeCounts = new Map<string, number>();
  for (const t of trades) {
    const ids = [...new Set(t.user_ids)];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = pairKey(ids[i], ids[j]);
        tradeCounts.set(k, (tradeCounts.get(k) ?? 0) + 1);
      }
    }
  }

  // Group deduped games by canonical pair key.
  const grouped = new Map<string, DedupedGame[]>();
  for (const g of seen.values()) {
    const k = pairKey(g.a_id, g.b_id);
    const arr = grouped.get(k);
    if (arr) arr.push(g);
    else grouped.set(k, [g]);
  }

  const ownerById = new Map(owners.map((o) => [o.user_id, o.display_name]));

  const rivalries: Rivalry[] = [];
  for (const [k, gamesRaw] of grouped) {
    const games = gamesRaw.sort(
      (x, y) => x.season - y.season || x.week - y.week,
    );
    const first = games[0];
    const { a_id, b_id } = first;

    let a_wins = 0;
    let b_wins = 0;
    let ties = 0;
    let a_total_points = 0;
    let b_total_points = 0;
    let close_games = 0;
    let playoff_games = 0;
    let biggest: DedupedGame | null = null;
    let biggestMargin = -1;
    let closest: DedupedGame | null = null;
    let closestMargin = Number.POSITIVE_INFINITY;

    for (const g of games) {
      if (g.winner === "A") a_wins += 1;
      else if (g.winner === "B") b_wins += 1;
      else ties += 1;
      a_total_points += g.a_points;
      b_total_points += g.b_points;
      const margin = Math.abs(g.a_points - g.b_points);
      if (margin <= RIVALRY_CLOSE_MARGIN) close_games += 1;
      if (g.is_playoff) playoff_games += 1;
      if (margin > biggestMargin) {
        biggestMargin = margin;
        biggest = g;
      }
      if (margin < closestMargin) {
        closestMargin = margin;
        closest = g;
      }
    }

    const games_played = games.length;
    const avg_margin = (a_total_points - b_total_points) / games_played;
    const trades_exchanged = tradeCounts.get(k) ?? 0;

    // Heat score: weighted sum, scaled down for lopsided records so that a
    // pair where one side dominates feels less heated than an even matchup.
    const decisive = a_wins + b_wins;
    const win_pct_a = decisive > 0 ? a_wins / decisive : 0.5;
    const balance = 1 - Math.abs(win_pct_a - 0.5) * 0.8; // 0.6 (lopsided) → 1.0 (even)
    const rivalry_score =
      (games_played + close_games * 2 + playoff_games * 3 + trades_exchanged * 1.5) *
      balance;

    const toGame = (g: DedupedGame | null): RivalryGame | null =>
      g == null
        ? null
        : {
            season: g.season,
            week: g.week,
            is_playoff: g.is_playoff,
            a_points: g.a_points,
            b_points: g.b_points,
            winner: g.winner,
          };

    rivalries.push({
      a_id,
      a_name: ownerById.get(a_id) ?? a_id,
      b_id,
      b_name: ownerById.get(b_id) ?? b_id,
      games_played,
      a_wins,
      b_wins,
      ties,
      avg_margin,
      a_total_points,
      b_total_points,
      close_games,
      playoff_games,
      trades_exchanged,
      biggest_blowout: toGame(biggest),
      closest_game: toGame(closest),
      games: games.map((g) => ({
        season: g.season,
        week: g.week,
        is_playoff: g.is_playoff,
        a_points: g.a_points,
        b_points: g.b_points,
        winner: g.winner,
      })),
      rivalry_score,
    });
  }

  rivalries.sort(
    (x, y) =>
      y.rivalry_score - x.rivalry_score ||
      y.games_played - x.games_played ||
      x.a_name.localeCompare(y.a_name),
  );
  return rivalries;
}

/** Find a rivalry by either ordering of owner ids. */
export function findRivalry(rivalries: Rivalry[], idA: string, idB: string): Rivalry | null {
  const k = pairKey(idA, idB);
  return rivalries.find((r) => pairKey(r.a_id, r.b_id) === k) ?? null;
}

const GRADED_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
// Number of starters per position per team (12-team standard scoring).
const STARTERS_PER_TEAM: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1 };

/**
 * Converts a 1-indexed overall `pickNumber` (Sleeper `pick_no`) into its
 * 1-indexed within-round slot (`1..teamCount`).
 *
 * @param pickNumber - 1-indexed overall pick number from Sleeper (`pick_no`).
 * @param teamCount - Number of teams in each draft round (defaults to 12).
 * @returns 1-indexed slot within the round (`1..teamCount`).
 */
export function pickSlotInRound(pickNumber: number, teamCount = 12): number {
  if (teamCount <= 0) return pickNumber;
  return ((pickNumber - 1) % teamCount) + 1;
}

/**
 * Computes the expected points multiplier (relative to the league-wide positional
 * starter replacement level `QB12 / RB24 / WR24 / TE12`) for a given draft `round`
 * and 1-indexed within-round `slot`.
 *
 * - For rookie drafts (`isStartupDraft === false`, `<= 5` rounds):
 *   - Round 1: `0.95 * exp(-0.035 * (slot - 1))` (`95%` at `1.01` down to `65%` at `1.12`)
 *   - Round 2: `0.425 * exp(-0.035 * (slot - 1))` (`42.5%` at `2.01` down to `29%` at `2.12`)
 *   - Round 3+: `0.05 * exp(-0.035 * (slot - 1))` (`5%` at `3.01` down to `3.4%` at `3.12`)
 * - For multi-round startup drafts (`isStartupDraft === true`, `> 5` rounds):
 *   - Smooth decay across rounds and slots floored at `5%` of starter replacement.
 *
 * @param round - 1-indexed draft round.
 * @param slot - 1-indexed slot within the round (`1..teamCount`).
 * @param isStartupDraft - Whether the draft is a full-roster startup draft (`> 5` rounds).
 * @returns Multiplier in `(0, 1]` applied to positional starter replacement points.
 */
export function slotExpectationFactor(
  round: number,
  slot: number,
  isStartupDraft = false,
): number {
  if (isStartupDraft) {
    return Math.max(0.05, Math.exp(-0.16 * (round - 1)) * Math.exp(-0.012 * (slot - 1)));
  }
  const roundBase = round === 1 ? 0.95 : round === 2 ? 0.425 : 0.05;
  const slotDecay = Math.exp(-0.035 * (slot - 1));
  return roundBase * slotDecay;
}

/**
 * Returns the asymmetric impact weight applied to a pick's slot-adjusted `vor`
 * when aggregating a manager's overall draft score (`total_vor`).
 *
 * Late-round picks (Round 3+ in rookie drafts, Round 11+ in startup drafts) are
 * longshot lottery tickets: missing on them applies heavily damped downside (`0.15x`),
 * while hitting a breakout sleeper retains strong upside (`0.75x`).
 *
 * @param round - 1-indexed draft round.
 * @param vor - Pick's points minus slot-expected points (`season_pts - replacement_pts`).
 * @param isStartupDraft - Whether the draft is a full-roster startup draft (`> 5` rounds).
 * @returns Non-negative weight multiplier for the pick's `vor`.
 */
export function pickImpactWeight(
  round: number,
  vor: number,
  isStartupDraft = false,
): number {
  if (vor >= 0) {
    if (isStartupDraft) return round <= 8 ? 1.0 : 0.65;
    return round === 1 ? 1.0 : round === 2 ? 0.85 : 0.75;
  }
  if (isStartupDraft) {
    return round <= 6 ? 1.0 : round <= 10 ? 0.5 : 0.15;
  }
  return round === 1 ? 1.0 : round === 2 ? 0.45 : 0.15;
}

/**
 * Compute slot-adjusted VOR draft grades for each owner in a season.
 *
 * Each pick is benchmarked against the expected points for its round and slot
 * (`positional_starter_replacement_pts × slotExpectationFactor`), and weighted
 * with asymmetric downside damping (`pickImpactWeight`) so 3rd-round longshots
 * don't heavily penalize managers when they miss while still rewarding late-round steals.
 *
 * Only QB/RB/WR/TE picks are graded; K and DEF are excluded.
 * Player season totals are derived by summing across all rosters (trades don't
 * affect the grade — we care about whether you *identified* the talent).
 */
export function computeDraftGrades(
  picks: FantasyDraftPick[],
  playerScores: FantasyPlayerScore[],
  owners: FantasyOwner[],
  season: number,
): DraftGradeRow[] {
  const seasonPicks = picks.filter((p) => p.season === season);
  if (seasonPicks.length === 0) return [];

  const uniquePickOwners = new Set(seasonPicks.map((p) => p.owner_id)).size;
  const maxRound = Math.max(0, ...seasonPicks.map((p) => p.round));
  const picksPerRound = maxRound > 0 ? Math.round(seasonPicks.length / maxRound) : 0;
  const teamCount = Math.max(uniquePickOwners, picksPerRound);
  const isStartupDraft = maxRound > 5;

  // Aggregate season total per player across all rosters.
  const playerTotals = new Map<string, number>();
  for (const ps of playerScores) {
    if (ps.season !== season) continue;
    playerTotals.set(ps.player_id, (playerTotals.get(ps.player_id) ?? 0) + ps.points);
  }

  // Derive each player's position: prefer pick metadata, fall back to player_scores.
  const playerPosition = new Map<string, string>();
  for (const pick of seasonPicks) {
    if (pick.position) playerPosition.set(pick.player_id, pick.position);
  }
  for (const ps of playerScores) {
    if (ps.season === season && ps.position && !playerPosition.has(ps.player_id)) {
      playerPosition.set(ps.player_id, ps.position);
    }
  }

  // Build sorted points list per position from every player who scored >0.
  const positionPts = new Map<string, number[]>();
  for (const [playerId, pts] of playerTotals) {
    const pos = playerPosition.get(playerId);
    if (!pos || !GRADED_POSITIONS.has(pos)) continue;
    const arr = positionPts.get(pos) ?? [];
    arr.push(pts);
    positionPts.set(pos, arr);
  }

  // Base starter replacement level = points of the (N+1)th player sorted descending (0-indexed at N).
  const replacementLevel = new Map<string, number>();
  for (const pos of GRADED_POSITIONS) {
    const n = (STARTERS_PER_TEAM[pos] ?? 1) * teamCount;
    const sorted = (positionPts.get(pos) ?? []).sort((a, b) => b - a);
    replacementLevel.set(pos, sorted[n] ?? sorted[sorted.length - 1] ?? 0);
  }

  // Grade each pick against its round-and-slot expected baseline and apply asymmetric impact weight.
  type InternalPick = DraftPickGrade & { owner_id: string };
  const pickGrades: InternalPick[] = [];
  for (const pick of seasonPicks) {
    const pos = pick.position;
    if (!pos || !GRADED_POSITIONS.has(pos)) continue;
    const season_pts = playerTotals.get(pick.player_id) ?? 0;
    const baseReplacementPts = replacementLevel.get(pos) ?? 0;
    const slot = pickSlotInRound(pick.pick_number, teamCount);
    const replacement_pts =
      baseReplacementPts * slotExpectationFactor(pick.round, slot, isStartupDraft);
    const rawVor = season_pts - replacement_pts;
    const vor = rawVor * pickImpactWeight(pick.round, rawVor, isStartupDraft);
    pickGrades.push({
      owner_id: pick.owner_id,
      player_id: pick.player_id,
      player_name: pick.player_name,
      position: pos,
      round: pick.round,
      pick_number: pick.pick_number,
      season_pts,
      replacement_pts,
      vor,
    });
  }

  // Group by owner and sum weighted slot-adjusted VOR.
  const ownerById = new Map(owners.map((o) => [o.user_id, o]));
  const ownerPickMap = new Map<string, InternalPick[]>();
  for (const pg of pickGrades) {
    const arr = ownerPickMap.get(pg.owner_id) ?? [];
    arr.push(pg);
    ownerPickMap.set(pg.owner_id, arr);
  }

  const rows: DraftGradeRow[] = [];
  for (const [owner_id, ownerPicks] of ownerPickMap) {
    const total_vor = ownerPicks.reduce((s, p) => s + p.vor, 0);
    ownerPicks.sort((a, b) => b.vor - a.vor); // steals at top, busts at bottom
    rows.push({
      owner_id,
      display_name: ownerById.get(owner_id)?.display_name ?? owner_id,
      total_vor,
      letter_grade: "",
      picks: ownerPicks.map(({ owner_id: _oid, ...p }) => p),
    });
  }

  rows.sort((a, b) => b.total_vor - a.total_vor);

  // Letter grade by percentile rank (0 = best, 1 = worst).
  const n = rows.length;
  rows.forEach((row, i) => {
    const pct = n > 1 ? i / (n - 1) : 0;
    if (pct <= 0.15) row.letter_grade = "A";
    else if (pct <= 0.40) row.letter_grade = "B";
    else if (pct <= 0.60) row.letter_grade = "C";
    else if (pct <= 0.85) row.letter_grade = "D";
    else row.letter_grade = "F";
  });

  return rows;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Assigns a signature Hall of Fame archetype badge to a manager based on their
 * career hardware, rank, scoring dominance, and schedule luck profile.
 *
 * @param entry - Manager's aggregated Hall of Fame entry.
 * @param rank - 1-indexed rank on the Hall of Fame leaderboard.
 * @param totalManagers - Total number of ranked managers in the league.
 * @param maxWins - Highest regular-season win count across all managers.
 * @param maxPpg - Highest career PPG across all managers.
 * @returns Uppercase archetype badge string (e.g. `"THE DYNASTY"`, `"THE LEAGUE'S WORST"`).
 */
export function assignManagerArchetype(
  entry: HallOfFameEntry,
  rank: number,
  totalManagers: number,
  maxWins: number,
  maxPpg: number,
): string {
  if (totalManagers >= 4 && rank === totalManagers && entry.firsts === 0) {
    return "THE LEAGUE'S WORST";
  }
  if (entry.firsts >= 2 && entry.lasts === 0) {
    return "THE DYNASTY";
  }
  if (entry.firsts >= 2 && entry.lasts >= 1) {
    return "BOOM OR BUST";
  }
  if (entry.firsts >= 1 && entry.win_pct < 0.5) {
    return "GIANT SLAYER";
  }
  if (entry.firsts >= 1) {
    return "TITLE CONTENDER";
  }
  if (entry.wins === maxWins && entry.seconds >= 1) {
    return "REGULAR SEASON KING";
  }
  if (Math.abs(entry.avg_ppg - maxPpg) < 0.01) {
    return "SCORING MACHINE";
  }
  if (entry.seconds >= 2) {
    return "ALWAYS THE BRIDESMAID";
  }
  if (entry.thirds >= 2) {
    return "BRONZE MEDALIST";
  }
  if (entry.completed_seasons >= 3 && entry.playoff_appearances === 0) {
    return "PLAYOFF DROUGHT";
  }
  if (entry.win_pct - entry.all_play_pct >= 0.08) {
    return "SCHEDULE BANDIT";
  }
  if (entry.all_play_pct - entry.win_pct >= 0.03) {
    return "UNLUCKY GRINDER";
  }
  if (entry.seconds === 1 && entry.win_pct < 0.5) {
    return "CINDERELLA RUNNER-UP";
  }
  if (entry.playoff_appearances >= Math.ceil(entry.completed_seasons * 0.6)) {
    return "PERENNIAL CONTENDER";
  }
  return "THE GATEKEEPER";
}

/**
 * Computes the all-time KFL Hall of Fame leaderboard, hardware counts (`1st`, `2nd`,
 * `3rd`, `Last`), 5-pillar Legacy Scores (`0.0–100.0`), season-by-season finish
 * summaries, and manager archetype badges across all synced seasons.
 *
 * Completed seasons are identified by a `winners_bracket` Championship entry
 * (`p === 1`) having a non-null winner (`w != null`), ensuring an in-progress
 * season contributes regular-season wins/PPG without prematurely awarding hardware
 * or a last-place penalty.
 *
 * @param matchups - All matchup rows across all seasons (`fetchAllMatchups`).
 * @param owners - All league owners from `fantasy_owners`.
 * @param leagues - All league metadata rows from `fantasy_leagues`.
 * @param mode - Weighting preset (`"balanced"` default, `"rings"`, or `"dominance"`).
 * @returns Ranked array of `HallOfFameEntry` objects sorted by Legacy Score descending.
 */
export function computeHallOfFame(
  matchups: FantasyMatchup[],
  owners: FantasyOwner[],
  leagues: FantasyLeague[],
  mode: LegacyScoreMode = "balanced",
): HallOfFameEntry[] {
  const regSeasonAll = regularSeasonOnly(matchups, leagues);
  const sortedLeagues = [...leagues].sort((a, b) => a.season - b.season);
  const ownerById = new Map(owners.map((o) => [o.user_id, o]));

  type Acc = {
    owner_id: string;
    seasons_played: number;
    completed_seasons: number;
    wins: number;
    losses: number;
    ties: number;
    games: number;
    points_for: number;
    unrealized_wins: number;
    unrealized_losses: number;
    firsts: number;
    seconds: number;
    thirds: number;
    lasts: number;
    reg_season_firsts: number;
    playoff_appearances: number;
    playoff_wins: number;
    season_finishes: SeasonFinishSummary[];
  };

  const accMap = new Map<string, Acc>();
  const ensureAcc = (ownerId: string): Acc => {
    const existing = accMap.get(ownerId);
    if (existing) return existing;
    const created: Acc = {
      owner_id: ownerId,
      seasons_played: 0,
      completed_seasons: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      games: 0,
      points_for: 0,
      unrealized_wins: 0,
      unrealized_losses: 0,
      firsts: 0,
      seconds: 0,
      thirds: 0,
      lasts: 0,
      reg_season_firsts: 0,
      playoff_appearances: 0,
      playoff_wins: 0,
      season_finishes: [],
    };
    accMap.set(ownerId, created);
    return created;
  };

  for (const league of sortedLeagues) {
    const season = league.season;
    const standings = buildStandings(regSeasonAll, owners, season);
    if (standings.length === 0) continue;

    const seasonRegRows = regSeasonAll.filter((m) => m.season === season);
    const gamesByOwner = new Map<string, { games: number; pf: number }>();
    for (const m of seasonRegRows) {
      if (m.points === 0 && m.opponent_points === 0) continue;
      const g = gamesByOwner.get(m.owner_id) ?? { games: 0, pf: 0 };
      g.games += 1;
      g.pf += m.points;
      gamesByOwner.set(m.owner_id, g);
    }

    const bracket = (league.winners_bracket ?? null) as BracketEntry[] | null;
    const champEntry = bracket?.find((b) => b.p === 1) ?? null;
    const thirdEntry = bracket?.find((b) => b.p === 3) ?? null;
    const isCompleted = Boolean(champEntry && champEntry.w != null);

    const playoffParticipants = new Set<string>();
    const playoffWinsByOwner = new Map<string, number>();
    if (isCompleted && bracket) {
      for (const b of bracket) {
        if (b.t1) playoffParticipants.add(b.t1);
        if (b.t2) playoffParticipants.add(b.t2);
        // Count Winners Bracket round wins (excluding the 5th-place consolation match).
        if (b.w && b.p !== 5) {
          playoffWinsByOwner.set(b.w, (playoffWinsByOwner.get(b.w) ?? 0) + 1);
        }
      }
    }

    const teamCount = standings.length;
    standings.forEach((row, idx) => {
      const a = ensureAcc(row.owner_id);
      const g = gamesByOwner.get(row.owner_id) ?? {
        games: row.wins + row.losses + row.ties,
        pf: row.avg_ppg * (row.wins + row.losses + row.ties),
      };

      a.seasons_played += 1;
      a.wins += row.wins;
      a.losses += row.losses;
      a.ties += row.ties;
      a.games += g.games;
      a.points_for += g.pf;
      a.unrealized_wins += row.unrealized_wins;
      a.unrealized_losses += row.unrealized_losses;

      const regRank = idx + 1;
      let finish: SeasonFinishSummary["finish"] = "In Progress";

      if (isCompleted) {
        a.completed_seasons += 1;
        if (regRank === 1) a.reg_season_firsts += 1;
        const isLastReg = teamCount >= 2 && regRank === teamCount;
        if (isLastReg) a.lasts += 1;

        const madePlayoffs = playoffParticipants.has(row.owner_id);
        if (madePlayoffs) a.playoff_appearances += 1;
        a.playoff_wins += playoffWinsByOwner.get(row.owner_id) ?? 0;

        if (champEntry?.w === row.owner_id) {
          a.firsts += 1;
          finish = "1st";
        } else if (champEntry?.l === row.owner_id) {
          a.seconds += 1;
          finish = "2nd";
        } else if (thirdEntry?.w === row.owner_id) {
          a.thirds += 1;
          finish = "3rd";
        } else if (isLastReg) {
          finish = "Last";
        } else if (madePlayoffs) {
          finish = "Playoffs";
        } else {
          finish = "Reg";
        }

        a.season_finishes.push({
          season,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          avg_ppg: row.avg_ppg,
          reg_rank: regRank,
          team_count: teamCount,
          is_completed: true,
          made_playoffs: madePlayoffs,
          finish,
        });
      } else {
        a.season_finishes.push({
          season,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          avg_ppg: row.avg_ppg,
          reg_rank: regRank,
          team_count: teamCount,
          is_completed: false,
          made_playoffs: false,
          finish: "In Progress",
        });
      }
    });
  }

  const accList = [...accMap.values()].filter((a) => a.games > 0);
  if (accList.length === 0) return [];

  const leagueMeanPpg = mean(accList.map((a) => a.points_for / a.games));

  const entries: HallOfFameEntry[] = accList.map((a) => {
    const win_pct = (a.wins + a.ties * 0.5) / a.games;
    const allPlayTotal = a.unrealized_wins + a.unrealized_losses;
    const all_play_pct = allPlayTotal > 0 ? a.unrealized_wins / allPlayTotal : 0.5;
    const avg_ppg = a.points_for / a.games;
    const playoffRate =
      a.completed_seasons > 0 ? a.playoff_appearances / a.completed_seasons : 0;

    let hardware_pts: number;
    let win_rate_pts: number;
    let dominance_pts: number;
    let playoff_pts: number;
    let toilet_penalty_pts: number;

    if (mode === "rings") {
      hardware_pts = Math.min(70, a.firsts * 32 + a.seconds * 6.5 + a.thirds * 2.5);
      win_rate_pts = clamp(win_pct * 12, 0, 8);
      const apPts = clamp(all_play_pct * 8, 0, 5);
      const ppgPts = clamp(1.5 + (avg_ppg - leagueMeanPpg) * 0.15, 0.5, 3);
      dominance_pts = apPts + ppgPts;
      playoff_pts = playoffRate * 7 + Math.min(7, a.playoff_wins * 1.4);
      toilet_penalty_pts = a.lasts * 4.0;
    } else if (mode === "dominance") {
      hardware_pts = Math.min(25, a.firsts * 10 + a.seconds * 4.5 + a.thirds * 2);
      win_rate_pts = clamp(win_pct * 36, 0, 25);
      const apPts = clamp(all_play_pct * 35, 0, 22);
      const ppgPts = clamp(7.0 + (avg_ppg - leagueMeanPpg) * 0.55, 1.5, 13);
      dominance_pts = apPts + ppgPts;
      playoff_pts = playoffRate * 10 + Math.min(5, a.playoff_wins * 0.85);
      toilet_penalty_pts = a.lasts * 2.5;
    } else {
      hardware_pts = Math.min(60, a.firsts * 28 + a.seconds * 6 + a.thirds * 2.5);
      win_rate_pts = clamp(win_pct * 18, 0, 12);
      const apPts = clamp(all_play_pct * 11, 0, 7);
      const ppgPts = clamp(2.5 + (avg_ppg - leagueMeanPpg) * 0.22, 0.5, 5);
      dominance_pts = apPts + ppgPts;
      playoff_pts = playoffRate * 8 + Math.min(8, a.playoff_wins * 1.4);
      toilet_penalty_pts = a.lasts * 3.5;
    }

    const raw_total = clamp(
      hardware_pts + win_rate_pts + dominance_pts + playoff_pts - toilet_penalty_pts,
      0,
      100,
    );
    const legacy_score = Math.round(raw_total * 10) / 10;

    const breakdown: LegacyScoreBreakdown = {
      hardware_pts: Math.round(hardware_pts * 10) / 10,
      win_rate_pts: Math.round(win_rate_pts * 10) / 10,
      dominance_pts: Math.round(dominance_pts * 10) / 10,
      playoff_pts: Math.round(playoff_pts * 10) / 10,
      toilet_penalty_pts: Math.round(toilet_penalty_pts * 10) / 10,
      raw_total,
    };

    return {
      owner_id: a.owner_id,
      display_name: ownerById.get(a.owner_id)?.display_name ?? a.owner_id,
      seasons_played: a.seasons_played,
      completed_seasons: a.completed_seasons,
      wins: a.wins,
      losses: a.losses,
      ties: a.ties,
      win_pct,
      unrealized_wins: a.unrealized_wins,
      unrealized_losses: a.unrealized_losses,
      all_play_pct,
      avg_ppg,
      points_for: a.points_for,
      firsts: a.firsts,
      seconds: a.seconds,
      thirds: a.thirds,
      lasts: a.lasts,
      reg_season_firsts: a.reg_season_firsts,
      playoff_appearances: a.playoff_appearances,
      playoff_wins: a.playoff_wins,
      archetype: "",
      legacy_score,
      breakdown,
      season_finishes: [...a.season_finishes].sort((x, y) => y.season - x.season),
    };
  });

  entries.sort(
    (a, b) =>
      b.breakdown.raw_total - a.breakdown.raw_total ||
      b.firsts - a.firsts ||
      b.seconds - a.seconds ||
      b.wins - a.wins ||
      b.avg_ppg - a.avg_ppg,
  );

  const maxWins = Math.max(0, ...entries.map((e) => e.wins));
  const maxPpg = Math.max(0, ...entries.map((e) => e.avg_ppg));
  entries.forEach((entry, idx) => {
    entry.archetype = assignManagerArchetype(
      entry,
      idx + 1,
      entries.length,
      maxWins,
      maxPpg,
    );
  });

  return entries;
}
