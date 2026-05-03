import { redirect } from "next/navigation";
import { hasStonksAccess, isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { OptionsTrade, EquityTrade, TradeSource } from "@/lib/types";
import { buildTickerPnL } from "@/lib/pnl";
import { buildPositions } from "@/lib/positions";
import { annotateAssignments } from "@/lib/assignment";
import { getLiveQuotes, getOpenOptionGreeks } from "@/lib/quotes";
import OptionsTable from "@/components/options-table";
import SourcePicker from "@/components/source-picker";
import SyncTradesButton from "@/components/sync-trades-button";

export const dynamic = "force-dynamic";

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export default async function OptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  if (!(await hasStonksAccess())) {
    redirect("/stonks/login");
  }

  const adminUser = await isAdmin();
  const { source: sourceParam } = await searchParams;
  const source: TradeSource = adminUser && sourceParam === "sandbox" ? "sandbox" : "prod";

  const db = getSupabase();

  const [{ data: optionsData }, { data: equityData }] = await Promise.all([
    db.from("options_trades").select("*").eq("source", source).order("order_date", { ascending: false }),
    db.from("equity_trades").select("*").eq("source", source).order("order_date", { ascending: true }),
  ]);

  const trades    = (optionsData ?? []) as OptionsTrade[];
  const equity    = (equityData  ?? []) as EquityTrade[];
  const positions = buildPositions(trades);
  annotateAssignments(positions, equity);

  const equitySymbols = [...new Set(equity.map((t) => t.symbol))];
  const openOptionSymbols = positions
    .filter((p) => p.status === "open")
    .map((p) => p.option_symbol);

  const [quotes, optionGreeks] = await Promise.all([
    source === "prod"
      ? getLiveQuotes(equitySymbols, openOptionSymbols)
      : Promise.resolve({ prices: new Map<string, number>(), available: false }),
    source === "prod"
      ? getOpenOptionGreeks(openOptionSymbols)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const pnl = buildTickerPnL(equity, positions, quotes.available ? quotes.prices : undefined);

  const pnlByTicker = new Map(pnl.map((p) => [p.ticker, p]));

  // Per-position monthly return % — same formula as watchlist:
  // (premium_collected / capital_per_share) * (30 / originalDte) * 100
  // Also accumulate totals for the open-positions summary bar.
  const positionMonthlyReturn: Record<string, number> = {};
  let openPremiumCollected = 0;
  let totalMonthlyPremiumEquiv = 0;
  let totalCapitalForPct = 0;
  for (const pos of positions) {
    if (pos.status !== "open") continue;
    openPremiumCollected += (pos.premium_collected ?? 0) * pos.quantity * 100;
    // open_date is a full ISO timestamp (order_date); expiration_date is date-only
    const open = new Date(pos.open_date);
    const exp = new Date(pos.expiration_date + "T00:00:00");
    const originalDte = Math.round((exp.getTime() - open.getTime()) / 86400000);
    if (!Number.isFinite(originalDte) || originalDte <= 0) continue;
    let capital: number | null = null;
    if (pos.strategy === "cash_secured_put") {
      capital = pos.strike;
    } else if (pos.strategy === "covered_call") {
      capital = pnlByTicker.get(pos.underlying)?.avg_cost_basis ?? null;
    }
    const premium = pos.premium_collected ?? 0;
    if (capital != null && capital > 0 && premium > 0) {
      positionMonthlyReturn[pos.option_symbol] =
        (premium / capital) * (30 / originalDte) * 100;
      totalMonthlyPremiumEquiv += (premium / originalDte * 30) * pos.quantity * 100;
      totalCapitalForPct += capital * pos.quantity * 100;
    }
  }
  const aggregateMonthlyPct = totalCapitalForPct > 0
    ? (totalMonthlyPremiumEquiv / totalCapitalForPct) * 100
    : null;

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
  const totalPL = hasUnrealized
    ? pnl.reduce((sum, p) => sum + (p.total_pl ?? p.total_realized_pl), 0)
    : null;

  const totalCapitalTiedUp = pnl.reduce((sum, p) => sum + p.total_capital_tied_up, 0);

  const openPositions = positions.filter((p) => p.status === "open");
  const totalDailyTheta = optionGreeks.size > 0
    ? openPositions.reduce((sum, pos) => {
        const theta = optionGreeks.get(pos.option_symbol);
        if (theta == null) return sum;
        const isShort = pos.strategy === "cash_secured_put" || pos.strategy === "covered_call";
        return sum + (isShort ? -1 : 1) * theta * 100 * pos.quantity;
      }, 0)
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
        <div className="flex flex-wrap items-center gap-2">
          <SourcePicker current={source} isAdmin={adminUser} />
          {adminUser && <SyncTradesButton />}
        </div>
      </div>

      {isEmpty ? (
        <p className="text-sm text-stone-500">
          No trades synced yet.
        </p>
      ) : (
        <>
          {/* Summary stats */}
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Stat
              label="Total P/L"
              value={totalPL !== null ? fmtUSD(totalPL) : fmtUSD(totalRealizedPnL)}
              highlight={
                (totalPL ?? totalRealizedPnL) >= 0 ? "green" : "red"
              }
              dim={totalPL === null}
            />
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
            <Stat
              label="Capital Tied Up"
              value={totalCapitalTiedUp > 0 ? fmtUSD(totalCapitalTiedUp) : "—"}
            />
            <Stat
              label="Daily Theta"
              value={totalDailyTheta !== null ? fmtUSD(totalDailyTheta) : "—"}
              highlight={totalDailyTheta !== null ? (totalDailyTheta >= 0 ? "green" : "red") : undefined}
              dim={totalDailyTheta === null}
            />
            <Stat label="Open Positions" value={String(openCount)} />
            <Stat label="Closed / Expired" value={String(closedCount)} />
            <Stat
              label="Win Rate"
              value={winRate !== null ? `${winRate}%` : "—"}
              highlight={winRate !== null && winRate >= 50 ? "green" : winRate !== null ? "red" : undefined}
            />
          </dl>

          {/* Open positions summary */}
          {openPositions.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                Open Positions · {openPositions.length} contract{openPositions.length !== 1 ? "s" : ""}
              </h2>
              <dl className="grid grid-cols-3 gap-3">
                <Stat
                  label="Premium Collected"
                  value={fmtUSD(openPremiumCollected)}
                  highlight={openPremiumCollected >= 0 ? "green" : "red"}
                />
                <Stat
                  label="Capital Tied Up"
                  value={totalCapitalTiedUp > 0 ? fmtUSD(totalCapitalTiedUp) : "—"}
                />
                <Stat
                  label="Avg Return"
                  value={aggregateMonthlyPct != null ? `${aggregateMonthlyPct.toFixed(2)}%/mo` : "—"}
                  highlight={
                    aggregateMonthlyPct != null
                      ? aggregateMonthlyPct >= 1 ? "green"
                      : aggregateMonthlyPct >= 0.5 ? "amber"
                      : undefined
                      : undefined
                  }
                />
              </dl>
            </section>
          )}

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
                  {p && (p.total_pl !== undefined || p.total_realized_pl !== 0) && (
                    <>
                      {/* Total P&L — prominent when live quotes available */}
                      {p.total_pl !== undefined && (
                        <span className="text-sm font-medium">
                          <span className="text-stone-500">Total P&L: </span>
                          <span className={p.total_pl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                            {fmtUSD(p.total_pl)}
                          </span>
                        </span>
                      )}
                      {/* Realized breakdown */}
                      {p.total_realized_pl !== 0 && (
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
                      {/* Unrealized breakdown */}
                      {hasUnrealized && (p.unrealized_equity_pl !== undefined || p.unrealized_options_pl !== undefined) && (
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
                    </>
                  )}
                </div>

                {tickerPositions.length > 0 ? (
                  <OptionsTable positions={tickerPositions} monthlyReturn={positionMonthlyReturn} />
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
  highlight?: "green" | "red" | "amber";
  dim?: boolean;
}) {
  const valueClass = dim
    ? "text-stone-400 dark:text-stone-600"
    : highlight === "green"
      ? "text-green-600 dark:text-green-400"
      : highlight === "red"
        ? "text-red-600 dark:text-red-400"
        : highlight === "amber"
          ? "text-amber-600 dark:text-amber-400"
          : "";

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-3">
      <dd className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</dd>
      <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">{label}</dt>
    </div>
  );
}
