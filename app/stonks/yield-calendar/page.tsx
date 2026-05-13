import Link from "next/link";
import { redirect } from "next/navigation";
import { hasStonksAccess } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { OptionsTrade } from "@/lib/types";
import {
  buildYieldCalendar,
  premiumPercentile,
  STRATEGY_SHORT,
  type YieldWeek,
} from "@/lib/yield-calendar";
import WeekCalendar, { type WeekCell } from "@/components/week-calendar";

export const dynamic = "force-dynamic";

function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default async function YieldCalendarPage() {
  if (!(await hasStonksAccess())) {
    redirect("/stonks/login");
  }

  const db = getSupabase();
  const { data: optionsData } = await db
    .from("options_trades")
    .select("*")
    .eq("source", "prod")
    .order("order_date", { ascending: false });

  const trades = (optionsData ?? []) as OptionsTrade[];
  const weeks = buildYieldCalendar(trades, { weeks: 52 });

  const totalPremium = weeks.reduce((s, w) => s + w.premium, 0);
  const activeWeeks = weeks.filter((w) => w.premium > 0).length;
  const avgPerActive = activeWeeks > 0 ? totalPremium / activeWeeks : 0;
  const bestWeek = weeks.reduce<YieldWeek | null>(
    (best, w) => (w.premium > (best?.premium ?? -Infinity) ? w : best),
    null,
  );
  const scaleMax = premiumPercentile(weeks, 95) || totalPremium / 12 || 1;

  const cells: WeekCell[] = weeks.map((w) => ({
    isoKey: w.isoKey,
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
    value: w.premium,
    secondary: w.winRate,
    tooltip: <CellTooltip week={w} />,
  }));

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto px-4 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Premium Yield Calendar</h1>
          <p className="mt-2 text-sm text-stone-500 max-w-2xl">
            One cell per ISO week of the trailing year. Color intensity tracks the
            net premium (collected minus any buy-to-close costs) on contracts
            opened that week; the bar row beneath shows the win rate for those
            contracts (kept premium vs. assigned).
          </p>
        </div>
        <Link
          href="/stonks"
          className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 self-start whitespace-nowrap"
        >
          ← Back to trades
        </Link>
      </div>

      {totalPremium === 0 ? (
        <p className="text-sm text-stone-500">
          No sell-to-open premium collected in the last 52 weeks.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Total Premium" value={fmtUSD(totalPremium)} highlight="green" />
            <Stat label="Active Weeks" value={`${activeWeeks} / ${weeks.length}`} />
            <Stat label="Avg / Active Week" value={fmtUSD(avgPerActive)} />
            <Stat
              label="Best Week"
              value={bestWeek ? fmtUSD(bestWeek.premium) : "—"}
              hint={bestWeek ? `wk of ${bestWeek.weekStart}` : undefined}
            />
          </dl>

          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
            <WeekCalendar
              cells={cells}
              scaleMax={scaleMax}
              accent="#059669"
              legendLabel="less"
              showSecondary
              secondaryLabel="win rate"
            />
            <p className="mt-3 text-xs text-stone-500">
              Color scale tops out at the 95th-percentile week ({fmtUSD(scaleMax)}).
              Bar row: win rate for contracts opened that week, defined as
              expired-worthless or bought-to-close vs. total terminal contracts.
              Open contracts are excluded from the win-rate denominator.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function CellTooltip({ week }: { week: YieldWeek }) {
  const strategies = Object.entries(week.strategies)
    .map(([s, n]) => `${STRATEGY_SHORT[s as keyof typeof STRATEGY_SHORT] ?? s} ×${n}`)
    .join(" · ");
  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium">
        {week.weekStart} → {week.weekEnd}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-stone-500">
        <span>Premium</span>
        <span className="tabular-nums text-stone-800 dark:text-stone-200">
          {fmtUSD(week.premium)}
        </span>
        <span>Contracts</span>
        <span className="tabular-nums text-stone-800 dark:text-stone-200">
          {week.contracts}
        </span>
        <span>Win rate</span>
        <span className="tabular-nums text-stone-800 dark:text-stone-200">
          {week.winRate == null
            ? "—"
            : `${fmtPct(week.winRate)} (${week.wins}/${week.closedCount})`}
        </span>
      </div>
      {week.tickers.length > 0 && (
        <div className="mt-1">
          <div className="text-stone-500">Tickers</div>
          <div className="font-mono text-[11px] break-words">
            {week.tickers.join(", ")}
          </div>
        </div>
      )}
      {strategies && (
        <div className="mt-1">
          <div className="text-stone-500">Strategies</div>
          <div className="text-[11px]">{strategies}</div>
        </div>
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
