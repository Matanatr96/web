import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { OptionsTrade, EquityTrade } from "@/lib/types";
import { buildPositions } from "@/lib/positions";
import { buildTickerPnL } from "@/lib/pnl";
import { getLiveQuotes } from "@/lib/quotes";

export const dynamic = "force-dynamic";

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export default async function StonksAdminPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const db = getSupabase();
  const [{ data: optionsData }, { data: equityData }] = await Promise.all([
    db.from("options_trades").select("*").eq("source", "prod").order("order_date", { ascending: false }),
    db.from("equity_trades").select("*").eq("source", "prod").order("order_date", { ascending: true }),
  ]);

  const trades    = (optionsData ?? []) as OptionsTrade[];
  const equity    = (equityData  ?? []) as EquityTrade[];
  const positions = buildPositions(trades);

  const equitySymbols      = [...new Set(equity.map((t) => t.symbol))];
  const openOptionSymbols  = positions.filter((p) => p.status === "open").map((p) => p.option_symbol);
  const quotes = await getLiveQuotes(equitySymbols, openOptionSymbols);

  const pnl = buildTickerPnL(equity, positions, quotes.available ? quotes.prices : undefined);

  // Leaderboard
  const pnlWithActivity = pnl.filter((p) => p.trade_count > 0 || p.csp_collateral > 0);
  const sortKey = (p: (typeof pnl)[number]) => p.total_pl ?? p.total_realized_pl;

  const mostGaining = [...pnlWithActivity].sort((a, b) => sortKey(b) - sortKey(a))[0];
  const mostLosing  = [...pnlWithActivity].sort((a, b) => sortKey(a) - sortKey(b))[0];
  const mostTraded  = [...pnl].sort((a, b) => b.trade_count - a.trade_count)[0];

  // Active positions: any ticker with equity or open CSP collateral
  const activePositions = pnl
    .filter((p) => p.total_capital_tied_up > 0)
    .sort((a, b) => b.total_capital_tied_up - a.total_capital_tied_up);

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin" className="hover:underline">
          ← Admin
        </Link>
      </nav>

      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Stonks</h1>
        <p className="text-sm text-stone-500 mt-1">Manage trades from Tradier.</p>
      </div>

      {/* Leaderboard */}
      {pnlWithActivity.length > 0 && (
        <section className="mb-10">
          <h2 className="text-lg font-semibold tracking-tight mb-3">Leaderboard</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {mostGaining && (
              <LeaderboardCard
                label="Most Gaining"
                ticker={mostGaining.ticker}
                stat={fmtUSD(sortKey(mostGaining))}
                statColor={sortKey(mostGaining) >= 0 ? "green" : "red"}
                detail={`Spent: ${fmtUSD(mostGaining.total_gross_spend)}`}
              />
            )}
            {mostLosing && mostLosing.ticker !== mostGaining?.ticker && (
              <LeaderboardCard
                label="Most Losing"
                ticker={mostLosing.ticker}
                stat={fmtUSD(sortKey(mostLosing))}
                statColor={sortKey(mostLosing) >= 0 ? "green" : "red"}
                detail={`Spent: ${fmtUSD(mostLosing.total_gross_spend)}`}
              />
            )}
            {mostTraded && (
              <LeaderboardCard
                label="Most Traded"
                ticker={mostTraded.ticker}
                stat={`${mostTraded.trade_count} trades`}
                detail={`Spent: ${fmtUSD(mostTraded.total_gross_spend)}`}
              />
            )}
          </div>
        </section>
      )}

      {/* Active positions */}
      {activePositions.length > 0 && (
        <section className="mb-10">
          <h2 className="text-lg font-semibold tracking-tight mb-3">Capital Tied Up</h2>
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 dark:bg-stone-900 text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="text-left px-4 py-2">Ticker</th>
                  <th className="text-right px-4 py-2">Equity</th>
                  <th className="text-right px-4 py-2">CSP Collateral</th>
                  <th className="text-right px-4 py-2 font-semibold">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
                {activePositions.map((p) => (
                  <tr key={p.ticker} className="bg-white dark:bg-stone-950">
                    <td className="px-4 py-2 font-medium">{p.ticker}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-stone-600 dark:text-stone-400">
                      {p.equity_total_cost > 0 ? fmtUSD(p.equity_total_cost) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-stone-600 dark:text-stone-400">
                      {p.csp_collateral > 0 ? fmtUSD(p.csp_collateral) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {fmtUSD(p.total_capital_tied_up)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-stone-50 dark:bg-stone-900 font-semibold">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtUSD(activePositions.reduce((s, p) => s + p.equity_total_cost, 0))}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtUSD(activePositions.reduce((s, p) => s + p.csp_collateral, 0))}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtUSD(activePositions.reduce((s, p) => s + p.total_capital_tied_up, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight mb-3">Export</h2>
        <p className="text-sm text-stone-500 mb-4">
          Download raw trades as CSV for manual verification.
        </p>
        <div className="flex gap-2">
          <a
            href="/api/options/export?table=options"
            className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 transition"
          >
            Options trades ↓
          </a>
          <a
            href="/api/options/export?table=equity"
            className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 transition"
          >
            Equity trades ↓
          </a>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight mb-3">View</h2>
        <Link
          href="/stonks"
          className="text-sm hover:underline text-stone-600 dark:text-stone-400"
        >
          Options &amp; trades dashboard →
        </Link>
      </section>
    </div>
  );
}

function LeaderboardCard({
  label,
  ticker,
  stat,
  statColor,
  detail,
}: {
  label: string;
  ticker: string;
  stat: string;
  statColor?: "green" | "red";
  detail: string;
}) {
  const statClass =
    statColor === "green"
      ? "text-green-600 dark:text-green-400"
      : statColor === "red"
        ? "text-red-600 dark:text-red-400"
        : "";

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-stone-500 mb-1">{label}</p>
      <p className="text-2xl font-bold tracking-tight">{ticker}</p>
      <p className={`text-lg font-semibold tabular-nums mt-0.5 ${statClass}`}>{stat}</p>
      <p className="text-xs text-stone-400 mt-1">{detail}</p>
    </div>
  );
}
