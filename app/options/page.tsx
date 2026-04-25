import { getSupabase } from "@/lib/supabase";
import type { OptionsTrade, OptionsPosition, EquityTrade, TradeSource } from "@/lib/types";
import { buildTickerPnL } from "@/lib/pnl";
import { getLiveQuotes } from "@/lib/quotes";
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
    const isLong = legs.some((l) => l.side === "buy_to_open");
    const openSide  = isLong ? "buy_to_open"  : "sell_to_open";
    const closeSide = isLong ? "sell_to_close" : "buy_to_close";

    const open = legs.find((l) => l.side === openSide);
    if (!open) continue;
    const close = legs.find((l) => l.side === closeSide);

    const premiumCollected = isLong ? (close?.avg_fill_price ?? 0) : open.avg_fill_price;
    const premiumPaid      = isLong ? open.avg_fill_price : (close?.avg_fill_price ?? null);
    const netPremium       = premiumCollected - (premiumPaid ?? 0);

    let status: OptionsPosition["status"];
    if (close) {
      status = "closed";
    } else if (new Date(open.expiration_date) < today) {
      status = open.status === "assigned" ? "assigned" : "expired";
    } else {
      status = "open";
    }

    positions.push({
      underlying:        open.underlying,
      option_symbol:     symbol,
      strategy:          open.strategy,
      strike:            open.strike,
      expiration_date:   open.expiration_date,
      quantity:          open.quantity,
      premium_collected: premiumCollected,
      premium_paid:      premiumPaid,
      net_premium:       netPremium,
      status,
      open_date:  open.order_date,
      close_date: close?.order_date ?? null,
    });
  }

  positions.sort(
    (a, b) => new Date(b.open_date).getTime() - new Date(a.open_date).getTime(),
  );

  return positions;
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

  const trades    = (optionsData ?? []) as OptionsTrade[];
  const equity    = (equityData  ?? []) as EquityTrade[];
  const positions = buildPositions(trades);

  const equitySymbols = [...new Set(equity.map((t) => t.symbol))];
  const openOptionSymbols = positions
    .filter((p) => p.status === "open")
    .map((p) => p.option_symbol);

  const quotes = source === "prod"
    ? await getLiveQuotes(equitySymbols, openOptionSymbols)
    : { prices: new Map<string, number>(), available: false };

  const pnl = buildTickerPnL(equity, positions, quotes.available ? quotes.prices : undefined);

  const pnlByTicker = new Map(pnl.map((p) => [p.ticker, p]));

  // All tickers that appear in positions or have equity activity, sorted alphabetically.
  const allTickers = Array.from(
    new Set([...positions.map((p) => p.underlying), ...pnl.map((p) => p.ticker)]),
  ).sort();

  const totalPremium      = positions.reduce((sum, p) => sum + p.net_premium * p.quantity * 100, 0);
  const totalRealizedPnL  = pnl.reduce((sum, p) => sum + p.total_realized_pl, 0);
  const openCount         = positions.filter((p) => p.status === "open").length;
  const closedCount       = positions.filter((p) => p.status !== "open").length;
  const winCount          = positions.filter((p) => p.status !== "open" && p.net_premium > 0).length;
  const winRate           = closedCount > 0 ? Math.round((winCount / closedCount) * 100) : null;
  const hasUnrealized     = quotes.available;
  const totalUnrealizedPnL = hasUnrealized
    ? pnl.reduce((sum, p) => sum + (p.unrealized_equity_pl ?? 0) + (p.unrealized_options_pl ?? 0), 0)
    : null;

  const isEmpty = positions.length === 0 && pnl.length === 0;

  return (
    <div className="flex flex-col gap-10 pt-10 sm:pt-16 max-w-5xl mx-auto px-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Options Trades</h1>
          <p className="mt-2 text-sm text-stone-500">
            Options &amp; holdings tracked from Tradier.
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
          {/* Summary stats */}
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat
              label="Realized P/L"
              value={fmtUSD(totalRealizedPnL)}
              highlight={totalRealizedPnL >= 0 ? "green" : "red"}
            />
            <Stat
              label="Unrealized P/L"
              value={totalUnrealizedPnL !== null ? fmtUSD(totalUnrealizedPnL) : "—"}
              highlight={
                totalUnrealizedPnL !== null
                  ? totalUnrealizedPnL >= 0 ? "green" : "red"
                  : undefined
              }
              dim={totalUnrealizedPnL === null}
            />
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

          {/* Per-ticker sections */}
          {allTickers.map((ticker) => {
            const p = pnlByTicker.get(ticker);
            const tickerPositions = positions.filter((pos) => pos.underlying === ticker);

            return (
              <section key={ticker} className="flex flex-col gap-4">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <h2 className="text-xl font-bold tracking-tight">{ticker}</h2>
                  {p && p.shares_open > 0 && (
                    <span className="text-sm text-stone-500">
                      {p.shares_open} shares · {fmtUSD(p.avg_cost_basis)} avg cost · {fmtUSD(p.equity_total_cost)} total
                    </span>
                  )}
                  {p && (p.total_realized_pl !== 0 || p.equity_realized_pl !== 0 || p.options_realized_pl !== 0) && (
                    <span className="text-sm text-stone-500">
                      Realized:{" "}
                      <span className={p.total_realized_pl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                        {fmtUSD(p.total_realized_pl)}
                      </span>
                      <span className="text-stone-400">
                        {" "}(equity {fmtUSD(p.equity_realized_pl)} · options {fmtUSD(p.options_realized_pl)})
                      </span>
                    </span>
                  )}
                  {p && hasUnrealized && (p.unrealized_equity_pl !== undefined || p.unrealized_options_pl !== undefined) && (
                    <span className="text-sm text-stone-500">
                      Unrealized:{" "}
                      <span className={((p.unrealized_equity_pl ?? 0) + (p.unrealized_options_pl ?? 0)) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                        {fmtUSD((p.unrealized_equity_pl ?? 0) + (p.unrealized_options_pl ?? 0))}
                      </span>
                      {p.unrealized_equity_pl !== undefined && p.unrealized_options_pl !== undefined && (
                        <span className="text-stone-400">
                          {" "}(equity {fmtUSD(p.unrealized_equity_pl)} · options {fmtUSD(p.unrealized_options_pl)})
                        </span>
                      )}
                    </span>
                  )}
                </div>

                {tickerPositions.length > 0 ? (
                  <OptionsTable positions={tickerPositions} />
                ) : (
                  <p className="text-sm text-stone-400">No options activity.</p>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  dim,
}: {
  label: string;
  value: string;
  highlight?: "green" | "red";
  dim?: boolean;
}) {
  const valueClass = dim
    ? "text-stone-400 dark:text-stone-600"
    : highlight === "green"
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
