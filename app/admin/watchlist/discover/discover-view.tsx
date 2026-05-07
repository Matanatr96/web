"use client";

import { useState, useTransition } from "react";
import { addDiscoveredTicker } from "./actions";
import type { DiscoveryCandidate } from "@/lib/discovery";

function fmtPrice(v: number | null | undefined) {
  if (v == null) return "—";
  return `$${v.toFixed(2)}`;
}

function premiumColor(monthly_return_pct: number): string {
  if (monthly_return_pct >= 1) return "text-green-700 dark:text-green-400";
  if (monthly_return_pct >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-stone-400";
}

function ivBadgeStyle(ratio: number): string {
  if (ratio > 1.3) return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (ratio >= 1.0) return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400";
}

type RowState = "idle" | "adding" | "added" | "error";

function CandidateRow({ c }: { c: DiscoveryCandidate }) {
  const [state, setState] = useState<RowState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function onAdd() {
    setState("adding");
    setMessage(null);
    startTransition(async () => {
      const res = await addDiscoveredTicker(c.ticker);
      if (res.error) {
        setState("error");
        setMessage(res.error);
      } else {
        setState("added");
      }
    });
  }

  const put = c.bestPut!;
  const perContract = (put.bid * 100).toFixed(0);

  return (
    <tr className="border-t border-stone-100 dark:border-stone-800">
      <td className="px-3 py-2.5 font-bold tracking-wide">{c.ticker}</td>
      <td className="px-3 py-2.5 text-xs text-stone-500">{c.sector}</td>
      <td className="px-3 py-2.5 tabular-nums">{fmtPrice(c.quote.last)}</td>
      <td className="px-3 py-2.5">
        {c.iv ? (
          <span
            className={`text-xs font-medium px-1.5 py-0.5 rounded ${ivBadgeStyle(c.iv.ratio)}`}
            title={`IV: ${c.iv.current.toFixed(0)}% · HV30: ${c.iv.hv30.toFixed(0)}% · Ratio: ${c.iv.ratio.toFixed(2)}×`}
          >
            {c.iv.ratio.toFixed(2)}×
          </span>
        ) : (
          <span className="text-stone-400 text-xs">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 tabular-nums text-sm">{fmtPrice(put.strike)}</td>
      <td className="px-3 py-2.5 tabular-nums text-sm">{put.dte}d</td>
      <td className={`px-3 py-2.5 tabular-nums text-sm font-medium ${premiumColor(put.monthly_return_pct)}`}>
        ${perContract}
        <span className="ml-1.5 text-xs font-normal opacity-75">{put.monthly_return_pct.toFixed(2)}%/mo</span>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-xs text-stone-500">{(c.score * 100).toFixed(0)}</td>
      <td className="px-3 py-2.5 text-right">
        {state === "added" ? (
          <span className="text-xs text-green-600 dark:text-green-400">Added ✓</span>
        ) : (
          <button
            onClick={onAdd}
            disabled={state === "adding"}
            className="text-xs px-2 py-1 rounded border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
          >
            {state === "adding" ? "Adding…" : "+ Add"}
          </button>
        )}
        {message && <div className="text-xs text-red-500 mt-1">{message}</div>}
      </td>
    </tr>
  );
}

export default function DiscoverView({ candidates }: { candidates: DiscoveryCandidate[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
      <table className="w-full text-sm">
        <thead className="bg-stone-50 dark:bg-stone-900 text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th className="px-3 py-2 text-left">Ticker</th>
            <th className="px-3 py-2 text-left">Sector</th>
            <th className="px-3 py-2 text-left">Price</th>
            <th className="px-3 py-2 text-left">IV/HV</th>
            <th className="px-3 py-2 text-left">CSP Strike</th>
            <th className="px-3 py-2 text-left">DTE</th>
            <th className="px-3 py-2 text-left">Premium</th>
            <th className="px-3 py-2 text-left">Score</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <CandidateRow key={c.ticker} c={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
