import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type {
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
} from "@/lib/fantasy";
import { fmt } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = { season?: string; value?: string };

export default async function FantasyPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const db = getSupabase();

  const [
    { data: leagueData },
    { data: ownerData },
    { data: matchupData },
  ] = await Promise.all([
    db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
    db.from("fantasy_owners").select("*"),
    db.from("fantasy_matchups").select("*").order("season", { ascending: false }),
  ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const matchups = (matchupData ?? []) as FantasyMatchup[];

  if (leagues.length === 0) {
    return (
      <div className="max-w-3xl mx-auto pt-10">
        <h1 className="text-3xl font-bold tracking-tight mb-4">Fantasy Football</h1>
        <p className="text-sm text-stone-500">
          No leagues configured yet. Insert a row into{" "}
          <code className="text-stone-700 dark:text-stone-300">fantasy_leagues</code>{" "}
          and run <code className="text-stone-700 dark:text-stone-300">npm run db:sync-fantasy</code>.
        </p>
      </div>
    );
  }

  const seasons = leagues.map((l) => l.season);
  const requestedSeason = params.season ? Number(params.season) : seasons[0];
  const season = seasons.includes(requestedSeason) ? requestedSeason : seasons[0];

  const standings = buildStandings(matchups, owners, season);
  const weekly = buildWeeklyAverages(matchups, seasons, 14);

  // Sidebar stats: distribution of all per-owner-per-week scores in selected season.
  const seasonScores = matchups.filter((m) => m.season === season).map((m) => m.points);
  const seasonAvg = mean(seasonScores);
  const seasonStdev = stdev(seasonScores);
  const inputValue = params.value ? Number(params.value) : NaN;
  const valuePercentile = Number.isFinite(inputValue)
    ? percentile(inputValue, seasonScores)
    : null;

  return (
    <div className="max-w-5xl mx-auto pt-10">
      {/* Header */}
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Fantasy Football</h1>
          <p className="mt-1 text-sm text-stone-500">
            KFL standings, all-play records, and weekly scoring trends from Sleeper.
          </p>
        </div>
        <div className="flex gap-2">
          {seasons.map((s) => (
            <Link
              key={s}
              href={`/fantasy?season=${s}`}
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
                <th className="text-right px-3 py-2 font-medium">All-Play</th>
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
                  {seasons.map((s) => (
                    <th key={s} className="text-right px-3 py-2 font-medium">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
                {weekly.map((row) => (
                  <tr key={row.week}>
                    <td className="px-4 py-2 text-stone-500">Week {row.week}</td>
                    {seasons.map((s) => (
                      <td key={s} className="text-right px-3 py-2 tabular-nums">
                        {row.averages[s] != null ? fmt(row.averages[s], 2) : "—"}
                      </td>
                    ))}
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
