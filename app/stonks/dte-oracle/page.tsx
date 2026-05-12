import Link from "next/link";
import { redirect } from "next/navigation";
import { hasStonksAccess, isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { EquityTrade, OptionsTrade, TradeSource } from "@/lib/types";
import { buildPositions } from "@/lib/positions";
import {
  buildWheelCycles,
  bucketCyclesByDte,
  findSweetSpot,
  type DteBucket,
} from "@/lib/wheels";

export const dynamic = "force-dynamic";

const MIN_TRADES = 3;

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function signedPct(n: number) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

export default async function DteOraclePage({
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
  const buckets = bucketCyclesByDte(cycles);
  const sweetSpot = findSweetSpot(buckets, MIN_TRADES);

  // Determine the bar-chart scale: use the largest absolute median across
  // meaningful buckets so the chart isn't blown out by a single 2-trade outlier.
  const meaningfulMedians = buckets
    .filter((b) => b.count >= MIN_TRADES)
    .map((b) => Math.abs(b.median_annualized));
  const scaleMax = Math.max(0.01, ...meaningfulMedians);

  const totalCycles = cycles.length;

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto px-4 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">DTE Oracle</h1>
          <p className="mt-2 text-sm text-stone-500 max-w-2xl">
            Closed wheel cycles bucketed by the days-to-expiration on the
            originating cash-secured put. Bars show median annualized return —
            the DTE windows where your wheels actually earn their keep.
          </p>
        </div>
        <Link
          href={`/stonks${source === "sandbox" ? "?source=sandbox" : ""}`}
          className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 self-start whitespace-nowrap"
        >
          ← Back to trades
        </Link>
      </div>

      {totalCycles === 0 ? (
        <p className="text-sm text-stone-500">
          No completed wheel cycles yet. Once a CSP gets assigned and the shares
          are called away or sold, the wheel will show up here.
        </p>
      ) : (
        <>
          <SweetSpotCallout sweetSpot={sweetSpot} totalCycles={totalCycles} />

          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-5 sm:px-6">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                Median annualized return by DTE bucket
              </h2>
              <span className="text-xs text-stone-400">
                {totalCycles} cycle{totalCycles === 1 ? "" : "s"} · grayed = &lt; {MIN_TRADES} trades
              </span>
            </div>
            <div className="flex flex-col gap-2.5">
              {buckets.map((b) => (
                <BucketBar key={b.key} bucket={b} scaleMax={scaleMax} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SweetSpotCallout({
  sweetSpot,
  totalCycles,
}: {
  sweetSpot: ReturnType<typeof findSweetSpot>;
  totalCycles: number;
}) {
  if (!sweetSpot) {
    return (
      <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/50 px-4 py-3 text-sm text-stone-500">
        Not enough closed cycles yet to call a sweet spot — need at least two
        DTE buckets with {MIN_TRADES}+ trades each. So far: {totalCycles} cycle
        {totalCycles === 1 ? "" : "s"}.
      </div>
    );
  }
  const { bestBucket, worstBucket, ratio, deltaPct } = sweetSpot;
  const haveRatio = ratio > 0 && Number.isFinite(ratio);
  const comparison = haveRatio
    ? `return ${ratio.toFixed(1)}× more on an annualized basis than your ${worstBucket.label.replace(" DTE", "")} wheels`
    : `beat your ${worstBucket.label.replace(" DTE", "")} wheels by ${signedPct(deltaPct)} on an annualized basis`;

  return (
    <div className="rounded-lg border border-green-200/70 dark:border-green-900/50 bg-green-50/60 dark:bg-green-950/30 px-4 py-3">
      <p className="text-sm text-stone-800 dark:text-stone-100">
        <span className="font-semibold">Sweet spot: </span>
        Your {bestBucket.label.replace(" DTE", "")} DTE wheels {comparison}
        {" "}({fmtPct(bestBucket.median_annualized)} vs {fmtPct(worstBucket.median_annualized)} median annualized).
      </p>
    </div>
  );
}

function BucketBar({ bucket, scaleMax }: { bucket: DteBucket; scaleMax: number }) {
  const isMeaningful = bucket.count >= MIN_TRADES;
  const value = bucket.median_annualized;
  const widthPct = scaleMax > 0
    ? Math.min(100, (Math.abs(value) / scaleMax) * 100)
    : 0;
  const isPositive = value >= 0;

  // Bar color: green for positive meaningful, red for negative meaningful,
  // gray for low-sample buckets.
  const barColor = !isMeaningful
    ? "bg-stone-200 dark:bg-stone-800"
    : isPositive
      ? "bg-green-500/80 dark:bg-green-500/70"
      : "bg-red-500/80 dark:bg-red-500/70";

  const labelColor = isMeaningful ? "text-stone-700 dark:text-stone-200" : "text-stone-400 dark:text-stone-500";
  const valueColor = !isMeaningful
    ? "text-stone-400 dark:text-stone-500"
    : isPositive
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400";

  return (
    <div className="grid grid-cols-[6.5rem_1fr_7rem] sm:grid-cols-[7.5rem_1fr_8rem] items-center gap-3">
      <div className={`text-sm font-medium tabular-nums ${labelColor}`}>
        {bucket.label}
      </div>
      <div className="relative h-7 rounded bg-stone-100 dark:bg-stone-950/40">
        {bucket.count > 0 && widthPct > 0 && (
          <div
            className={`absolute top-0 bottom-0 left-0 rounded ${barColor} transition-[width]`}
            style={{ width: `${widthPct}%` }}
          />
        )}
      </div>
      <div className="flex items-baseline justify-end gap-2 text-sm tabular-nums">
        <span className={`font-semibold ${valueColor}`}>
          {bucket.count === 0 ? "—" : signedPct(value)}
        </span>
        <span className="text-xs text-stone-400">
          n={bucket.count}
        </span>
      </div>
    </div>
  );
}
