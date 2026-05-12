import Link from "next/link";
import { redirect } from "next/navigation";
import { hasStonksAccess, isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { OptionsTrade, TradeSource } from "@/lib/types";
import { buildHeatmapPoints } from "@/lib/strike-heatmap";
import StrikeHeatmap from "@/components/strike-heatmap";

export const dynamic = "force-dynamic";

export default async function HeatmapPage({
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
  const { data: optionsData } = await db
    .from("options_trades")
    .select("*")
    .eq("source", source)
    .order("order_date", { ascending: false });

  const trades = (optionsData ?? []) as OptionsTrade[];
  const points = await buildHeatmapPoints(trades);

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto px-4 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Strike Heatmap</h1>
          <p className="mt-2 text-sm text-stone-500 max-w-2xl">
            Every closed option, plotted by how much cushion the strike had at open vs. how
            far the underlying actually moved toward ITM. Points above the diagonal blew
            through their starting cushion.
          </p>
        </div>
        <Link
          href={`/stonks${source === "sandbox" ? "?source=sandbox" : ""}`}
          className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 self-start"
        >
          ← Back to trades
        </Link>
      </div>

      {points.length === 0 ? (
        <p className="text-sm text-stone-500">
          No closed positions yet. Once trades expire, get assigned, or are closed, they&apos;ll
          appear here.
        </p>
      ) : (
        <StrikeHeatmap points={points} />
      )}
    </div>
  );
}
