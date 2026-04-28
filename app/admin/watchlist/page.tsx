import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getWatchlistQuotes, getWheelCandidates } from "@/lib/quotes";
import type { WatchlistItem } from "@/lib/types";
import { removeFromWatchlist } from "./actions";
import DeleteButton from "../delete-button";
import AddTickerForm from "./add-ticker-form";

export const dynamic = "force-dynamic";

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${v.toFixed(2)}`;
}

function fmtChange(change: number | null | undefined, pct: number | null | undefined): React.ReactNode {
  if (change == null || pct == null) return <span className="text-stone-400">—</span>;
  const positive = change >= 0;
  const sign = positive ? "+" : "";
  return (
    <span className={positive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
      {sign}{change.toFixed(2)} ({sign}{pct.toFixed(2)}%)
    </span>
  );
}

function dash(): React.ReactNode {
  return <span className="text-stone-400">—</span>;
}

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
  const candidates = await getWheelCandidates(tickers, quotes);

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
        <AddTickerForm />
      </div>

      {items.length === 0 ? (
        <p className="text-stone-500 text-sm">No tickers yet. Add one above.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 dark:bg-stone-900 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-3 py-2">Ticker</th>
                <th className="px-3 py-2 text-right">Last</th>
                <th className="px-3 py-2 text-right">Day Change</th>
                <th className="px-3 py-2 text-right">CSP Strike</th>
                <th className="px-3 py-2 text-right">Premium</th>
                <th className="px-3 py-2 text-right">Delta</th>
                <th className="px-3 py-2 text-right">DTE</th>
                <th className="px-3 py-2 text-right">OTM%</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const q = quotes.get(item.ticker);
                const c = candidates.get(item.ticker);
                const removeAction = removeFromWatchlist.bind(null, item.id);
                return (
                  <tr
                    key={item.id}
                    className="border-t border-stone-200 dark:border-stone-800"
                  >
                    <td className="px-3 py-2 font-semibold tracking-wide">
                      {item.ticker}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtPrice(q?.last)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtChange(q?.change, q?.change_percentage)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c ? fmtPrice(c.strike) : dash()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c ? (
                        <span title={`$${c.bid.toFixed(2)} bid · $${(c.mid * 100).toFixed(0)}/contract mid`}>
                          ${(c.bid * 100).toFixed(0)}
                        </span>
                      ) : dash()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c?.delta != null ? c.delta.toFixed(2) : dash()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c ? `${c.dte}d` : dash()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-stone-500">
                      {c ? `${c.otm_pct.toFixed(1)}%` : dash()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={removeAction}>
                        <DeleteButton name={item.ticker} />
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-stone-400 mt-3">
        CSP columns show the put closest to 8% OTM on the expiration nearest to 35 DTE.
        Premium shown as bid × 100 (per contract). Hover for bid/mid detail.
      </p>
    </div>
  );
}
