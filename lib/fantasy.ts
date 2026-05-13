import type {
  BlowoutRecord,
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
  Rivalry,
  RivalryGame,
  ScoreRecord,
  ScheduleLotteryResult,
  TradeLeaderboardRow,
  WeeklyStats,
} from "./types";

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
  const idx = new Map(seasonOwners.map((o, i) => [o.user_id, i]));

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
    // opponentScore[owner_id] = their actual opponent's points this week
    const opponentScore = new Map(weekRows.map((m) => [m.owner_id, m.opponent_points]));

    for (let oi = 0; oi < n; oi++) {
      const myScore = score.get(seasonOwners[oi].user_id);
      if (myScore == null) continue;

      for (let si = 0; si < n; si++) {
        // Owner oi playing schedule-owner si's schedule: face si's actual opponent.
        const schedOwner = seasonOwners[si];
        const theirOpponentScore = opponentScore.get(schedOwner.user_id);
        if (theirOpponentScore == null) continue;

        if (oi === si) {
          // Own schedule — still count it for median calculation.
        }
        const cell = matrix[oi][si];
        if (myScore > theirOpponentScore) cell.wins += 1;
        else if (myScore < theirOpponentScore) cell.losses += 1;
        else cell.ties += 1;
      }
    }
  }

  // Luck delta: actual wins (diagonal) vs median across all N schedules.
  const luckDeltas = seasonOwners.map((owner, oi) => {
    const actual_wins = matrix[oi][oi].wins;
    const allWins = matrix[oi].map((c) => c.wins).sort((a, b) => a - b);
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

  // Biggest blowout and closest matchup (W-rows only to avoid double-counting).
  const winRows = weekMatchups.filter((m) => m.result === "W" && m.opponent_id != null);
  const withMargin = winRows.map((m) => ({
    winner_id: m.owner_id,
    winner_name: ownerName(m.owner_id),
    loser_id: m.opponent_id as string,
    loser_name: ownerName(m.opponent_id as string),
    margin: m.points - m.opponent_points,
    winner_points: m.points,
    loser_points: m.opponent_points,
  }));
  withMargin.sort((a, b) => b.margin - a.margin);
  const biggest_blowout = withMargin[0] ?? null;
  const closest_matchup = withMargin[withMargin.length - 1] ?? null;

  // Biggest bench mistake: max(bench_pts - starter_pts_at_same_position) across all owners.
  const weekScores = playerScores.filter((p) => p.season === season && p.week === week);
  let bench_mistake = null;
  let maxDelta = -Infinity;

  for (const [ownerId, matchup] of byOwner) {
    const ownerScores = weekScores.filter((p) => p.owner_id === ownerId);
    const starters = ownerScores.filter((p) => p.is_starter);
    const bench = ownerScores.filter((p) => !p.is_starter && p.points > 0);

    for (const benchPlayer of bench) {
      const pos = benchPlayer.position;
      // Find starters the bench player could have replaced (same position, or FLEX swap).
      const eligible = starters.filter((s) => {
        if (!pos) return false;
        if (s.position === pos) return true;
        // A FLEX-eligible bench player can replace a FLEX-eligible starter.
        if (FLEX_POSITIONS.has(pos) && s.position && FLEX_POSITIONS.has(s.position)) return true;
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
  // Dedupe matchups: each game appears twice (once per owner). Keep one row
  // per (season, week, canonical-pair-key), with A = lexicographically smaller
  // user_id so the perspective is stable across the dataset.
  type DedupedGame = RivalryGame & { a_id: string; b_id: string };
  const seen = new Map<string, DedupedGame>();
  for (const m of matchups) {
    if (m.opponent_id == null) continue;
    const key = `${m.season}|${m.week}|${pairKey(m.owner_id, m.opponent_id)}`;
    if (seen.has(key)) continue;
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
      is_playoff: !isRegularSeason(m.season, m.week, leagues),
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

// Hybrid pick weight: round anchor (R1=1, R2=0.5, R3=0.25) × within-round
// exponential decay (~4% per slot). Earlier picks in a round count more.
const pickWeight = (round: number, pickNumber: number): number =>
  (1 / Math.pow(2, round - 1)) * Math.exp(-0.04 * (pickNumber - 1));

/**
 * Compute VOR-based draft grades for each owner in a season.
 *
 * VOR per pick = player_season_pts - replacement_level_pts_at_position
 * Replacement level = points scored by the Nth player at that position, where
 * N = starters_per_team × number of teams in the draft.
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

  const teamCount = new Set(seasonPicks.map((p) => p.owner_id)).size;

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

  // Replacement level = points of the (N+1)th player sorted descending (0-indexed at N).
  const replacementLevel = new Map<string, number>();
  for (const pos of GRADED_POSITIONS) {
    const n = (STARTERS_PER_TEAM[pos] ?? 1) * teamCount;
    const sorted = (positionPts.get(pos) ?? []).sort((a, b) => b - a);
    replacementLevel.set(pos, sorted[n] ?? sorted[sorted.length - 1] ?? 0);
  }

  // Grade each pick.
  type InternalPick = DraftPickGrade & { owner_id: string };
  const pickGrades: InternalPick[] = [];
  for (const pick of seasonPicks) {
    const pos = pick.position;
    if (!pos || !GRADED_POSITIONS.has(pos)) continue;
    const season_pts = playerTotals.get(pick.player_id) ?? 0;
    const replacement_pts = replacementLevel.get(pos) ?? 0;
    pickGrades.push({
      owner_id: pick.owner_id,
      player_id: pick.player_id,
      player_name: pick.player_name,
      position: pos,
      round: pick.round,
      pick_number: pick.pick_number,
      season_pts,
      replacement_pts,
      vor: season_pts - replacement_pts,
    });
  }

  // Group by owner and sum VOR.
  const ownerById = new Map(owners.map((o) => [o.user_id, o]));
  const ownerPickMap = new Map<string, InternalPick[]>();
  for (const pg of pickGrades) {
    const arr = ownerPickMap.get(pg.owner_id) ?? [];
    arr.push(pg);
    ownerPickMap.set(pg.owner_id, arr);
  }

  const rows: DraftGradeRow[] = [];
  for (const [owner_id, ownerPicks] of ownerPickMap) {
    const weightedSum = ownerPicks.reduce((s, p) => s + p.vor * pickWeight(p.round, p.pick_number), 0);
    const totalWeight = ownerPicks.reduce((s, p) => s + pickWeight(p.round, p.pick_number), 0);
    const total_vor = totalWeight > 0 ? weightedSum / totalWeight : 0;
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
