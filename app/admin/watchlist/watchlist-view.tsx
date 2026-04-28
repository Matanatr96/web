"use client";

import { useState } from "react";
import { removeFromWatchlist } from "./actions";
import type { StockQuote, OptionCandidate, WheelOptions, IvData } from "@/lib/quotes";
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

// Green ≥ 1%/mo · Amber 0.5–1% · Muted < 0.5%
function premiumColor(monthly_return_pct: number): string {
  if (monthly_return_pct >= 1) return "text-green-700 dark:text-green-400";
  if (monthly_return_pct >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-stone-400";
}

// Green ratio > 1.3 · Amber 1.0–1.3 · Muted < 1.0
function ivBadgeStyle(ratio: number): string {
  if (ratio > 1.3) return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (ratio >= 1.0) return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400";
}

function IvBadge({ iv }: { iv: IvData }) {
  return (
    <span
      className={`text-xs font-medium px-1.5 py-0.5 rounded ${ivBadgeStyle(iv.ratio)}`}
      title={`IV: ${iv.current.toFixed(0)}% · HV30: ${iv.hv30.toFixed(0)}% · Ratio: ${iv.ratio.toFixed(2)}×`}
    >
      IV {iv.current.toFixed(0)}%
    </span>
  );
}

function OptionRow({ opt, type }: { opt: OptionCandidate; type: Mode }) {
  const perContract = (opt.bid * 100).toFixed(0);
  const perContractMid = (opt.mid * 100).toFixed(0);
  const deltaStr = opt.delta != null ? opt.delta.toFixed(2) : "—";
  const label = type === "puts" ? "CSP" : "CC";
  const color = premiumColor(opt.monthly_return_pct);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5 border-t border-stone-100 dark:border-stone-800 text-sm">
      <span className="text-xs font-medium text-stone-400 uppercase tracking-wide w-7">{label}</span>
      <span className="tabular-nums font-medium">{fmtPrice(opt.strike)}</span>
      <span
        className={`tabular-nums font-medium ${color}`}
        title={`$${opt.bid.toFixed(2)} bid · $${perContractMid}/contract mid · ${opt.monthly_return_pct.toFixed(2)}%/mo`}
      >
        ${perContract}/contract
        <span className="ml-1.5 text-xs font-normal opacity-75">{opt.monthly_return_pct.toFixed(2)}%/mo</span>
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
      <div className="flex items-center justify-between gap-4 px-4 py-3 bg-stone-50 dark:bg-stone-900">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-bold text-base tracking-wide">{item.ticker}</span>
          <span className="tabular-nums font-medium">{fmtPrice(quote?.last)}</span>
          <ChangeCell change={quote?.change ?? null} pct={quote?.change_percentage ?? null} />
          {options?.iv && <IvBadge iv={options.iv} />}
        </div>
        <form action={removeAction}>
          <button
            type="submit"
            onClick={(e) => { if (!confirm(`Remove ${item.ticker} from watchlist?`)) e.preventDefault(); }}
            className="text-xs text-stone-400 hover:text-red-500 transition-colors shrink-0"
          >
            Remove
          </button>
        </form>
      </div>

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
