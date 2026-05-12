import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { BracketEntry, FantasyLeague, FantasyMatchup, FantasyOwner } from "@/lib/types";
import { regularSeasonOnly, ownerColorMap } from "@/lib/fantasy";

export const dynamic = "force-dynamic";

export default async function FantasyPage() {
  const db = getSupabase();

  const [{ data: leagueData }, { data: ownerData }, { data: matchupData }] =
    await Promise.all([
      db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
      db.from("fantasy_owners").select("*"),
      db.from("fantasy_matchups").select("*"),
    ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const matchups = (matchupData ?? []) as FantasyMatchup[];

  const regSeason = regularSeasonOnly(matchups, leagues);

  const colorMap = ownerColorMap(owners);

  // Champions: one per season, derived from winners_bracket p=1 entry
  const champions = leagues
    .map((league) => {
      const bracket = league.winners_bracket as BracketEntry[] | null;
      const champEntry = bracket?.find((b) => b.p === 1);
      const owner = champEntry?.w
        ? owners.find((o) => o.user_id === champEntry.w)
        : null;
      return {
        season: league.season,
        owner_id: owner?.user_id ?? null,
        display_name: owner?.display_name ?? null,
      };
    })
    .filter((c): c is { season: number; owner_id: string; display_name: string } => c.display_name != null)
    .sort((a, b) => b.season - a.season);

  // All-time regular season win counts across all seasons
  const winMap = new Map<string, { owner_id: string; display_name: string; wins: number }>();
  for (const m of regSeason) {
    if (m.result !== "W") continue;
    const owner = owners.find((o) => o.user_id === m.owner_id);
    if (!owner) continue;
    const entry = winMap.get(m.owner_id) ?? { owner_id: m.owner_id, display_name: owner.display_name, wins: 0 };
    entry.wins += 1;
    winMap.set(m.owner_id, entry);
  }
  const winRankings = [...winMap.values()].sort((a, b) => b.wins - a.wins);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Fantasy Football</h1>
        <p className="mt-1 text-sm text-stone-500">
          KFL — standings, records, and trades from Sleeper.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mb-12">
        <Link
          href="/fantasy/matchups"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Matchups</span>
          <span className="text-sm text-stone-500">Standings, weekly averages, and playoffs</span>
        </Link>

        <Link
          href="/fantasy/trades"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Trades</span>
          <span className="text-sm text-stone-500">All completed trades and trade leaderboard</span>
        </Link>

        <Link
          href="/fantasy/records"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Records</span>
          <span className="text-sm text-stone-500">Top scoring, lowest scoring, biggest blowouts</span>
        </Link>

        <Link
          href="/fantasy/schedule-lottery"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Schedule Lottery</span>
          <span className="text-sm text-stone-500">How lucky was your schedule? Replay every season under every opponent draw.</span>
        </Link>
      </div>

      <div className="grid gap-8 md:grid-cols-2 max-w-2xl">
        {/* Champions */}
        <div>
          <h2 className="text-lg font-semibold mb-3">Champions</h2>
          <ol className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 divide-y divide-stone-100 dark:divide-stone-800">
            {champions.map((c) => (
              <li
                key={c.season}
                className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span className={`font-medium ${colorMap.get(c.owner_id) ?? ""}`}>
                  {c.display_name}
                </span>
                <span className="text-stone-400 tabular-nums text-xs">{c.season}</span>
              </li>
            ))}
            {champions.length === 0 && (
              <li className="px-4 py-3 text-sm text-stone-400 italic">No completed seasons yet.</li>
            )}
          </ol>
        </div>

        {/* All-time regular season wins */}
        <div>
          <h2 className="text-lg font-semibold mb-1">All-Time Wins</h2>
          <p className="text-xs text-stone-400 mb-3">Regular season only, excludes playoffs</p>
          <ol className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 divide-y divide-stone-100 dark:divide-stone-800">
            {winRankings.map((row, i) => (
              <li
                key={row.display_name}
                className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="text-xs text-stone-400 tabular-nums w-4">{i + 1}</span>
                  <span className={`font-medium truncate ${colorMap.get(row.owner_id) ?? ""}`}>{row.display_name}</span>
                </span>
                <span className="tabular-nums font-semibold">{row.wins}</span>
              </li>
            ))}
            {winRankings.length === 0 && (
              <li className="px-4 py-3 text-sm text-stone-400 italic">No data yet.</li>
            )}
          </ol>
        </div>
      </div>
    </div>
  );
}
