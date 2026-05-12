import Link from "next/link";
import { redirect } from "next/navigation";
import { hasStonksAccess, isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { EquityTrade, OptionsTrade, TradeSource } from "@/lib/types";
import { buildPositions } from "@/lib/positions";
import { buildWheelCycles, type WheelCycle } from "@/lib/wheels";

export const dynamic = "force-dynamic";

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export default async function WheelsPage({
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
  const cycles = buildWheelCycles(positions, equity);

  const totalProfit  = cycles.reduce((s, c) => s + c.total_profit, 0);
  const totalCapital = cycles.reduce((s, c) => s + c.capital_at_risk, 0);
  const blendedReturn = totalCapital > 0 ? totalProfit / totalCapital : 0;
  const avgAnnualized = cycles.length > 0
    ? cycles.reduce((s, c) => s + c.annualized_return, 0) / cycles.length
    : 0;

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto px-4 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wheel Hall of Fame</h1>
          <p className="mt-2 text-sm text-stone-500 max-w-2xl">
            Closed wheel cycles: each row is a cash-secured put that got assigned,
            followed by covered calls until the shares were called away or sold.
            Ranked by annualized return on the cash the CSP locked up.
          </p>
        </div>
        <Link
          href={`/stonks${source === "sandbox" ? "?source=sandbox" : ""}`}
          className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 self-start whitespace-nowrap"
        >
          ← Back to trades
        </Link>
      </div>

      {cycles.length === 0 ? (
        <p className="text-sm text-stone-500">
          No completed wheel cycles yet. A wheel completes once an assigned CSP&apos;s
          shares are either called away by a covered call or sold.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Cycles" value={String(cycles.length)} />
            <Stat
              label="Total Profit"
              value={fmtUSD(totalProfit)}
              highlight={totalProfit >= 0 ? "green" : "red"}
            />
            <Stat label="Blended Return" value={fmtPct(blendedReturn)} />
            <Stat label="Avg Annualized" value={fmtPct(avgAnnualized)} />
          </dl>

          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-stone-500 border-b border-stone-200 dark:border-stone-800">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Ticker</th>
                  <th className="py-2 pr-3">Opened</th>
                  <th className="py-2 pr-3">Closed</th>
                  <th className="py-2 pr-3 text-right">Days</th>
                  <th className="py-2 pr-3 text-right">CSP</th>
                  <th className="py-2 pr-3 text-right">Exit</th>
                  <th className="py-2 pr-3 text-right">Premium</th>
                  <th className="py-2 pr-3 text-right">Equity P/L</th>
                  <th className="py-2 pr-3 text-right">Total</th>
                  <th className="py-2 pr-3 text-right">Return</th>
                  <th className="py-2 pl-3 text-right">Annualized</th>
                </tr>
              </thead>
              <tbody>
                {cycles.map((c, i) => (
                  <CycleRow key={`${c.underlying}-${c.start_date}-${i}`} cycle={c} rank={i + 1} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function CycleRow({ cycle, rank }: { cycle: WheelCycle; rank: number }) {
  const totalClass = cycle.total_profit >= 0
    ? "text-green-600 dark:text-green-400"
    : "text-red-600 dark:text-red-400";
  const exitLabel = cycle.exit === "called_away" ? `CC @ $${cycle.exit_price}` : `Sold @ $${cycle.exit_price.toFixed(2)}`;

  return (
    <tr className="border-b border-stone-100 dark:border-stone-900 tabular-nums">
      <td className="py-2 pr-3 text-stone-400">{rank}</td>
      <td className="py-2 pr-3 font-medium">{cycle.underlying}</td>
      <td className="py-2 pr-3 text-stone-500">{cycle.start_date}</td>
      <td className="py-2 pr-3 text-stone-500">{cycle.end_date}</td>
      <td className="py-2 pr-3 text-right">{cycle.days_held}</td>
      <td className="py-2 pr-3 text-right">
        ${cycle.csp_strike}
        {cycle.quantity > 1 ? <span className="text-stone-400"> ×{cycle.quantity}</span> : null}
      </td>
      <td className="py-2 pr-3 text-right text-stone-500">{exitLabel}</td>
      <td className="py-2 pr-3 text-right">{fmtUSD(cycle.total_premium)}</td>
      <td className={`py-2 pr-3 text-right ${cycle.equity_pl >= 0 ? "" : "text-red-600 dark:text-red-400"}`}>
        {fmtUSD(cycle.equity_pl)}
      </td>
      <td className={`py-2 pr-3 text-right font-semibold ${totalClass}`}>{fmtUSD(cycle.total_profit)}</td>
      <td className="py-2 pr-3 text-right">{fmtPct(cycle.return_pct)}</td>
      <td className={`py-2 pl-3 text-right font-semibold ${cycle.annualized_return >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
        {fmtPct(cycle.annualized_return)}
      </td>
    </tr>
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
