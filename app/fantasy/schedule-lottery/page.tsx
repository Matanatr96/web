import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { FantasyLeague, FantasyMatchup, FantasyOwner } from "@/lib/types";
import { computeScheduleLottery, ownerColorMap } from "@/lib/fantasy";
import SeasonPicker from "@/components/season-picker";

export const dynamic = "force-dynamic";

type SearchParams = { season?: string };

export default async function ScheduleLotteryPage({
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

  const colorMap = ownerColorMap(owners);
  const result = computeScheduleLottery(matchups, owners, leagues, season);
  const { owners: seasonOwners, matrix, luckDeltas } = result;
  const n = seasonOwners.length;

  // Compute win% for each cell (for color intensity).
  const totalWeeks = n > 0 ? matrix[0][0].wins + matrix[0][0].losses + matrix[0][0].ties : 0;
  const winPct = (cell: { wins: number; losses: number; ties: number }) =>
    totalWeeks > 0 ? (cell.wins + cell.ties * 0.5) / totalWeeks : 0;

  // Min/max win% across the full matrix for color scaling.
  let minPct = 1;
  let maxPct = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = winPct(matrix[i][j]);
      if (p < minPct) minPct = p;
      if (p > maxPct) maxPct = p;
    }
  }
  const range = maxPct - minPct || 1;

  // Map win% to a red-white-green color via inline style.
  function cellColor(pct: number): string {
    const t = (pct - minPct) / range; // 0 = worst, 1 = best
    if (t >= 0.5) {
      // white → emerald
      const intensity = Math.round((t - 0.5) * 2 * 100);
      return `rgba(16,185,129,${(intensity / 100) * 0.35})`;
    } else {
      // red → white
      const intensity = Math.round((0.5 - t) * 2 * 100);
      return `rgba(239,68,68,${(intensity / 100) * 0.35})`;
    }
  }

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

      <div className="flex items-start justify-between flex-wrap gap-3 mb-8">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Schedule Lottery</h1>
          <p className="mt-1 text-sm text-stone-500">
            What would your record have been with anyone else&apos;s schedule?
          </p>
        </div>
        <SeasonPicker seasons={seasons} current={season} basePath="/fantasy/schedule-lottery" />
      </div>

      {n === 0 ? (
        <p className="text-sm text-stone-500">No regular-season matchups found for {season}.</p>
      ) : (
        <>
          {/* Heatmap */}
          <section className="mb-12">
            <h2 className="text-xl font-semibold mb-1">Record Matrix</h2>
            <p className="text-xs text-stone-500 mb-4">
              Row = whose scores &nbsp;·&nbsp; Column = whose schedule of opponents &nbsp;·&nbsp;
              Diagonal (outlined) = actual result
            </p>
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left text-stone-400 font-normal w-28 min-w-[7rem]" />
                    {seasonOwners.map((o) => (
                      <th
                        key={o.user_id}
                        className="px-2 py-1 font-medium text-stone-500 text-center min-w-[4.5rem]"
                      >
                        <span className="block truncate max-w-[5rem]" title={o.display_name}>
                          {o.display_name.split(" ")[0]}
                        </span>
                        <span className="block text-[10px] text-stone-400 font-normal">schedule</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {seasonOwners.map((rowOwner, oi) => (
                    <tr key={rowOwner.user_id}>
                      <td className={`px-2 py-1 font-medium ${colorMap.get(rowOwner.user_id) ?? ""} truncate max-w-[7rem]`}>
                        {rowOwner.display_name}
                      </td>
                      {seasonOwners.map((_, si) => {
                        const cell = matrix[oi][si];
                        const pct = winPct(cell);
                        const isDiag = oi === si;
                        return (
                          <td
                            key={si}
                            className={`px-2 py-1 text-center tabular-nums rounded ${
                              isDiag ? "ring-1 ring-stone-400 dark:ring-stone-500 font-semibold" : ""
                            }`}
                            style={{ backgroundColor: cellColor(pct) }}
                            title={`${rowOwner.display_name} with ${seasonOwners[si].display_name}'s schedule: ${cell.wins}-${cell.losses}${cell.ties > 0 ? `-${cell.ties}` : ""}`}
                          >
                            {cell.wins}-{cell.losses}
                            {cell.ties > 0 ? `-${cell.ties}` : ""}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Luck delta leaderboard */}
          <section>
            <h2 className="text-xl font-semibold mb-1">Luck Leaderboard</h2>
            <p className="text-xs text-stone-500 mb-4">
              Actual wins minus the median wins across all possible schedules.
              Positive = lucky draw, negative = got robbed.
            </p>
            <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
              <table className="min-w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-900/50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Owner</th>
                    <th className="text-right px-3 py-2 font-medium">Actual W</th>
                    <th className="text-right px-3 py-2 font-medium">Median W</th>
                    <th className="text-right px-4 py-2 font-medium">Luck Delta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
                  {luckDeltas.map((row) => (
                    <tr key={row.owner_id}>
                      <td className={`px-4 py-2 font-medium ${colorMap.get(row.owner_id) ?? ""}`}>
                        {row.display_name}
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">{row.actual_wins}</td>
                      <td className="text-right px-3 py-2 tabular-nums text-stone-500">
                        {Number.isInteger(row.median_wins)
                          ? row.median_wins
                          : row.median_wins.toFixed(1)}
                      </td>
                      <td
                        className={`text-right px-4 py-2 tabular-nums font-semibold ${
                          row.delta > 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : row.delta < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-stone-400"
                        }`}
                      >
                        {row.delta > 0 ? "+" : ""}
                        {Number.isInteger(row.delta) ? row.delta : row.delta.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
