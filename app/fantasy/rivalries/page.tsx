import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type {
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  FantasyTrade,
  Rivalry,
  RivalryGame,
} from "@/lib/types";
import { buildRivalries, findRivalry, ownerColorMap } from "@/lib/fantasy";
import { fmt } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = { pair?: string };

export default async function RivalriesPage({
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
    { data: tradeData },
  ] = await Promise.all([
    db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
    db.from("fantasy_owners").select("*"),
    db.from("fantasy_matchups").select("*").order("season", { ascending: false }),
    db.from("fantasy_trades").select("*"),
  ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const matchups = (matchupData ?? []) as FantasyMatchup[];
  const trades = (tradeData ?? []) as FantasyTrade[];

  const colorMap = ownerColorMap(owners);
  const rivalries = buildRivalries(matchups, trades, owners, leagues);

  const [pairA, pairB] = (params.pair ?? "").split("-");
  const selected = pairA && pairB ? findRivalry(rivalries, pairA, pairB) : null;

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

      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">The Rivalry Ledger</h1>
        <p className="mt-1 text-sm text-stone-500">
          Pairwise head-to-head dossiers and a "most heated" leaderboard. Heat blends games played,
          close finishes, playoff stakes, trade entanglement, and record balance.
        </p>
      </div>

      {selected && <Dossier rivalry={selected} colorMap={colorMap} />}

      <section>
        <h2 className="text-xl font-semibold mb-3">
          {selected ? "All rivalries" : "Most heated"}
        </h2>
        <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-900/50">
              <tr>
                <th className="text-left  px-4 py-2 font-medium">Rank</th>
                <th className="text-left  px-3 py-2 font-medium">Matchup</th>
                <th className="text-right px-3 py-2 font-medium">Games</th>
                <th className="text-right px-3 py-2 font-medium">Record</th>
                <th className="text-right px-3 py-2 font-medium">Avg Margin</th>
                <th className="text-right px-3 py-2 font-medium">Close</th>
                <th className="text-right px-3 py-2 font-medium">Playoff</th>
                <th className="text-right px-3 py-2 font-medium">Trades</th>
                <th className="text-right px-4 py-2 font-medium">Heat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
              {rivalries.map((r, i) => {
                const isSelected =
                  selected != null && selected.a_id === r.a_id && selected.b_id === r.b_id;
                return (
                  <tr
                    key={`${r.a_id}-${r.b_id}`}
                    className={isSelected ? "bg-stone-100 dark:bg-stone-800/60" : ""}
                  >
                    <td className="px-4 py-2 text-stone-500 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/fantasy/rivalries?pair=${r.a_id}-${r.b_id}`}
                        className="hover:underline underline-offset-4"
                      >
                        <span className={`font-medium ${colorMap.get(r.a_id) ?? ""}`}>
                          {r.a_name}
                        </span>
                        <span className="text-stone-400 mx-1.5">vs</span>
                        <span className={`font-medium ${colorMap.get(r.b_id) ?? ""}`}>
                          {r.b_name}
                        </span>
                      </Link>
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.games_played}</td>
                    <td className="text-right px-3 py-2 tabular-nums text-stone-500">
                      {r.a_wins}-{r.b_wins}
                      {r.ties > 0 ? `-${r.ties}` : ""}
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums text-stone-500">
                      {r.avg_margin >= 0 ? "+" : ""}
                      {fmt(r.avg_margin, 2)}
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.close_games}</td>
                    <td className="text-right px-3 py-2 tabular-nums">
                      {r.playoff_games > 0 ? r.playoff_games : "—"}
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums">
                      {r.trades_exchanged > 0 ? r.trades_exchanged : "—"}
                    </td>
                    <td className="text-right px-4 py-2 tabular-nums font-semibold">
                      {fmt(r.rivalry_score, 1)}
                    </td>
                  </tr>
                );
              })}
              {rivalries.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-stone-400 italic">
                    No matchup data yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Dossier({
  rivalry,
  colorMap,
}: {
  rivalry: Rivalry;
  colorMap: Map<string, string>;
}) {
  const r = rivalry;
  const aColor = colorMap.get(r.a_id) ?? "";
  const bColor = colorMap.get(r.b_id) ?? "";

  return (
    <section className="mb-12 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6">
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <h2 className="text-2xl font-semibold">
          <span className={aColor}>{r.a_name}</span>
          <span className="text-stone-400 mx-2 text-lg font-normal">vs</span>
          <span className={bColor}>{r.b_name}</span>
        </h2>
        <Link
          href="/fantasy/rivalries"
          className="text-xs text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
        >
          Clear ✕
        </Link>
      </div>
      <p className="text-sm text-stone-500 mb-5">
        Heat score{" "}
        <span className="font-semibold text-stone-700 dark:text-stone-200">
          {fmt(r.rivalry_score, 1)}
        </span>{" "}
        across {r.games_played} game{r.games_played === 1 ? "" : "s"}.
      </p>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="All-Time Record">
          <span className={aColor}>{r.a_wins}</span>
          <span className="text-stone-400 mx-1">–</span>
          <span className={bColor}>{r.b_wins}</span>
          {r.ties > 0 && (
            <>
              <span className="text-stone-400 mx-1">–</span>
              <span className="text-stone-500">{r.ties}T</span>
            </>
          )}
        </Stat>
        <Stat label="Avg Points">
          <span className={aColor}>{fmt(r.a_total_points / r.games_played, 1)}</span>
          <span className="text-stone-400 mx-1">/</span>
          <span className={bColor}>{fmt(r.b_total_points / r.games_played, 1)}</span>
        </Stat>
        <Stat label="Close Games">
          {r.close_games}
          <span className="text-stone-400 text-xs font-normal ml-1">(≤10 pts)</span>
        </Stat>
        <Stat label="Playoff Meetings">{r.playoff_games > 0 ? r.playoff_games : "—"}</Stat>
        <Stat label="Trades Exchanged">{r.trades_exchanged > 0 ? r.trades_exchanged : "—"}</Stat>
        <Stat label="Avg Margin">
          <span className={r.avg_margin >= 0 ? aColor : bColor}>
            {r.avg_margin >= 0 ? "+" : ""}
            {fmt(r.avg_margin, 2)}
          </span>
        </Stat>
        {r.biggest_blowout && (
          <Stat label="Biggest Blowout">
            <GameSummary g={r.biggest_blowout} r={r} aColor={aColor} bColor={bColor} />
          </Stat>
        )}
        {r.closest_game && (
          <Stat label="Closest Game">
            <GameSummary g={r.closest_game} r={r} aColor={aColor} bColor={bColor} />
          </Stat>
        )}
      </dl>

      <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500 mb-2">
        Every meeting
      </h3>
      <div className="overflow-x-auto rounded border border-stone-200 dark:border-stone-800">
        <table className="min-w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-900/50">
            <tr>
              <th className="text-left  px-3 py-2 font-medium">Year</th>
              <th className="text-left  px-3 py-2 font-medium">Week</th>
              <th className={`text-right px-3 py-2 font-medium ${aColor}`}>{r.a_name}</th>
              <th className={`text-right px-3 py-2 font-medium ${bColor}`}>{r.b_name}</th>
              <th className="text-right px-3 py-2 font-medium">Margin</th>
              <th className="text-left  px-3 py-2 font-medium">Winner</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
            {r.games.map((g, i) => {
              const margin = Math.abs(g.a_points - g.b_points);
              const winnerName =
                g.winner === "A" ? r.a_name : g.winner === "B" ? r.b_name : "Tie";
              const winnerColor =
                g.winner === "A" ? aColor : g.winner === "B" ? bColor : "text-stone-400";
              return (
                <tr key={i}>
                  <td className="px-3 py-2 text-stone-500">{g.season}</td>
                  <td className="px-3 py-2 text-stone-500">
                    {g.week}
                    {g.is_playoff && (
                      <span className="ml-1.5 inline-block rounded bg-amber-100 dark:bg-amber-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        Playoff
                      </span>
                    )}
                  </td>
                  <td
                    className={`text-right px-3 py-2 tabular-nums ${
                      g.winner === "A" ? "font-semibold" : "text-stone-500"
                    }`}
                  >
                    {fmt(g.a_points, 2)}
                  </td>
                  <td
                    className={`text-right px-3 py-2 tabular-nums ${
                      g.winner === "B" ? "font-semibold" : "text-stone-500"
                    }`}
                  >
                    {fmt(g.b_points, 2)}
                  </td>
                  <td className="text-right px-3 py-2 tabular-nums text-stone-500">
                    {fmt(margin, 2)}
                  </td>
                  <td className={`px-3 py-2 font-medium ${winnerColor}`}>{winnerName}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-800 bg-stone-50/60 dark:bg-stone-950/40 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-stone-500 mb-0.5">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function GameSummary({
  g,
  r,
  aColor,
  bColor,
}: {
  g: RivalryGame;
  r: Rivalry;
  aColor: string;
  bColor: string;
}) {
  const margin = Math.abs(g.a_points - g.b_points);
  return (
    <span className="text-sm font-normal">
      <span className={g.winner === "A" ? aColor : "text-stone-500"}>{fmt(g.a_points, 1)}</span>
      <span className="text-stone-400 mx-1">–</span>
      <span className={g.winner === "B" ? bColor : "text-stone-500"}>{fmt(g.b_points, 1)}</span>
      <span className="text-stone-400 text-xs ml-1.5">
        ({fmt(margin, 1)}, {g.season} W{g.week})
      </span>
    </span>
  );
}
