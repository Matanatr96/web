import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type {
  BracketEntry,
  FantasyLeague,
  FantasyMatchup,
  FantasyOwner,
  FantasyTrade,
} from "@/lib/types";
import {
  buildStandings,
  buildWeeklyAverages,
  mean,
  stdev,
  percentile,
  regularSeasonOnly,
  topScoringRecords,
  lowestScoringRecords,
  biggestBlowouts,
  buildTradeLeaderboard,
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
    { data: tradeData },
  ] = await Promise.all([
    db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
    db.from("fantasy_owners").select("*"),
    db.from("fantasy_matchups").select("*").order("season", { ascending: false }),
    db.from("fantasy_trades").select("*").order("created_ms", { ascending: false }),
  ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const matchups = (matchupData ?? []) as FantasyMatchup[];
  const trades = (tradeData ?? []) as FantasyTrade[];
  const tradeLeaderboard = buildTradeLeaderboard(trades, owners);

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
  const selectedLeague = leagues.find((l) => l.season === season) ?? null;

  // Standings + weekly averages use regular-season weeks only.
  const regSeasonAll = regularSeasonOnly(matchups, leagues);
  const standings = buildStandings(regSeasonAll, owners, season);
  const weekly = buildWeeklyAverages(regSeasonAll, seasons, 14);

  // Single-game records: across all seasons, regular season only.
  const topScores = topScoringRecords(regSeasonAll, owners, 10);
  const lowScores = lowestScoringRecords(regSeasonAll, owners, 10);
  const blowouts  = biggestBlowouts(regSeasonAll, owners, 10);

  // Playoff matchups for the selected season (week >= playoff_week_start).
  const playoffStart = selectedLeague?.playoff_week_start ?? 15;
  const playoffMatchups = matchups.filter(
    (m) => m.season === season && m.week >= playoffStart,
  );
  const bracket = (selectedLeague?.winners_bracket ?? null) as BracketEntry[] | null;

  // Sidebar stats: distribution of all per-owner-per-week regular-season scores.
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

      {/* All-time records */}
      <section className="mt-12 grid gap-8 md:grid-cols-2">
        <RecordsTable
          title="Top Scoring"
          rows={topScores.map((r) => ({
            year: r.season,
            week: r.week,
            owner: r.display_name,
            value: fmt(r.points, 2),
          }))}
          valueLabel="PointsFor"
        />
        <RecordsTable
          title="Lowest Scoring"
          rows={lowScores.map((r) => ({
            year: r.season,
            week: r.week,
            owner: r.display_name,
            value: fmt(r.points, 2),
          }))}
          valueLabel="PointsFor"
        />
      </section>

      <section className="mt-8">
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

      {/* Trades */}
      <section className="mt-12 grid gap-8 md:grid-cols-[1fr_280px]">
        <div>
          <h2 className="text-xl font-semibold mb-3">Trades</h2>
          {trades.length === 0 ? (
            <p className="text-sm text-stone-500">No completed trades synced.</p>
          ) : (
            <ul className="space-y-3">
              {trades.map((t) => (
                <TradeCard key={t.id} trade={t} owners={owners} />
              ))}
            </ul>
          )}
        </div>

        <aside>
          <h2 className="text-xl font-semibold mb-3">Trade Count</h2>
          <ol className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 divide-y divide-stone-200 dark:divide-stone-800">
            {tradeLeaderboard.map((row, i) => (
              <li
                key={row.owner_id}
                className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm"
              >
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="text-xs text-stone-400 tabular-nums w-5">
                    {i + 1}
                  </span>
                  <span className="font-medium truncate">{row.display_name}</span>
                </span>
                <span className="tabular-nums font-semibold">
                  {row.trade_count}
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </section>
    </div>
  );
}

function TradeCard({
  trade,
  owners,
}: {
  trade: FantasyTrade;
  owners: FantasyOwner[];
}) {
  const date = new Date(trade.created_ms).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
  const sides = trade.user_ids.map((uid) => {
    const owner = owners.find((o) => o.user_id === uid);
    return {
      uid,
      name: owner?.display_name ?? uid,
      side: trade.payload[uid] ?? { players: [], picks: [], faab: 0 },
    };
  });

  return (
    <li className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
      <div className="flex items-baseline justify-between mb-3 text-xs text-stone-500">
        <span>
          {trade.season} · Week {trade.week}
        </span>
        <span>{date}</span>
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${sides.length}, minmax(0, 1fr))` }}>
        {sides.map(({ uid, name, side }) => (
          <div key={uid}>
            <div className="font-medium text-sm mb-2">{name} received</div>
            <ul className="space-y-1 text-sm">
              {side.players.map((p) => (
                <li key={p.player_id} className="text-stone-700 dark:text-stone-300">
                  {p.name}
                  {p.position && (
                    <span className="text-xs text-stone-400 ml-1">
                      {p.position}
                      {p.team ? ` · ${p.team}` : ""}
                    </span>
                  )}
                </li>
              ))}
              {side.picks.map((pick, i) => (
                <li key={`pick-${i}`} className="text-stone-500 italic text-sm">
                  {pick.season} R{pick.round}
                  {pick.original_owner_name && pick.original_owner_id !== uid
                    ? ` (via ${pick.original_owner_name})`
                    : ""}
                </li>
              ))}
              {side.faab !== 0 && (
                <li className={`text-sm ${side.faab > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {side.faab > 0 ? "+" : ""}
                  {side.faab} FAAB
                </li>
              )}
              {side.players.length === 0 && side.picks.length === 0 && side.faab === 0 && (
                <li className="text-stone-400 text-sm italic">—</li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </li>
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

  // Score lookup: owner_id+week -> points (so we can show points next to each bracket name).
  const score = new Map<string, number>();
  for (const m of playoffMatchups) {
    score.set(`${m.owner_id}:${m.week}`, m.points);
  }

  // Sleeper round indexing: r=1 is first playoff week, etc.
  // We don't know the exact week each round maps to without more info, so
  // we render rounds vertically, biggest round first.
  if (!bracket || bracket.length === 0) {
    return (
      <p className="text-sm text-stone-500">
        No bracket data — run <code>npm run db:sync-fantasy</code> after the playoffs complete.
      </p>
    );
  }

  // Group entries by round.
  const rounds = new Map<number, BracketEntry[]>();
  for (const b of bracket) {
    const list = rounds.get(b.r) ?? [];
    list.push(b);
    rounds.set(b.r, list);
  }
  const sortedRounds = [...rounds.entries()].sort(([a], [b]) => a - b);

  // Find championship winner (entry with p === 1).
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
