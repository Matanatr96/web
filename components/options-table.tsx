"use client";

import { useMemo, useState } from "react";
import type { OptionsPosition } from "@/lib/types";

type SortKey = "underlying" | "strike" | "expiration_date" | "net_premium" | "status" | "open_date";
type SortDir = "asc" | "desc";

const STATUS_LABEL: Record<OptionsPosition["status"], string> = {
  open:     "Open",
  closed:   "Closed",
  expired:  "Expired",
  assigned: "Assigned",
};

const STATUS_CLASS: Record<OptionsPosition["status"], string> = {
  open:     "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  closed:   "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400",
  expired:  "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  assigned: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

function fmtDate(iso: string) {
  return new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export default function OptionsTable({ positions }: { positions: OptionsPosition[] }) {
  const [tickerFilter, setTickerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortKey, setSortKey]  = useState<SortKey>("open_date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const tickers = useMemo(
    () => Array.from(new Set(positions.map((p) => p.underlying))).sort(),
    [positions],
  );

  const visible = useMemo(() => {
    const list = positions.filter((p) => {
      if (tickerFilter && p.underlying !== tickerFilter) return false;
      if (statusFilter && p.status !== statusFilter) return false;
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
    return list;
  }, [positions, tickerFilter, statusFilter, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(["net_premium"].includes(key) ? "desc" : "asc");
    }
  };

  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === "asc" ? "↑" : "↓") : "");

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-3">
        <select
          value={tickerFilter}
          onChange={(e) => setTickerFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        >
          <option value="">All tickers</option>
          {tickers.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="expired">Expired</option>
          <option value="assigned">Assigned</option>
        </select>
      </div>

      <p className="text-xs text-stone-500 mb-2">
        Showing {visible.length} of {positions.length}
      </p>

      <div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-stone-50 dark:bg-stone-900 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <Th onClick={() => onSort("underlying")}    label={`Ticker ${arrow("underlying")}`} />
              <Th onClick={() => onSort("strike")}        label={`Strike ${arrow("strike")}`}        align="right" />
              <Th onClick={() => onSort("expiration_date")} label={`Expiration ${arrow("expiration_date")}`} />
              <th className="px-3 py-2">Qty</th>
              <Th onClick={() => onSort("net_premium")}   label={`Net Premium ${arrow("net_premium")}`} align="right" />
              <th className="px-3 py-2 text-right">Total P&amp;L</th>
              <Th onClick={() => onSort("status")}        label={`Status ${arrow("status")}`} />
              <Th onClick={() => onSort("open_date")}     label={`Opened ${arrow("open_date")}`} />
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const totalPnl = p.net_premium * p.quantity * 100;
              const pnlClass = totalPnl >= 0
                ? "text-green-600 dark:text-green-400"
                : "text-red-600 dark:text-red-400";

              return (
                <tr
                  key={p.option_symbol}
                  className="border-t border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900/50"
                >
                  <td className="px-3 py-2 font-medium">{p.underlying}</td>
                  <td className="px-3 py-2 text-right tabular-nums">${p.strike.toFixed(2)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(p.expiration_date)}</td>
                  <td className="px-3 py-2 tabular-nums">{p.quantity}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pnlClass}`}>
                    {fmtUSD(p.net_premium)}
                    <span className="text-stone-400 dark:text-stone-600 text-xs ml-1">/share</span>
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${pnlClass}`}>
                    {fmtUSD(totalPnl)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[p.status]}`}>
                      {STATUS_LABEL[p.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-stone-500">{fmtDate(p.open_date)}</td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-stone-500">
                  No positions match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  onClick,
  label,
  align = "left",
}: {
  onClick: () => void;
  label: string;
  align?: "left" | "right";
}) {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 cursor-pointer select-none ${align === "right" ? "text-right" : ""}`}
    >
      {label}
    </th>
  );
}
