"use client";

import { useState } from "react";
import { removeFromWatchlist } from "./actions";
import type { StockQuote, OptionCandidate, WheelOptions } from "@/lib/quotes";
import type { WatchlistItem } from "@/lib/types";

type Props = {
  items: WatchlistItem[];
  quotes: Map<string, StockQuote>;
  wheelOptions: Map<string, WheelOptions>;
};

type Mode = "puts" | "calls";

function fmtPrice(v: number | null | undefined) {
  if (v == null) return "—";
  return `$${v.toFixed(2)}`;
}

function ChangeCell({ change, pct }: { change: number | null; pct: number | null }) {
  if (change == null || pct == null) return <span className="text-stone-400 text-sm">—</span>;
  const pos = change >= 0;
  const sign = pos ? "+" : "";
  return (
    <span className={`text-sm tabular-nums ${pos ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
      {sign}{change.toFixed(2)} ({sign}{pct.toFixed(2)}%)
    </span>
  );
}

function OptionRow({ opt, type }: { opt: OptionCandidate; type: Mode }) {
  const perContract = (opt.bid * 100).toFixed(0);
  const perContractMid = (opt.mid * 100).toFixed(0);
  const deltaStr = opt.delta != null ? opt.delta.toFixed(2) : "—";
  const label = type === "puts" ? "CSP" : "CC";

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5 border-t border-stone-100 dark:border-stone-800 text-sm">
      <span className="text-xs font-medium text-stone-400 uppercase tracking-wide w-7">{label}</span>
      <span className="tabular-nums font-medium">{fmtPrice(opt.strike)}</span>
      <span
        className="tabular-nums text-green-700 dark:text-green-400 font-medium"
        title={`$${opt.bid.toFixed(2)} bid · $${perContractMid}/contract mid`}
      >
        ${perContract}/contract
      </span>
      <span className="tabular-nums text-stone-500">Δ {deltaStr}</span>
      <span className="tabular-nums text-stone-500">{opt.dte}d</span>
      <span className="tabular-nums text-stone-400">{opt.otm_pct.toFixed(1)}% OTM</span>
    </div>
  );
}

function TickerCard({
  item,
  quote,
  options,
  mode,
}: {
  item: WatchlistItem;
  quote: StockQuote | undefined;
  options: WheelOptions | undefined;
  mode: Mode;
}) {
  const removeAction = removeFromWatchlist.bind(null, item.id);
  const rows = mode === "puts" ? options?.puts : options?.calls;

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-4 py-3 bg-stone-50 dark:bg-stone-900">
        <div className="flex items-center gap-4">
          <span className="font-bold text-base tracking-wide">{item.ticker}</span>
          <span className="tabular-nums font-medium">{fmtPrice(quote?.last)}</span>
          <ChangeCell change={quote?.change ?? null} pct={quote?.change_percentage ?? null} />
        </div>
        <form action={removeAction}>
          <button
            type="submit"
            onClick={(e) => { if (!confirm(`Remove ${item.ticker} from watchlist?`)) e.preventDefault(); }}
            className="text-xs text-stone-400 hover:text-red-500 transition-colors"
          >
            Remove
          </button>
        </form>
      </div>

      {/* Option rows */}
      {rows && rows.length > 0 ? (
        rows.map((opt) => <OptionRow key={opt.strike} opt={opt} type={mode} />)
      ) : (
        <div className="px-4 py-3 text-sm text-stone-400 border-t border-stone-100 dark:border-stone-800">
          No {mode === "puts" ? "put" : "call"} data available
        </div>
      )}
    </div>
  );
}

export default function WatchlistView({ items, quotes, wheelOptions }: Props) {
  const [mode, setMode] = useState<Mode>("puts");

  return (
    <div>
      {/* Toggle */}
      <div className="inline-flex rounded-md border border-stone-200 dark:border-stone-700 overflow-hidden mb-6">
        {(["puts", "calls"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-1.5 text-sm capitalize transition-colors ${
              mode === m
                ? "bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900"
                : "hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-400"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <TickerCard
            key={item.id}
            item={item}
            quote={quotes.get(item.ticker)}
            options={wheelOptions.get(item.ticker)}
            mode={mode}
          />
        ))}
      </div>
    </div>
  );
}
