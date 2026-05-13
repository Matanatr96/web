import Link from "next/link";
import { redirect } from "next/navigation";
import { hasStonksAccess } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { buildPositions } from "@/lib/positions";
import { buildTickerPnL } from "@/lib/pnl";
import { fetchDatedHistoryCached } from "@/lib/quotes";
import { computePremiumPace } from "@/lib/premium-pace";
import type { EquityTrade, OptionsTrade } from "@/lib/types";

export const dynamic = "force-dynamic";

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export default async function PremiumPacePage() {
  if (!(await hasStonksAccess())) {
    redirect("/stonks/login");
  }

  const db = getSupabase();
  const [{ data: optionsData }, { data: equityData }] = await Promise.all([
    db.from("options_trades").select("*").eq("source", "prod").order("transaction_date", { ascending: true }),
    db.from("equity_trades").select("*").eq("source", "prod").order("order_date", { ascending: true }),
  ]);

  const trades = (optionsData ?? []) as OptionsTrade[];
  const equityTrades = (equityData ?? []) as EquityTrade[];

  const firstTrade = trades.find((t) => t.transaction_date != null);
  const startDate = firstTrade?.transaction_date
    ? firstTrade.transaction_date.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const today = new Date().toISOString().slice(0, 10);

  const [positions, spyHistory] = await Promise.all([
    Promise.resolve(buildPositions(trades)),
    fetchDatedHistoryCached("SPY", startDate, today),
  ]);

  const pnl = buildTickerPnL(equityTrades, positions);
  const pace = computePremiumPace(pnl, spyHistory, startDate);

  const winning = pace ? pace.deltaPct >= 0 : false;

  return (
    <div className="flex flex-col gap-8 max-w-3xl mx-auto px-4 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Premium Pace vs. SPY</h1>
          <p className="mt-2 text-sm text-stone-500 max-w-xl">
            Your annualized return (options premium + equity gains) vs. SPY buy-and-hold
            over the same period, starting from your first trade on{" "}
            <span className="font-medium text-stone-700 dark:text-stone-300">{startDate}</span>.
          </p>
        </div>
        <Link
          href="/stonks"
          className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 self-start whitespace-nowrap"
        >
          ← Back to trades
        </Link>
      </div>

      {!pace ? (
        <p className="text-sm text-stone-500">Not enough data to compute comparison yet.</p>
      ) : (
        <>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Stat
              label="Your Annualized Return"
              value={fmtPct(pace.yourReturnPct)}
              hint={`${fmtUSD(pace.totalGain)} gain on ${fmtUSD(pace.totalCapital)} capital`}
              highlight={pace.yourReturnPct >= 0 ? "green" : "red"}
            />
            <Stat
              label="SPY Annualized Return"
              value={fmtPct(pace.spyReturnPct)}
              hint={`same ${Math.round(pace.daysElapsed)}-day window`}
            />
            <Stat
              label="Your Edge"
              value={fmtPct(pace.deltaPct)}
              hint={winning ? "beating the index" : "trailing the index"}
              highlight={winning ? "green" : "red"}
            />
          </dl>

          <p className="text-xs text-stone-400">
            Your return = (options realized P&L + open premium collected + equity realized P&L) ÷ total capital tied up,
            annualized over {Math.round(pace.daysElapsed)} days.
            SPY return uses Tradier daily closing prices over the same window, annualized identically.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  highlight,
}: {
  label: string;
  value: string;
  hint?: string;
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
      {hint && <div className="text-[11px] text-stone-400 mt-0.5">{hint}</div>}
    </div>
  );
}
