import Link from "next/link";
import { redirect } from "next/navigation";
import { hasStonksAccess, isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { EquityTrade, OptionsTrade, TradeSource } from "@/lib/types";
import { buildPositions } from "@/lib/positions";
import { buildTickerPnL } from "@/lib/pnl";
import { getLiveQuotes } from "@/lib/quotes";
import { buildRollOrHoldRows, type RollOrHoldRow, type RollOption } from "@/lib/roll-or-hold";

export const dynamic = "force-dynamic";

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtPct(n: number, decimals = 2) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}%`;
}

function fmtDate(iso: string) {
  const [, mm, dd] = iso.split("-");
  return `${mm}/${dd}`;
}

function strategyLabel(s: string) {
  return s === "cash_secured_put" ? "CSP" : s === "covered_call" ? "CC" : s;
}

export default async function RollOrHoldPage({
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

  const trades = (optionsData ?? []) as OptionsTrade[];
  const equity = (equityData ?? []) as EquityTrade[];
  const positions = buildPositions(trades);
  const pnl = buildTickerPnL(equity, positions);

  const openOptionSymbols = positions
    .filter((p) => p.status === "open")
    .map((p) => p.option_symbol);

  const quotes = source === "prod"
    ? await getLiveQuotes([], openOptionSymbols)
    : { prices: new Map<string, number>(), available: false };

  // Capital per ticker: CSP uses strike, CC uses avg cost basis.
  const capitalByTicker = new Map<string, number>(
    pnl.map((p) => [p.ticker, p.avg_cost_basis ?? 0]),
  );

  const rows = await buildRollOrHoldRows(positions, capitalByTicker, quotes.prices);

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto px-4 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Roll-or-Hold Advisor</h1>
          <p className="mt-2 text-sm text-stone-500 max-w-2xl">
            Open positions expiring within 14 days. Compares holding to expiry against rolling
            at the same strike or the delta-25 target on the next cycle.
          </p>
        </div>
        <Link
          href={`/stonks${source === "sandbox" ? "?source=sandbox" : ""}`}
          className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 self-start whitespace-nowrap"
        >
          ← Back to trades
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/50 px-4 py-6 text-sm text-stone-500">
          No open positions expiring within the next 14 days. Check back closer to expiration.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((row) => (
            <PositionCard key={row.position.option_symbol} row={row} markAvailable={quotes.available} />
          ))}
        </div>
      )}
    </div>
  );
}

function verdict(row: RollOrHoldRow): "hold" | "same" | "best" | null {
  const holdPct = holdMonthlyReturn(row);
  if (holdPct == null && !row.same_strike && !row.best_strike) return null;

  const options: Array<{ key: "hold" | "same" | "best"; pct: number }> = [];
  if (holdPct != null) options.push({ key: "hold", pct: holdPct });
  if (row.same_strike?.monthly_return_pct != null)
    options.push({ key: "same", pct: row.same_strike.monthly_return_pct });
  if (row.best_strike?.monthly_return_pct != null)
    options.push({ key: "best", pct: row.best_strike.monthly_return_pct });

  if (options.length === 0) return null;
  return options.reduce((a, b) => (a.pct >= b.pct ? a : b)).key;
}

function holdMonthlyReturn(row: RollOrHoldRow): number | null {
  const { position, capital } = row;
  if (!capital) return null;
  const open = new Date(position.open_date);
  const exp = new Date(position.expiration_date + "T00:00:00");
  const originalDte = Math.round((exp.getTime() - open.getTime()) / 86_400_000);
  if (originalDte <= 0) return null;
  const premium = position.premium_collected ?? 0;
  return (premium / capital) * (30 / originalDte) * 100;
}

function PositionCard({ row, markAvailable }: { row: RollOrHoldRow; markAvailable: boolean }) {
  const { position, dte_remaining, capital, current_mark, roll_expiration, roll_dte } = row;
  const win = verdict(row);
  const holdPct = holdMonthlyReturn(row);

  const dteColor =
    dte_remaining === 0
      ? "text-red-600 dark:text-red-400"
      : dte_remaining <= 3
        ? "text-amber-600 dark:text-amber-400"
        : "text-stone-600 dark:text-stone-400";

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 border-b border-stone-100 dark:border-stone-800">
        <span className="text-base font-bold text-stone-900 dark:text-stone-100">
          {position.underlying}
        </span>
        <span className="text-xs font-medium uppercase tracking-wide text-stone-400">
          {strategyLabel(position.strategy)}
        </span>
        <span className="text-sm text-stone-600 dark:text-stone-400">
          ${position.strike} strike
        </span>
        <span className="text-sm text-stone-500">
          exp {fmtDate(position.expiration_date)}
        </span>
        <span className={`text-sm font-semibold tabular-nums ${dteColor}`}>
          {dte_remaining === 0 ? "expires today" : `${dte_remaining}d left`}
        </span>
        {markAvailable && current_mark != null && (
          <span className="text-xs text-stone-400 tabular-nums ml-auto">
            mark {fmtUSD(current_mark)} · collected {fmtUSD(position.premium_collected ?? 0)}
          </span>
        )}
      </div>

      {/* Three-column comparison */}
      <div className="grid grid-cols-3 divide-x divide-stone-100 dark:divide-stone-800">
        <ComparisonCol
          label="Hold to expiry"
          sublabel={`original ${fmtDate(position.expiration_date)}`}
          badge={win === "hold" ? "best" : undefined}
          monthlyReturn={holdPct}
          detail={holdPct != null ? `${fmtUSD((position.premium_collected ?? 0) * position.quantity * 100)} collected` : undefined}
          netCredit={null}
        />
        <ComparisonCol
          label="Roll same strike"
          sublabel={roll_expiration ? `→ ${fmtDate(roll_expiration)} (${roll_dte}d)` : "no data"}
          badge={win === "same" ? "best" : undefined}
          monthlyReturn={row.same_strike?.monthly_return_pct ?? null}
          detail={row.same_strike ? `bid ${fmtUSD(row.same_strike.bid)} · $${row.same_strike.strike} strike` : undefined}
          netCredit={row.same_strike?.net_credit ?? null}
          markAvailable={markAvailable}
        />
        <ComparisonCol
          label="Roll Δ-25 strike"
          sublabel={
            row.best_strike
              ? `$${row.best_strike.strike} ${row.best_strike.delta != null ? `Δ${row.best_strike.delta.toFixed(2)}` : ""}`
              : roll_expiration ? `→ ${fmtDate(roll_expiration)}` : "no data"
          }
          badge={win === "best" ? "best" : undefined}
          monthlyReturn={row.best_strike?.monthly_return_pct ?? null}
          detail={row.best_strike ? `bid ${fmtUSD(row.best_strike.bid)} · $${row.best_strike.strike} strike` : undefined}
          netCredit={row.best_strike?.net_credit ?? null}
          markAvailable={markAvailable}
        />
      </div>
    </div>
  );
}

function ComparisonCol({
  label,
  sublabel,
  badge,
  monthlyReturn,
  detail,
  netCredit,
  markAvailable,
}: {
  label: string;
  sublabel: string;
  badge?: "best";
  monthlyReturn: number | null;
  detail?: string;
  netCredit?: number | null;
  markAvailable?: boolean;
}) {
  const isHighlighted = badge === "best";

  return (
    <div
      className={`flex flex-col gap-1.5 px-4 py-4 ${
        isHighlighted
          ? "bg-green-50/60 dark:bg-green-950/20"
          : ""
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {label}
        </span>
        {isHighlighted && (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/40 px-1.5 py-0.5 rounded">
            best
          </span>
        )}
      </div>

      <p className="text-[11px] text-stone-400 dark:text-stone-500 leading-none">{sublabel}</p>

      <div className="mt-1">
        {monthlyReturn != null ? (
          <span
            className={`text-2xl font-bold tabular-nums ${
              monthlyReturn >= 0
                ? "text-green-600 dark:text-green-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {fmtPct(monthlyReturn)}/mo
          </span>
        ) : (
          <span className="text-2xl font-bold text-stone-300 dark:text-stone-600">—</span>
        )}
      </div>

      {netCredit != null && (
        <p className={`text-xs tabular-nums ${netCredit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {netCredit >= 0 ? "+" : ""}{fmtUSD(netCredit)}/share net {netCredit >= 0 ? "credit" : "debit"}
          {!markAvailable && <span className="text-stone-400"> (excl. close cost)</span>}
        </p>
      )}

      {detail && (
        <p className="text-xs text-stone-400 dark:text-stone-500">{detail}</p>
      )}
    </div>
  );
}
