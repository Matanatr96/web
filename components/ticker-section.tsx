"use client";

import { useState } from "react";
import type { TickerPnL, OptionsPosition } from "@/lib/types";
import OptionsTable from "@/components/options-table";

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export default function TickerSection({
  ticker,
  livePrice,
  pnl: p,
  hasUnrealized,
  positions,
  monthlyReturn,
  optionPrices,
}: {
  ticker: string;
  livePrice?: number;
  pnl?: TickerPnL;
  hasUnrealized: boolean;
  positions: OptionsPosition[];
  monthlyReturn: Record<string, number>;
  optionPrices: Record<string, number>;
}) {
  const [statusFilter, setStatusFilter] = useState("");

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-xl font-bold tracking-tight">{ticker}</h2>
          {livePrice != null && (
            <span className="text-sm font-medium text-stone-500">{fmtUSD(livePrice)}</span>
          )}
          {p && p.shares_open > 0 && (
            <span className="text-sm text-stone-500">
              {p.shares_open} shares · {fmtUSD(p.avg_cost_basis)} avg cost · {fmtUSD(p.equity_total_cost)} total
            </span>
          )}
          {p?.total_pl !== undefined && (
            <span className="text-sm font-medium">
              <span className="text-stone-500">Total P&L: </span>
              <span className={p.total_pl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                {fmtUSD(p.total_pl)}
              </span>
            </span>
          )}
          {p && p.total_realized_pl !== 0 && (
            <span className="text-sm text-stone-500">
              Realized:{" "}
              <span className={p.total_realized_pl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                {fmtUSD(p.total_realized_pl)}
              </span>
              <span className="text-stone-400">
                {" "}(equity {fmtUSD(p.equity_realized_pl)} · options {fmtUSD(p.options_realized_pl)})
              </span>
            </span>
          )}
          {p && hasUnrealized && (p.unrealized_equity_pl !== undefined || p.unrealized_options_pl !== undefined) && (
            <span className="text-sm text-stone-500">
              Unrealized:{" "}
              <span className={((p.unrealized_equity_pl ?? 0) + (p.unrealized_options_pl ?? 0)) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                {fmtUSD((p.unrealized_equity_pl ?? 0) + (p.unrealized_options_pl ?? 0))}
              </span>
              {p.unrealized_equity_pl !== undefined && p.unrealized_options_pl !== undefined && (
                <span className="text-stone-400">
                  {" "}(equity {fmtUSD(p.unrealized_equity_pl)} · options {fmtUSD(p.unrealized_options_pl)})
                </span>
              )}
            </span>
          )}
        </div>

        {positions.length > 0 && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="shrink-0 px-2 py-1 text-xs rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-600 dark:text-stone-400"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="expired">Expired</option>
            <option value="assigned">Assigned</option>
          </select>
        )}
      </div>

      {positions.length > 0 ? (
        <OptionsTable
          positions={positions}
          monthlyReturn={monthlyReturn}
          optionPrices={optionPrices}
          statusFilter={statusFilter}
        />
      ) : (
        <p className="text-sm text-stone-400">No options activity.</p>
      )}
    </section>
  );
}
