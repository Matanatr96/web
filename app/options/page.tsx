import { getSupabase } from "@/lib/supabase";
import type { OptionsTrade, OptionsPosition, OptionStrategy, EquityTrade, CurrentHolding, TradeSource } from "@/lib/types";
import OptionsTable from "@/components/options-table";
import SourcePicker from "@/components/source-picker";

export const dynamic = "force-dynamic";

function buildPositions(trades: OptionsTrade[]): OptionsPosition[] {
  const bySymbol = new Map<string, OptionsTrade[]>();
  for (const t of trades) {
    const bucket = bySymbol.get(t.option_symbol) ?? [];
    bucket.push(t);
    bySymbol.set(t.option_symbol, bucket);
  }

  const today = new Date();
  const positions: OptionsPosition[] = [];

  for (const [symbol, legs] of bySymbol) {
    const open = legs.find((l) => l.side === "sell_to_open");
    if (!open) continue;
    const close = legs.find((l) => l.side === "buy_to_close");

    const premiumCollected = open.avg_fill_price;
    const premiumPaid = close?.avg_fill_price ?? null;
    const netPremium = premiumCollected - (premiumPaid ?? 0);

    let status: OptionsPosition["status"];
    if (close) {
      status = "closed";
    } else if (new Date(open.expiration_date) < today) {
      status = open.status === "assigned" ? "assigned" : "expired";
    } else {
      status = "open";
    }

    positions.push({
      underlying:      open.underlying,
      option_symbol:   symbol,
      strategy:        open.strategy,
      strike:          open.strike,
      expiration_date: open.expiration_date,
      quantity:        open.quantity,
      premium_collected: premiumCollected,
      premium_paid:    premiumPaid,
      net_premium:     netPremium,
      status,
      open_date:   open.order_date,
      close_date:  close?.order_date ?? null,
    });
  }

  positions.sort(
    (a, b) => new Date(b.open_date).getTime() - new Date(a.open_date).getTime(),
  );

  return positions;
}

// Compute current holdings using the average cost method.
// Orders are processed chronologically: buys add to cost basis, sells reduce shares
// while keeping the running avg cost per share.
function buildHoldings(equityTrades: EquityTrade[]): CurrentHolding[] {
  const sorted = [...equityTrades].sort(
    (a, b) => new Date(a.order_date).getTime() - new Date(b.order_date).getTime(),
  );

  const holdingMap = new Map<string, { shares: number; total_cost: number }>();

  for (const t of sorted) {
    const current = holdingMap.get(t.symbol) ?? { shares: 0, total_cost: 0 };

    if (t.side === "buy") {
      current.total_cost += t.quantity * t.avg_fill_price;
      current.shares += t.quantity;
    } else {
      // Sell: reduce shares; avg cost per share stays the same.
      const avgCost = current.shares > 0 ? current.total_cost / current.shares : 0;
      current.shares -= t.quantity;
      current.total_cost = current.shares * avgCost;
    }

    holdingMap.set(t.symbol, current);
  }

  return Array.from(holdingMap.entries())
    .filter(([, h]) => h.shares > 0)
    .map(([symbol, h]) => ({
      symbol,
      shares:         h.shares,
      avg_cost_basis: h.shares > 0 ? h.total_cost / h.shares : 0,
      total_cost:     h.total_cost,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export default async function OptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source: sourceParam } = await searchParams;
  const source: TradeSource = sourceParam === "sandbox" ? "sandbox" : "prod";

  const db = getSupabase();

  const [{ data: optionsData }, { data: equityData }] = await Promise.all([
    db.from("options_trades").select("*").eq("source", source).order("order_date", { ascending: false }),
    db.from("equity_trades").select("*").eq("source", source).order("order_date", { ascending: true }),
  ]);

  const trades   = (optionsData ?? []) as OptionsTrade[];
  const equity   = (equityData  ?? []) as EquityTrade[];
  const positions = buildPositions(trades);
  const holdings  = buildHoldings(equity);

  const totalPremium = positions.reduce(
    (sum, p) => sum + p.net_premium * p.quantity * 100,
    0,
  );
  const openCount   = positions.filter((p) => p.status === "open").length;
  const closedCount = positions.filter((p) => p.status !== "open").length;
  const winCount    = positions.filter((p) => p.status !== "open" && p.net_premium > 0).length;
  const winRate     = closedCount > 0 ? Math.round((winCount / closedCount) * 100) : null;

  const ccPositions  = positions.filter((p) => p.strategy === "covered_call"     as OptionStrategy);
  const cspPositions = positions.filter((p) => p.strategy === "cash_secured_put" as OptionStrategy);

  const isEmpty = positions.length === 0 && holdings.length === 0;

  return (
    <div className="flex flex-col gap-10 pt-10 sm:pt-16 max-w-5xl mx-auto px-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Options Trades</h1>
          <p className="mt-2 text-sm text-stone-500">
            Covered calls &amp; cash-secured puts tracked from Tradier.
          </p>
        </div>
        <SourcePicker current={source} />
      </div>

      {isEmpty ? (
        <p className="text-sm text-stone-500">
          No trades yet. Sync your Tradier account from the admin panel.
        </p>
      ) : (
        <>
          {/* Current Holdings */}
          {holdings.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold mb-3">Current Holdings</h2>
              <div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 dark:bg-stone-900 text-left text-xs uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="px-3 py-2">Ticker</th>
                      <th className="px-3 py-2 text-right">Shares</th>
                      <th className="px-3 py-2 text-right">Avg Cost Basis</th>
                      <th className="px-3 py-2 text-right">Total Cost</th>
                      <th className="px-3 py-2 text-right">Open CCs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => {
                      const openCCs = ccPositions.filter(
                        (p) => p.underlying === h.symbol && p.status === "open",
                      );

                      return (
                        <tr
                          key={h.symbol}
                          className="border-t border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900/50"
                        >
                          <td className="px-3 py-2 font-medium">{h.symbol}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{h.shares}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(h.avg_cost_basis)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(h.total_cost)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {openCCs.length > 0 ? openCCs.length : <span className="text-stone-400">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Options summary stats */}
          {positions.length > 0 && (
            <>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  label="Net Premium"
                  value={fmtUSD(totalPremium)}
                  highlight={totalPremium >= 0 ? "green" : "red"}
                />
                <Stat label="Open Positions" value={String(openCount)} />
                <Stat label="Closed / Expired" value={String(closedCount)} />
                <Stat
                  label="Win Rate"
                  value={winRate !== null ? `${winRate}%` : "—"}
                  highlight={winRate !== null && winRate >= 50 ? "green" : winRate !== null ? "red" : undefined}
                />
              </dl>

              {ccPositions.length > 0 && (
                <section>
                  <h2 className="text-lg font-semibold mb-3">Covered Calls</h2>
                  <OptionsTable positions={ccPositions} />
                </section>
              )}

              {cspPositions.length > 0 && (
                <section>
                  <h2 className="text-lg font-semibold mb-3">Cash-Secured Puts</h2>
                  <OptionsTable positions={cspPositions} />
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "green" | "red";
}) {
  const valueClass =
    highlight === "green"
      ? "text-green-600 dark:text-green-400"
      : highlight === "red"
        ? "text-red-600 dark:text-red-400"
        : "";

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-3">
      <dd className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</dd>
      <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">{label}</dt>
    </div>
  );
}
