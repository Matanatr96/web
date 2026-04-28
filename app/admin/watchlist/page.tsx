import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getWatchlistQuotes, getWheelOptions, isMarketOpen } from "@/lib/quotes";
import type { WatchlistItem } from "@/lib/types";
import AddTickerForm from "./add-ticker-form";
import RefreshButton from "./refresh-button";
import WatchlistView from "./watchlist-view";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    return <div className="text-red-600">Failed to load: {error.message}</div>;
  }

  const items = (data ?? []) as WatchlistItem[];
  const tickers = items.map((i) => i.ticker);

  const quotes = await getWatchlistQuotes(tickers);
  const wheelOptions = await getWheelOptions(tickers, quotes);

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin" className="hover:underline">
          ← Admin
        </Link>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Watchlist</h1>
          <p className="text-sm text-stone-500 mt-1">
            {items.length} ticker{items.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton marketOpen={isMarketOpen()} hasItems={items.length > 0} />
          <AddTickerForm />
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-stone-500 text-sm">No tickers yet. Add one above.</p>
      ) : (
        <WatchlistView items={items} quotes={quotes} wheelOptions={wheelOptions} />
      )}
    </div>
  );
}
