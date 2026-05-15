import Link from "next/link";
import { redirect } from "next/navigation";
import { hasStonksAccess, isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { OptionsTrade, EquityTrade } from "@/lib/types";
import { buildTickerPnL } from "@/lib/pnl";
import { buildPositions } from "@/lib/positions";
import { annotateAssignments } from "@/lib/assignment";
import { getLiveQuotes, getOpenOptionGreeks, getWatchlistQuotes } from "@/lib/quotes";
import { buildRollOrHoldRows } from "@/lib/roll-or-hold";
import TickerSection from "@/components/ticker-section";
import SyncTradesButton from "@/components/sync-trades-button";

export const dynamic = "force-dynamic";

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export default async function OptionsPage() {
  if (!(await hasStonksAccess())) {
    redirect("/stonks/login");
  }

  const adminUser = await isAdmin();

  const db = getSupabase();

  const [{ data: optionsData }, { data: equityData }] = await Promise.all([
    db.from("options_trades").select("*").eq("source", "prod").order("order_date", { ascending: false }),
    db.from("equity_trades").select("*").eq("source", "prod").order("order_date", { ascending: true }),
  ]);

  const trades    = (optionsData ?? []) as OptionsTrade[];
  const equity    = (equityData  ?? []) as EquityTrade[];
  const positions = buildPositions(trades);
  annotateAssignments(positions, equity);

  const equitySymbols = [...new Set(equity.map((t) => t.symbol))];
  const openOptionSymbols = positions
    .filter((p) => p.status === "open")
    .map((p) => p.option_symbol);

  // Compute underlying tickers early so we can fetch stock prices in parallel.
  const underlyingTickers = Array.from(
    new Set([...positions.map((p) => p.underlying), ...equitySymbols]),
  ).sort();

  const [quotes, optionGreeks, stockQuotes] = await Promise.all([
    getLiveQuotes(equitySymbols, openOptionSymbols),
    getOpenOptionGreeks(openOptionSymbols),
    getWatchlistQuotes(underlyingTickers),
  ]);

  const pnl = buildTickerPnL(equity, positions, quotes.available ? quotes.prices : undefined);

  const optionPrices: Record<string, number> = quotes.available
    ? Object.fromEntries(
        openOptionSymbols
          .filter((s) => quotes.prices.has(s))
          .map((s) => [s, quotes.prices.get(s)!]),
      )
    : {};

  const pnlByTicker = new Map(pnl.map((p) => [p.ticker, p]));

  // Build roll targets for positions expiring within 14 days.
  // Merge option prices + stock quotes so buildRollOrHoldRows has both.
  const capitalByTicker = new Map<string, number>(
    pnl.map((p) => [p.ticker, p.avg_cost_basis ?? 0]),
  );
  const liveMarks = new Map<string, number>([
    ...quotes.prices,
    ...[...stockQuotes.entries()]
      .filter(([, v]) => v.last != null)
      .map(([k, v]) => [k, v.last!] as [string, number]),
  ]);
  const rollRows = await buildRollOrHoldRows(positions, capitalByTicker, liveMarks);
  const rollTargetBySymbol = new Map(
    rollRows
      .filter((r) => r.best_strike ?? r.same_strike)
      .map((r) => {
        const target = r.best_strike ?? r.same_strike!;
        return [r.position.option_symbol, { strike: target.strike, dte: r.roll_dte! }];
      }),
  );

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

  // Net Premium = realized premium across closed/expired/assigned positions.
  // Open positions are excluded — their net_premium is unrealized (and for
  // longs it's intentionally negative, which would mislead the aggregate).
  const totalPremium      = positions.reduce(
    (sum, p) => p.status === "open" ? sum : sum + p.net_premium * p.quantity * 100,
    0,
  );
  const totalRealizedPnL  = pnl.reduce((sum, p) => sum + p.total_realized_pl, 0);
  const openCount         = positions.filter((p) => p.status === "open").length;
  const closedCount       = positions.filter((p) => p.status !== "open").length;
  // Assignment is a loss outcome even when net_premium (the credit kept) is positive,
  // because the equity P/L from being put/called swamps the option credit.
  const winCount          = positions.filter(
    (p) => p.status !== "open" && p.status !== "assigned" && p.net_premium > 0,
  ).length;
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
  const ccCount = openPositions.filter((p) => p.strategy === "covered_call").length;
  const cspCount = openPositions.filter((p) => p.strategy === "cash_secured_put").length;
  const nearestExpiryPos = openPositions.length > 0
    ? openPositions.reduce((nearest, pos) =>
        pos.expiration_date < nearest.expiration_date ? pos : nearest
      )
    : null;
  const nearestDTE = nearestExpiryPos
    ? Math.round((new Date(nearestExpiryPos.expiration_date + "T00:00:00").getTime() - Date.now()) / 86400000)
    : null;

  const totalDailyTheta = optionGreeks.size > 0
    ? openPositions.reduce((sum, pos) => {
        const theta = optionGreeks.get(pos.option_symbol);
        if (theta == null) return sum;
        const isShort = pos.strategy === "cash_secured_put" || pos.strategy === "covered_call";
        return sum + (isShort ? -1 : 1) * theta * 100 * pos.quantity;
      }, 0)
    : null;

  const isEmpty = positions.length === 0 && pnl.length === 0;
  // Positions where the opening leg is missing from the DB — usually because
  // /orders' current-session window dropped the open before a sync ran. Surface
  // them so the user can investigate (and add a /history backfill if needed).
  const orphans = positions.filter((p) => p.orphan_open);

  return (
    <div className="flex flex-col gap-10 max-w-5xl mx-auto px-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Options Trades</h1>
          <p className="mt-2 text-sm text-stone-500">
            Options &amp; holdings tracked from Tradier.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {adminUser && <SyncTradesButton />}
        </div>
      </div>

      {orphans.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 px-4 py-3 text-sm">
          <div className="font-semibold text-amber-800 dark:text-amber-300">
            ⚠ {orphans.length} orphan position{orphans.length !== 1 ? "s" : ""} detected
          </div>
          <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
            A closing trade exists but the opening trade is missing from the database. Usually means a sync didn&apos;t run on the day the position was opened. P/L is unknown until the open is backfilled.
          </p>
          <ul className="mt-2 text-xs text-amber-900/80 dark:text-amber-200/80 font-mono list-disc pl-5">
            {orphans.map((p) => (
              <li key={p.option_symbol}>
                {p.option_symbol} · {p.underlying} · close fill ${p.premium_paid ?? p.premium_collected}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isEmpty ? (
        <p className="text-sm text-stone-500">
          No trades synced yet.
        </p>
      ) : (
        <>
          {/* Summary stats — Scorecard Band */}
          <ScorecardBand
            totalPL={totalPL}
            totalRealizedPnL={totalRealizedPnL}
            totalUnrealizedPnL={totalUnrealizedPnL}
            winRate={winRate}
            winCount={winCount}
            closedCount={closedCount}
            totalPremium={totalPremium}
            totalDailyTheta={totalDailyTheta}
            openCount={openCount}
            openPremiumCollected={openPremiumCollected}
          />

          {/* Analytics tools */}
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 mb-3">
              Analytics
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                {
                  href: "/stonks/heatmap",
                  icon: "⬡",
                  name: "Strike Heatmap",
                  desc: "Strike distribution across open positions",
                },
                {
                  href: "/stonks/wheels",
                  icon: "🏆",
                  name: "Hall of Fame",
                  desc: "Closed wheel cycles by annualized return",
                },
                {
                  href: "/stonks/dte-oracle",
                  icon: "◎",
                  name: "DTE Oracle",
                  desc: "Median return by days-to-expiry bucket",
                },
                {
                  href: "/stonks/yield-calendar",
                  icon: "◫",
                  name: "Yield Calendar",
                  desc: "Weekly premium collected, heatmap view",
                },
                {
                  href: "/stonks/roll-or-hold",
                  icon: "⟳",
                  name: "Roll-or-Hold",
                  desc: "Roll yield vs. hold comparison for expiring positions",
                },
                {
                  href: "/stonks/premium-pace",
                  icon: "📈",
                  name: "Pace vs. SPY",
                  desc: "Your annualized return vs. SPY buy-and-hold",
                },
              ].map(({ href, icon, name, desc }) => (
                <Link
                  key={href}
                  href={href}
                  className="group flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-3 hover:border-stone-400 dark:hover:border-stone-600 transition-colors"
                >
                  <span className="text-lg leading-none">{icon}</span>
                  <span className="text-sm font-medium text-stone-800 dark:text-stone-200 group-hover:text-stone-900 dark:group-hover:text-white">
                    {name}
                  </span>
                  <span className="text-xs text-stone-500 leading-snug">{desc}</span>
                </Link>
              ))}
            </div>
          </section>

          {/* Open positions summary */}
          {openPositions.length > 0 && (
            <OpenPositionsBand
              openCount={openPositions.length}
              openPremiumCollected={openPremiumCollected}
              totalCapitalTiedUp={totalCapitalTiedUp}
              totalDailyTheta={totalDailyTheta}
              aggregateMonthlyPct={aggregateMonthlyPct}
              ccCount={ccCount}
              cspCount={cspCount}
              nearestExpiry={nearestExpiryPos}
              nearestDTE={nearestDTE}
            />
          )}

          {/* Per-ticker sections */}
          {allTickers.map((ticker) => (
            <TickerSection
              key={ticker}
              ticker={ticker}
              livePrice={stockQuotes.get(ticker)?.last ?? undefined}
              pnl={pnlByTicker.get(ticker)}
              hasUnrealized={hasUnrealized}
              positions={positions.filter((pos) => pos.underlying === ticker)}
              monthlyReturn={positionMonthlyReturn}
              optionPrices={optionPrices}
              optionGreeks={optionGreeks}
              rollTargets={rollTargetBySymbol}
            />
          ))}
        </>
      )}
    </div>
  );
}


function OpenPositionsBand({
  openCount,
  openPremiumCollected,
  totalCapitalTiedUp,
  totalDailyTheta,
  aggregateMonthlyPct,
  ccCount,
  cspCount,
  nearestExpiry,
  nearestDTE,
}: {
  openCount: number;
  openPremiumCollected: number;
  totalCapitalTiedUp: number;
  totalDailyTheta: number | null;
  aggregateMonthlyPct: number | null;
  ccCount: number;
  cspCount: number;
  nearestExpiry: { underlying: string; expiration_date: string } | null;
  nearestDTE: number | null;
}) {
  const thetaColorClass = totalDailyTheta == null
    ? "text-stone-400 dark:text-stone-600"
    : totalDailyTheta >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  const thirtyDayProjection = totalDailyTheta !== null ? totalDailyTheta * 30 : null;

  const barPct = aggregateMonthlyPct != null ? Math.min((aggregateMonthlyPct / 2) * 100, 100) : 0;
  const barColorClass = aggregateMonthlyPct == null
    ? ""
    : aggregateMonthlyPct >= 1 ? "bg-green-500"
    : aggregateMonthlyPct >= 0.5 ? "bg-amber-500"
    : "bg-stone-300 dark:bg-stone-600";
  const pctColorClass = aggregateMonthlyPct == null
    ? "text-stone-400 dark:text-stone-600"
    : aggregateMonthlyPct >= 1 ? "text-green-600 dark:text-green-400"
    : aggregateMonthlyPct >= 0.5 ? "text-amber-600 dark:text-amber-400"
    : "";

  const totalStrategies = ccCount + cspCount;
  const ccPct = totalStrategies > 0 ? (ccCount / totalStrategies) * 100 : 0;

  const dteColorClass = nearestDTE == null
    ? "text-stone-400 dark:text-stone-600"
    : nearestDTE <= 3 ? "text-red-600 dark:text-red-400"
    : nearestDTE <= 7 ? "text-amber-600 dark:text-amber-400"
    : "text-stone-500 dark:text-stone-400";

  const fmtExpDate = nearestExpiry
    ? new Date(nearestExpiry.expiration_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 mb-3">
        Open Positions · {openCount} contract{openCount !== 1 ? "s" : ""}
      </h2>
      <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 flex items-stretch divide-x divide-stone-200 dark:divide-stone-800">

        {/* Zone 1: Exposure */}
        <div className="flex-[2] px-6 py-4">
          <dd className={`text-3xl font-bold tabular-nums ${totalCapitalTiedUp > 0 ? "" : "text-stone-400 dark:text-stone-600"}`}>
            {totalCapitalTiedUp > 0 ? fmtUSD(totalCapitalTiedUp) : "—"}
          </dd>
          <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">Capital Tied Up</dt>
          <div className="mt-3 flex gap-6">
            <div>
              <div className={`text-sm font-semibold tabular-nums ${openPremiumCollected >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                {fmtUSD(openPremiumCollected)}
              </div>
              <div className="text-xs text-stone-400 mt-0.5">collected</div>
            </div>
            <div>
              <div className="text-sm font-semibold tabular-nums text-stone-600 dark:text-stone-400">
                {openCount} contract{openCount !== 1 ? "s" : ""}
              </div>
              <div className="text-xs text-stone-400 mt-0.5">open</div>
            </div>
          </div>
        </div>

        {/* Zone 2: Yield */}
        <div className="flex-[2] px-6 py-4">
          <dd className={`text-3xl font-bold tabular-nums ${thetaColorClass}`}>
            {totalDailyTheta !== null ? fmtUSD(totalDailyTheta) : "—"}
          </dd>
          <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">Daily Theta</dt>
          <div className="mt-2 relative w-32">
            <div className="h-1 rounded-full bg-stone-100 dark:bg-stone-800 overflow-hidden">
              <div className={`h-full rounded-full ${barColorClass}`} style={{ width: `${barPct}%` }} />
            </div>
            <div className="absolute top-0 h-1 w-px bg-stone-400 dark:bg-stone-500" style={{ left: "50%" }} />
          </div>
          <div className="mt-2 text-sm">
            <span className={`font-semibold tabular-nums ${pctColorClass}`}>
              {aggregateMonthlyPct != null ? `${aggregateMonthlyPct.toFixed(2)}%/mo` : "—"}
            </span>
            {thirtyDayProjection !== null && (
              <span className="text-xs text-stone-400 ml-1.5">· {fmtUSD(thirtyDayProjection)}/30d</span>
            )}
          </div>
        </div>

        {/* Zone 3: Intel */}
        <div className="flex-[1.5] px-6 py-4 flex flex-col gap-3">
          {/* CC/CSP strategy split */}
          <div>
            <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">Strategy Mix</div>
            {totalStrategies > 0 ? (
              <>
                <div className="h-1.5 rounded-full bg-stone-100 dark:bg-stone-800 overflow-hidden">
                  <div className="h-full rounded-l-full bg-blue-500" style={{ width: `${ccPct}%` }} />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-stone-500">
                  <span>{ccCount} CC</span>
                  <span>{cspCount} CSP</span>
                </div>
              </>
            ) : (
              <div className="text-sm text-stone-400">—</div>
            )}
          </div>
          <div className="border-t border-stone-200 dark:border-stone-800" />
          {/* Nearest expiry */}
          <div>
            <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">Next Up</div>
            {nearestExpiry && nearestDTE !== null ? (
              <>
                <div className="text-sm font-semibold text-stone-700 dark:text-stone-300">
                  {nearestExpiry.underlying} {fmtExpDate}
                </div>
                <div className={`text-xs font-medium tabular-nums mt-0.5 ${dteColorClass}`}>
                  {nearestDTE}d to exp
                </div>
              </>
            ) : (
              <div className="text-sm text-stone-400">—</div>
            )}
          </div>
        </div>

      </div>
    </section>
  );
}

function ScorecardBand({
  totalPL, totalRealizedPnL, totalUnrealizedPnL,
  winRate, winCount, closedCount, totalPremium,
  totalDailyTheta, openCount, openPremiumCollected,
}: {
  totalPL: number | null;
  totalRealizedPnL: number;
  totalUnrealizedPnL: number | null;
  winRate: number | null;
  winCount: number;
  closedCount: number;
  totalPremium: number;
  totalDailyTheta: number | null;
  openCount: number;
  openPremiumCollected: number;
}) {
  const displayTotal = totalPL ?? totalRealizedPnL;
  const totalDim = totalPL === null;
  const totalColorClass = displayTotal >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  const realizedColorClass = totalRealizedPnL >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  const unrealizedColorClass = totalUnrealizedPnL == null
    ? "text-stone-400 dark:text-stone-600"
    : totalUnrealizedPnL >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  const winRateColorClass = winRate == null
    ? "text-stone-400 dark:text-stone-600"
    : winRate >= 50 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  const thetaDim = totalDailyTheta === null;
  const thetaColorClass = thetaDim
    ? "text-stone-400 dark:text-stone-600"
    : totalDailyTheta! >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  const earnsBackDays = totalDailyTheta != null && totalDailyTheta > 0 && openPremiumCollected > 0
    ? Math.ceil(openPremiumCollected / totalDailyTheta)
    : null;

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 flex items-stretch divide-x divide-stone-200 dark:divide-stone-800">
      {/* Zone 1: P/L */}
      <div className="flex-[2] px-6 py-4">
        <dd className={`text-3xl font-bold tabular-nums ${totalDim ? "text-stone-400 dark:text-stone-600" : totalColorClass}`}>
          {fmtUSD(displayTotal)}
        </dd>
        <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">Total P/L</dt>
        <div className="mt-3 flex gap-6">
          <div>
            <div className={`text-sm font-semibold tabular-nums ${realizedColorClass}`}>{fmtUSD(totalRealizedPnL)}</div>
            <div className="text-xs text-stone-400 mt-0.5">Realized</div>
          </div>
          <div>
            <div className={`text-sm font-semibold tabular-nums ${unrealizedColorClass}`}>
              {totalUnrealizedPnL !== null ? fmtUSD(totalUnrealizedPnL) : "—"}
            </div>
            <div className="text-xs text-stone-400 mt-0.5">Unrealized</div>
          </div>
        </div>
      </div>

      {/* Zone 2: Track Record */}
      <div className="flex-[2] px-6 py-4">
        <dd className={`text-3xl font-bold tabular-nums ${winRateColorClass}`}>
          {winRate !== null ? `${winRate}%` : "—"}
        </dd>
        <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">Win Rate</dt>
        <div className="mt-2 h-1 rounded-full bg-stone-100 dark:bg-stone-800 overflow-hidden w-28">
          {winRate !== null && (
            <div
              className={`h-full rounded-full ${winRate >= 50 ? "bg-green-500" : "bg-red-500"}`}
              style={{ width: `${winRate}%` }}
            />
          )}
        </div>
        <div className="mt-2 text-sm">
          <span className={`font-semibold tabular-nums ${totalPremium >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
            {fmtUSD(totalPremium)}
          </span>
          <span className="text-xs text-stone-400 ml-1.5">net premium · {winCount}/{closedCount} wins</span>
        </div>
      </div>

      {/* Zone 3: Machine State */}
      <div className="flex-[1.5] px-6 py-4">
        <dd className={`text-3xl font-bold tabular-nums ${thetaColorClass}`}>
          {totalDailyTheta !== null ? fmtUSD(totalDailyTheta) : "—"}
        </dd>
        <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">Daily Theta</dt>
        <div className="mt-3 text-sm text-stone-500">
          {openCount} open
          {earnsBackDays !== null && (
            <span className="text-stone-400"> · recoups in ~{earnsBackDays}d</span>
          )}
        </div>
      </div>
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
