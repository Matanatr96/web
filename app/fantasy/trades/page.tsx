import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { FantasyOwner, FantasyTrade } from "@/lib/types";
import { buildTradeLeaderboard, ownerColorMap } from "@/lib/fantasy";

export const dynamic = "force-dynamic";

export default async function FantasyTradesPage() {
  const db = getSupabase();

  const [{ data: ownerData }, { data: tradeData }] = await Promise.all([
    db.from("fantasy_owners").select("*"),
    db.from("fantasy_trades").select("*").order("created_ms", { ascending: false }),
  ]);

  const owners = (ownerData ?? []) as FantasyOwner[];
  const trades = (tradeData ?? []) as FantasyTrade[];
  const tradeLeaderboard = buildTradeLeaderboard(trades, owners);
  const colorMap = ownerColorMap(owners);

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
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Trades</h1>
        <p className="mt-1 text-sm text-stone-500">
          All completed trades across every season.
        </p>
      </div>

      <section className="grid gap-8 md:grid-cols-[1fr_280px]">
        <div>
          {trades.length === 0 ? (
            <p className="text-sm text-stone-500">No completed trades synced.</p>
          ) : (
            <ul className="space-y-3">
              {trades.map((t) => (
                <TradeCard key={t.id} trade={t} owners={owners} colorMap={colorMap} />
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
                  <span className={`font-medium truncate ${colorMap.get(row.owner_id) ?? ""}`}>{row.display_name}</span>
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
  colorMap,
}: {
  trade: FantasyTrade;
  owners: FantasyOwner[];
  colorMap: Map<string, string>;
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
            <div className={`font-medium text-sm mb-2 ${colorMap.get(uid) ?? ""}`}>{name} received</div>
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
