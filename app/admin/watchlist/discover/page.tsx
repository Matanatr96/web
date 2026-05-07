import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { runDiscovery, DEFAULT_FILTERS } from "@/lib/discovery";
import DiscoverView from "./discover-view";

export const dynamic = "force-dynamic";
// Scanning ~80 tickers via Tradier (chunked) can run long.
export const maxDuration = 60;

export default async function DiscoverPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const supabase = getServiceClient();
  const { data } = await supabase.from("watchlist").select("ticker");
  const excluded = (data ?? []).map((r) => r.ticker as string);

  const candidates = await runDiscovery(excluded, DEFAULT_FILTERS);

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin/watchlist" className="hover:underline">
          ← Watchlist
        </Link>
      </nav>

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Discover</h1>
        <p className="text-sm text-stone-500 mt-1">
          Scanning {candidates.length} candidate{candidates.length === 1 ? "" : "s"} not on your watchlist · IV ratio ≥{" "}
          {DEFAULT_FILTERS.minIvRatio.toFixed(1)}× · monthly yield ≥ {DEFAULT_FILTERS.minMonthlyReturnPct}%
        </p>
      </div>

      {candidates.length === 0 ? (
        <p className="text-stone-500 text-sm">
          No tickers passed the filters right now. Try again later — IV and option premiums shift through the day.
        </p>
      ) : (
        <DiscoverView candidates={candidates} />
      )}
    </div>
  );
}
