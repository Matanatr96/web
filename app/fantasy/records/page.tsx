import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { FantasyLeague, FantasyMatchup, FantasyOwner } from "@/lib/types";
import {
  regularSeasonOnly,
  topScoringRecords,
  lowestScoringRecords,
  biggestBlowouts,
} from "@/lib/fantasy";
import { fmt } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function FantasyRecordsPage() {
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

  const regSeasonAll = regularSeasonOnly(matchups, leagues);
  const topScores = topScoringRecords(regSeasonAll, owners, 10);
  const lowScores = lowestScoringRecords(regSeasonAll, owners, 10);
  const blowouts = biggestBlowouts(regSeasonAll, owners, 10);

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

      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">All-Time Records</h1>
        <p className="mt-1 text-sm text-stone-500">
          Single-game records across all regular seasons.
        </p>
      </div>

      <section className="grid gap-8 md:grid-cols-2 mb-12">
        <RecordsTable
          title="Top Scoring"
          rows={topScores.map((r) => ({
            year: r.season,
            week: r.week,
            owner: r.display_name,
            value: fmt(r.points, 2),
          }))}
          valueLabel="Points"
        />
        <RecordsTable
          title="Lowest Scoring"
          rows={lowScores.map((r) => ({
            year: r.season,
            week: r.week,
            owner: r.display_name,
            value: fmt(r.points, 2),
          }))}
          valueLabel="Points"
        />
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-3">Biggest Blowouts</h2>
        <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-900/50">
              <tr>
                <th className="text-left  px-4 py-2 font-medium">Year</th>
                <th className="text-left  px-3 py-2 font-medium">Week</th>
                <th className="text-left  px-3 py-2 font-medium">Owner</th>
                <th className="text-right px-3 py-2 font-medium">Differential</th>
                <th className="text-left  px-4 py-2 font-medium">Opponent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
              {blowouts.map((b, i) => (
                <tr key={i}>
                  <td className="px-4 py-2 text-stone-500">{b.season}</td>
                  <td className="px-3 py-2 text-stone-500">{b.week}</td>
                  <td className="px-3 py-2 font-medium">{b.display_name}</td>
                  <td className="text-right px-3 py-2 tabular-nums text-emerald-600 dark:text-emerald-400">
                    +{fmt(b.differential, 2)}
                  </td>
                  <td className="px-4 py-2 text-stone-500">{b.opponent_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function RecordsTable({
  title,
  rows,
  valueLabel,
}: {
  title: string;
  rows: Array<{ year: number; week: number; owner: string; value: string }>;
  valueLabel: string;
}) {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
        <table className="min-w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-900/50">
            <tr>
              <th className="text-left  px-4 py-2 font-medium">Year</th>
              <th className="text-left  px-3 py-2 font-medium">Week</th>
              <th className="text-left  px-3 py-2 font-medium">Owner</th>
              <th className="text-right px-4 py-2 font-medium">{valueLabel}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-4 py-2 text-stone-500">{r.year}</td>
                <td className="px-3 py-2 text-stone-500">{r.week}</td>
                <td className="px-3 py-2 font-medium">{r.owner}</td>
                <td className="text-right px-4 py-2 tabular-nums">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
