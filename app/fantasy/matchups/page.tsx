import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type {
  BracketEntry,
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
} from "@/lib/types";
import {
  buildStandings,
  buildWeeklyAverages,
  mean,
  stdev,
  percentile,
  regularSeasonOnly,
} from "@/lib/fantasy";
import { fmt } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = { season?: string; value?: string };

export default async function FantasyMatchupsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const db = getSupabase();

  const [{ data: leagueData }, { data: ownerData }, { data: matchupData }] =
    await Promise.all([
      db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
      db.from("fantasy_owners").select("*"),
      db.from("fantasy_matchups").select("*").order("season", { ascending: false }),
    ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const matchups = (matchupData ?? []) as FantasyMatchup[];

  const seasons = leagues.map((l) => l.season);
  const requestedSeason = params.season ? Number(params.season) : seasons[0];
  const season = seasons.includes(requestedSeason) ? requestedSeason : seasons[0];
  const selectedLeague = leagues.find((l) => l.season === season) ?? null;

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

  return (
    <div className="max-w-5xl mx-auto pt-10">
      <div className="mb-6">
        <Link
          href="/fantasy"
          className="text-sm text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition"
        >
          ← Fantasy
        </Link>
      </div>

      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-8">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Matchups</h1>
          <p className="mt-1 text-sm text-stone-500">
            KFL standings, all-play records, and weekly scoring trends.
          </p>
        </div>
        <div className="flex gap-2">
          {seasons.map((s) => (
            <Link
              key={s}
              href={`/fantasy/matchups?season=${s}`}
              className={`px-3 py-1.5 rounded-md text-sm border transition ${
                s === season
                  ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                  : "border-stone-200 dark:border-stone-800 text-stone-600 hover:border-stone-400"
              }`}
            >
              {s}
            </Link>
          ))}
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
                  <td className="px-4 py-2 font-medium">{s.display_name}</td>
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
}: {
  bracket: BracketEntry[] | null;
  owners: FantasyOwner[];
  playoffMatchups: FantasyMatchup[];
}) {
  const nameOf = (id: string | null) =>
    id ? owners.find((o) => o.user_id === id)?.display_name ?? id : "TBD";

  const score = new Map<string, number>();
  for (const m of playoffMatchups) {
    score.set(`${m.owner_id}:${m.week}`, m.points);
  }

  if (!bracket || bracket.length === 0) {
    return (
      <p className="text-sm text-stone-500">
        No bracket data — run <code>npm run db:sync-fantasy</code> after the playoffs complete.
      </p>
    );
  }

  const rounds = new Map<number, BracketEntry[]>();
  for (const b of bracket) {
    const list = rounds.get(b.r) ?? [];
    list.push(b);
    rounds.set(b.r, list);
  }
  const sortedRounds = [...rounds.entries()].sort(([a], [b]) => a - b);

  const championship = bracket.find((b) => b.p === 1);
  const champion = championship?.w ? nameOf(championship.w) : null;

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
      {champion && (
        <div className="mb-4 text-sm">
          <span className="text-stone-500">Champion: </span>
          <span className="font-semibold">{champion} 🏆</span>
        </div>
      )}
      <div className="flex gap-6 overflow-x-auto">
        {sortedRounds.map(([roundNum, entries]) => (
          <div key={roundNum} className="flex flex-col gap-3 min-w-[200px]">
            <div className="text-xs uppercase tracking-wide text-stone-500">
              Round {roundNum}
            </div>
            {entries
              .sort((a, b) => a.m - b.m)
              .map((b) => (
                <div
                  key={`${b.r}-${b.m}`}
                  className="rounded-md border border-stone-200 dark:border-stone-800 text-sm"
                >
                  <BracketSide
                    name={nameOf(b.t1)}
                    isWinner={b.w === b.t1 && b.t1 != null}
                  />
                  <div className="border-t border-stone-200 dark:border-stone-800" />
                  <BracketSide
                    name={nameOf(b.t2)}
                    isWinner={b.w === b.t2 && b.t2 != null}
                  />
                  {b.p != null && (
                    <div className="text-[10px] text-stone-400 px-2 pb-1">
                      {b.p === 1 ? "Championship" : b.p === 3 ? "3rd Place" : `${b.p} place`}
                    </div>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function BracketSide({ name, isWinner }: { name: string; isWinner: boolean }) {
  return (
    <div
      className={`px-3 py-2 ${
        isWinner
          ? "font-semibold text-stone-900 dark:text-stone-100"
          : "text-stone-500"
      }`}
    >
      {name}
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
