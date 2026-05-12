import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import type {
  BracketEntry,
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  FantasyPlayerScore,
  WeeklySummary,
} from "@/lib/types";
import {
  buildStandings,
  buildWeeklyAverages,
  computeWeeklyStats,
  mean,
  stdev,
  percentile,
  regularSeasonOnly,
  ownerColorMap,
} from "@/lib/fantasy";
import { fmt } from "@/lib/utils";
import RefreshMatchupsButton from "@/components/refresh-matchups-button";
import SeasonPicker from "@/components/season-picker";
import OracleWeekView from "@/app/fantasy/oracle/OracleWeekView";

export const dynamic = "force-dynamic";

type SearchParams = { season?: string; value?: string };

export default async function FantasyMatchupsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const db = getSupabase();
  const admin = await isAdmin();

  const [{ data: leagueData }, { data: ownerData }, { data: matchupData }, { data: summaryData }] =
    await Promise.all([
      db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
      db.from("fantasy_owners").select("*"),
      db.from("fantasy_matchups").select("*").order("season", { ascending: false }),
      db.from("fantasy_weekly_summaries").select("*").order("season", { ascending: false }).order("week", { ascending: false }),
    ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const matchups = (matchupData ?? []) as FantasyMatchup[];
  const summaries = (summaryData ?? []) as WeeklySummary[];

  const seasons = leagues.map((l) => l.season);
  const requestedSeason = params.season ? Number(params.season) : seasons[0];
  const season = seasons.includes(requestedSeason) ? requestedSeason : seasons[0];
  const selectedLeague = leagues.find((l) => l.season === season) ?? null;

  const colorMap = ownerColorMap(owners);

  const regSeasonAll = regularSeasonOnly(matchups, leagues);
  const standings = buildStandings(regSeasonAll, owners, season);
  const weekly = buildWeeklyAverages(regSeasonAll, seasons, 14);

  const playoffStart = selectedLeague?.playoff_week_start ?? 15;
  const playoffMatchups = matchups.filter(
    (m) => m.season === season && m.week >= playoffStart,
  );
  const bracket = (selectedLeague?.winners_bracket ?? null) as BracketEntry[] | null;

  const seasonScores = regSeasonAll
    .filter((m) => m.season === season)
    .map((m) => m.points);
  const seasonAvg = mean(seasonScores);
  const seasonStdev = stdev(seasonScores);
  const inputValue = params.value ? Number(params.value) : NaN;
  const valuePercentile = Number.isFinite(inputValue)
    ? percentile(inputValue, seasonScores)
    : null;

  // Oracle of Regret — most recent week with matchup data. Prefers the
  // selected season, but falls back to the most recent season that has data.
  const seasonWeeks = [...new Set(
    matchups.filter((m) => m.season === season && m.points > 0).map((m) => m.week)
  )].sort((a, b) => b - a);

  const oracleSeason = seasonWeeks.length > 0
    ? season
    : (() => {
        const latest = matchups
          .filter((m) => m.points > 0)
          .sort((a, b) => b.season - a.season || b.week - a.week)[0];
        return latest?.season ?? season;
      })();

  const oracleWeeks = oracleSeason === season
    ? seasonWeeks
    : [...new Set(matchups.filter((m) => m.season === oracleSeason && m.points > 0).map((m) => m.week))].sort((a, b) => b - a);

  const oracleWeek = oracleWeeks[0] ?? null;

  const { data: playerScoreData } = oracleWeek
    ? await db.from("fantasy_player_scores").select("*").eq("season", oracleSeason).eq("week", oracleWeek)
    : { data: [] };
  const playerScores = (playerScoreData ?? []) as FantasyPlayerScore[];

  const oracleStats = oracleWeek
    ? computeWeeklyStats(matchups, playerScores, owners, oracleSeason, oracleWeek)
    : null;
  const oracleSummary = oracleWeek
    ? summaries.find((s) => s.season === oracleSeason && s.week === oracleWeek) ?? null
    : null;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Link
          href="/fantasy"
          className="text-sm text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition"
        >
          ← Fantasy
        </Link>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-3 mb-8">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Matchups</h1>
          <p className="mt-1 text-sm text-stone-500">
            KFL standings, all-play records, and weekly scoring trends.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SeasonPicker seasons={seasons} current={season} basePath="/fantasy/matchups" />
          {admin && <RefreshMatchupsButton />}
        </div>
      </div>

      {/* Standings */}
      <section className="mb-12">
        <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-900/50">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Owner</th>
                <th className="text-right px-3 py-2 font-medium">Record</th>
                <th className="text-right px-3 py-2 font-medium">Unrealized W/L</th>
                <th className="text-right px-3 py-2 font-medium">Avg PPG</th>
                <th className="text-right px-3 py-2 font-medium">Avg PPGA</th>
                <th className="text-right px-3 py-2 font-medium">Diff</th>
                <th className="text-right px-4 py-2 font-medium">PPG vs Avg</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
              {standings.map((s) => (
                <tr key={s.owner_id}>
                  <td className={`px-4 py-2 font-medium ${colorMap.get(s.owner_id) ?? ""}`}>{s.display_name}</td>
                  <td className="text-right px-3 py-2 tabular-nums">
                    {s.wins} - {s.losses}
                    {s.ties > 0 ? ` - ${s.ties}` : ""}
                  </td>
                  <td className="text-right px-3 py-2 tabular-nums text-stone-500">
                    {s.unrealized_wins} - {s.unrealized_losses}
                  </td>
                  <td className="text-right px-3 py-2 tabular-nums">{fmt(s.avg_ppg, 2)}</td>
                  <td className="text-right px-3 py-2 tabular-nums">{fmt(s.avg_ppga, 2)}</td>
                  <td
                    className={`text-right px-3 py-2 tabular-nums ${
                      s.avg_diff >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {s.avg_diff >= 0 ? "+" : ""}
                    {fmt(s.avg_diff, 2)}
                  </td>
                  <td
                    className={`text-right px-4 py-2 tabular-nums ${
                      s.ppg_vs_avg >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {s.ppg_vs_avg >= 0 ? "+" : ""}
                    {fmt(s.ppg_vs_avg, 2)}
                  </td>
                </tr>
              ))}
              {standings.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-stone-500">
                    No matchups synced for {season} yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Weekly averages + sidebar */}
      <section className="grid gap-8 md:grid-cols-[1fr_280px]">
        <div>
          <h2 className="text-xl font-semibold mb-3">Weekly Averages</h2>
          <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
            <table className="min-w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-900/50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Week</th>
                  <th className="text-right px-4 py-2 font-medium">Avg</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
                {weekly
                  .filter((row) => row.averages[season] != null)
                  .map((row) => (
                    <tr key={row.week}>
                      <td className="px-4 py-2 text-stone-500">Week {row.week}</td>
                      <td className="text-right px-4 py-2 tabular-nums">
                        {fmt(row.averages[season], 2)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside>
          <h2 className="text-xl font-semibold mb-3">{season} Distribution</h2>
          <dl className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 divide-y divide-stone-200 dark:divide-stone-800">
            <SidebarStat label="League Avg" value={fmt(seasonAvg, 2)} />
            <SidebarStat label="Std Dev" value={fmt(seasonStdev, 2)} />
            <SidebarStat label="Sample Size" value={String(seasonScores.length)} />
          </dl>

          <form method="get" className="mt-4">
            <input type="hidden" name="season" value={season} />
            <label className="block text-xs uppercase tracking-wide text-stone-500 mb-1">
              Value to examine
            </label>
            <input
              type="number"
              step="0.01"
              name="value"
              defaultValue={params.value ?? ""}
              placeholder="e.g. 105.50"
              className="w-full rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="mt-2 w-full rounded-md bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 px-3 py-2 text-sm"
            >
              Compute percentile
            </button>
          </form>

          {valuePercentile != null && (
            <div className="mt-4 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-3">
              <div className="text-2xl font-bold tabular-nums">
                {fmt(valuePercentile, 1)}%
              </div>
              <div className="text-xs uppercase tracking-wide text-stone-500 mt-1">
                Percentile of {fmt(inputValue, 2)}
              </div>
            </div>
          )}
        </aside>
      </section>

      {/* Playoffs */}
      {(bracket || playoffMatchups.length > 0) && (
        <section className="mt-12">
          <h2 className="text-xl font-semibold mb-3">{season} Playoffs</h2>
          <PlayoffBracket
            bracket={bracket}
            owners={owners}
            playoffMatchups={playoffMatchups}
            playoffStart={playoffStart}
            colorMap={colorMap}
          />
        </section>
      )}

      {/* Oracle of Regret */}
      {oracleWeek && (
        <section className="mt-12">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="text-xl font-semibold">Oracle of Regret</h2>
              <p className="text-xs text-stone-500 mt-0.5">{oracleSeason} · Week {oracleWeek} · bench mistakes &amp; haikus of shame</p>
            </div>
            <Link href="/fantasy/oracle" className="text-xs text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition">
              Full archive →
            </Link>
          </div>
          <OracleWeekView
            season={oracleSeason}
            week={oracleWeek}
            stats={oracleStats}
            initialSummary={oracleSummary}
            initialBanter={[]}
            isAdmin={admin}
          />
        </section>
      )}
    </div>
  );
}

function PlayoffBracket({
  bracket,
  owners,
  playoffMatchups,
  playoffStart,
  colorMap,
}: {
  bracket: BracketEntry[] | null;
  owners: FantasyOwner[];
  playoffMatchups: FantasyMatchup[];
  playoffStart: number;
  colorMap: Map<string, string>;
}) {
  if (!bracket || bracket.length === 0) {
    return (
      <p className="text-sm text-stone-500">
        No bracket data — run <code>npm run db:sync-fantasy</code> after the playoffs complete.
      </p>
    );
  }

  const nameOf = (id: string | null) =>
    id ? (owners.find((o) => o.user_id === id)?.display_name ?? id) : "TBD";

  const scoreMap = new Map<string, number>();
  for (const m of playoffMatchups) {
    scoreMap.set(`${m.owner_id}:${m.week}`, m.points);
  }

  const rounds = new Map<number, BracketEntry[]>();
  for (const b of bracket) {
    const list = rounds.get(b.r) ?? [];
    list.push(b);
    rounds.set(b.r, list);
  }
  const sortedRounds = [...rounds.entries()].sort(([a], [b]) => a - b);
  const maxRound = Math.max(...rounds.keys());

  const roundLabel = (r: number) => {
    if (r === maxRound) return "Finals";
    if (r === maxRound - 1) return "Semifinals";
    return "First Round";
  };

  const matchupLabel = (entry: BracketEntry) => {
    if (entry.p === 1) return "Championship";
    if (entry.p === 3) return "3rd Place";
    if (entry.p === 5) return "5th Place";
    return null;
  };

  const placementOrder = (e: BracketEntry) =>
    e.p === 1 ? 0 : e.p === 3 ? 1 : e.p === 5 ? 2 : -1;

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-4 min-w-fit">
        {sortedRounds.map(([roundNum, entries], colIdx) => {
          const week = playoffStart + (roundNum - 1);
          const sorted = [...entries].sort((a, b) => {
            const pa = placementOrder(a);
            const pb = placementOrder(b);
            if (pa === -1 && pb === -1) return a.m - b.m;
            if (pa === -1) return -1;
            if (pb === -1) return 1;
            return pa - pb;
          });

          return (
            <div key={roundNum} className="flex items-start gap-4">
              <div className="flex flex-col gap-3 w-[220px]">
                <div className="flex items-baseline gap-2 h-6">
                  <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                    {roundLabel(roundNum)}
                  </span>
                  <span className="text-xs text-stone-400">Wk {week}</span>
                </div>
                {sorted.map((entry) => {
                  const label = matchupLabel(entry);
                  const hasResult = entry.w != null;
                  const t1Score = entry.t1 ? scoreMap.get(`${entry.t1}:${week}`) : undefined;
                  const t2Score = entry.t2 ? scoreMap.get(`${entry.t2}:${week}`) : undefined;

                  return (
                    <div
                      key={`${entry.r}-${entry.m}`}
                      className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden"
                    >
                      {label && (
                        <div className="px-3 py-1 bg-stone-50 dark:bg-stone-800/50 border-b border-stone-200 dark:border-stone-800">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                            {label}
                          </span>
                        </div>
                      )}
                      <MatchupRow
                        name={nameOf(entry.t1)}
                        score={t1Score}
                        isWinner={hasResult && entry.w === entry.t1}
                        isLoser={hasResult && entry.l === entry.t1}
                        isTbd={entry.t1 == null}
                        color={entry.t1 ? colorMap.get(entry.t1) : undefined}
                      />
                      <div className="border-t border-stone-100 dark:border-stone-800/60" />
                      <MatchupRow
                        name={nameOf(entry.t2)}
                        score={t2Score}
                        isWinner={hasResult && entry.w === entry.t2}
                        isLoser={hasResult && entry.l === entry.t2}
                        isTbd={entry.t2 == null}
                        color={entry.t2 ? colorMap.get(entry.t2) : undefined}
                      />
                    </div>
                  );
                })}
              </div>

              {colIdx < sortedRounds.length - 1 && (
                <div className="flex items-center self-stretch pt-6">
                  <span className="text-stone-300 dark:text-stone-700 text-lg select-none">›</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchupRow({
  name,
  score,
  isWinner,
  isLoser,
  isTbd,
  color,
}: {
  name: string;
  score: number | undefined;
  isWinner: boolean;
  isLoser: boolean;
  isTbd: boolean;
  color?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 px-3 py-2 text-sm transition-colors ${
        isTbd ? "text-stone-400 italic" : isWinner ? "bg-emerald-50 dark:bg-emerald-950/30" : isLoser ? "opacity-40" : ""
      }`}
    >
      <span className={`truncate font-medium ${isWinner ? "font-semibold" : ""} ${isTbd ? "" : (color ?? "")}`}>
        {name}
      </span>
      {score != null && (
        <span className={`tabular-nums text-xs shrink-0 ${isWinner ? "font-semibold" : "text-stone-400"}`}>
          {fmt(score, 2)}
        </span>
      )}
    </div>
  );
}

function SidebarStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3 flex items-baseline justify-between">
      <span className="text-xs uppercase tracking-wide text-stone-500">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}
