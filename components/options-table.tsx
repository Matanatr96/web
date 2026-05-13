"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import type { OptionsPosition } from "@/lib/types";
import { deriveAction, type ActionTone } from "@/lib/action-chip";

function dteFromExpiration(iso: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(iso + "T00:00:00");
  return Math.round((exp.getTime() - today.getTime()) / 86_400_000);
}

type SortKey = "expiration_date" | "net_premium" | "status" | "open_date";
type SortDir = "asc" | "desc";

function premiumColor(pct: number): string {
  if (pct >= 1) return "text-green-700 dark:text-green-400";
  if (pct >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-stone-400";
}

const OPTION_TYPE: Record<OptionsPosition["strategy"], string> = {
  covered_call:     "Call",
  cash_secured_put: "Put",
  long_call:        "Call",
  long_put:         "Put",
};

function fmtExpiration(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function fmtStrike(strike: number) {
  return Number.isInteger(strike) ? `$${strike}` : `$${strike.toFixed(2)}`;
}

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

function fmtUSD(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

// Shrinking bar showing time remaining. Renders below the contract label for open positions.
function FuseBar({ openDate, expirationDate }: { openDate: string; expirationDate: string }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const open = new Date(openDate);
  const exp = new Date(expirationDate + "T00:00:00");
  const originalDte = Math.max(1, Math.round((exp.getTime() - open.getTime()) / 86_400_000));
  const dte = Math.max(0, Math.round((exp.getTime() - today.getTime()) / 86_400_000));
  const pctRemaining = dte / originalDte;

  const barColor =
    pctRemaining > 0.5
      ? "bg-green-500"
      : pctRemaining > 0.25
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <div className="mt-1 flex items-center gap-1.5">
      <div className="w-14 h-1 rounded-full bg-stone-200 dark:bg-stone-700 overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor}`}
          style={{ width: `${Math.max(2, pctRemaining * 100)}%` }}
        />
      </div>
      <span className="text-[10px] text-stone-400">{dte}d left</span>
    </div>
  );
}

// Dot gauge showing spot vs strike. Positive = OTM (safe), negative = ITM (danger).
function StrikeGauge({
  spot,
  strike,
  strategy,
}: {
  spot: number;
  strike: number;
  strategy: OptionsPosition["strategy"];
}) {
  const isShort = strategy === "cash_secured_put" || strategy === "covered_call";
  const isCSP = strategy === "cash_secured_put";
  // For CSP: OTM when spot > strike. For CC: OTM when spot < strike.
  const otm = isCSP ? (spot - strike) / spot : (strike - spot) / spot;

  const range = 0.15;
  const clamped = Math.max(-range, Math.min(range, otm));
  const dotPct = ((clamped + range) / (2 * range)) * 100;

  const dotColor =
    !isShort || otm > 0.05
      ? "bg-green-500"
      : otm > 0
        ? "bg-amber-500"
        : "bg-red-500";

  const textColor =
    !isShort || otm > 0.05
      ? "text-green-600 dark:text-green-400"
      : otm > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={`text-xs font-medium tabular-nums ${textColor}`}>
        {otm > 0 ? "+" : ""}
        {(otm * 100).toFixed(1)}% OTM
      </span>
      <div className="relative w-16 h-1.5 rounded-full bg-stone-200 dark:bg-stone-700">
        <div className="absolute inset-y-0 left-1/2 w-px bg-stone-400 dark:bg-stone-500" />
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${dotColor} border-2 border-white dark:border-stone-900`}
          style={{ left: `calc(${dotPct}% - 5px)` }}
        />
      </div>
    </div>
  );
}

function computePctCaptured(position: OptionsPosition, markPrice?: number): number | null {
  const maxProfit = position.premium_collected * position.quantity * 100;
  if (position.status === "open") {
    if (markPrice != null) {
      const pnl = (position.premium_collected - markPrice) * position.quantity * 100;
      return maxProfit > 0 ? pnl / maxProfit : null;
    }
    if (position.unrealized_pl !== undefined) {
      return maxProfit > 0 ? position.unrealized_pl / maxProfit : null;
    }
    return null;
  }
  return position.premium_collected > 0 ? position.net_premium / position.premium_collected : null;
}

const TONE_CLASS: Record<ActionTone, string> = {
  green:   "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  amber:   "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  red:     "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  neutral: "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400",
};

function ActionChipBadge({
  position,
  markPrice,
  livePrice,
  rollTarget,
}: {
  position: OptionsPosition;
  markPrice?: number;
  livePrice?: number;
  rollTarget?: { strike: number; dte: number } | null;
}) {
  if (position.status !== "open") {
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[position.status]}`}>
        {STATUS_LABEL[position.status]}
      </span>
    );
  }

  const dte = dteFromExpiration(position.expiration_date);
  const pctCaptured = computePctCaptured(position, markPrice);

  const isItm =
    livePrice == null
      ? null
      : position.strategy === "cash_secured_put"
        ? livePrice < position.strike
        : livePrice > position.strike;

  const chip = deriveAction({ dte, isItm, pctCaptured, spot: livePrice ?? null, strike: position.strike }, rollTarget);

  const rollHref =
    chip.verb === "ROLL"
      ? `/stonks/roll-or-hold#${position.option_symbol}`
      : undefined;

  const inner = (
    <span className={`inline-flex flex-col items-start px-2 py-1 rounded-md text-xs font-medium ${TONE_CLASS[chip.tone]}`}>
      <span className="font-semibold leading-tight">{chip.verb}</span>
      <span className="font-normal opacity-75 leading-tight">{chip.reason}</span>
    </span>
  );

  return rollHref ? <Link href={rollHref}>{inner}</Link> : inner;
}

// % of max profit captured, with a mini decay ring. Replaces "Total P&L".
function PctCaptured({
  position,
  markPrice,
}: {
  position: OptionsPosition;
  markPrice?: number;
}) {
  const capturedPct = computePctCaptured(position, markPrice);

  if (capturedPct === null) return <span className="text-stone-400 text-sm">—</span>;

  const pct = Math.round(capturedPct * 100);
  const textColor =
    pct >= 50
      ? "text-green-600 dark:text-green-400"
      : pct >= 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  const r = 7;
  const circ = 2 * Math.PI * r;
  const clampedPct = Math.max(0, Math.min(100, pct));
  const dash = (clampedPct / 100) * circ;
  const ringColor = pct >= 50 ? "text-green-500" : pct >= 0 ? "text-amber-500" : "text-red-500";

  return (
    <div className="flex items-center justify-end gap-1.5">
      <div className="flex flex-col items-end">
        <span className={`text-sm font-semibold tabular-nums ${textColor}`}>{pct}%</span>
        <span className="text-[10px] text-stone-400">captured</span>
      </div>
      <svg width="18" height="18" className="-rotate-90">
        <circle
          cx="9"
          cy="9"
          r={r}
          strokeWidth="2.5"
          stroke="currentColor"
          fill="none"
          className="text-stone-200 dark:text-stone-700"
        />
        <circle
          cx="9"
          cy="9"
          r={r}
          strokeWidth="2.5"
          stroke="currentColor"
          fill="none"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          className={ringColor}
        />
      </svg>
    </div>
  );
}

export default function OptionsTable({
  positions,
  monthlyReturn,
  optionPrices,
  optionGreeks,
  livePrice,
  rollTargets,
  statusFilter = "",
}: {
  positions: OptionsPosition[];
  monthlyReturn?: Record<string, number>;
  optionPrices?: Record<string, number>;
  optionGreeks?: Map<string, number>;
  livePrice?: number;
  rollTargets?: Map<string, { strike: number; dte: number }>;
  statusFilter?: string;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("open_date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const visible = useMemo(() => {
    const list = positions.filter((p) => {
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
  }, [positions, statusFilter, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "net_premium" ? "desc" : "asc");
    }
  };

  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === "asc" ? "↑" : "↓") : "");

  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-stone-50 dark:bg-stone-900 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <Th onClick={() => onSort("expiration_date")} label={`Contract ${arrow("expiration_date")}`} />
              <Th onClick={() => onSort("net_premium")} label={`Net Premium ${arrow("net_premium")}`} align="right" />
              <th className="px-3 py-2 text-right">Spot vs Strike</th>
              <th className="px-3 py-2 text-right">Theta/day</th>
              <th className="px-3 py-2 text-right">% Captured</th>
              <th className="px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const markPrice = optionPrices?.[p.option_symbol];

              return (
                <React.Fragment key={p.option_symbol}>
                  <tr className="border-t border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900/50">
                    {/* Contract — qty folded in, Fuse bar for open positions */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div>
                        <span>
                          {fmtExpiration(p.expiration_date)} {fmtStrike(p.strike)}{" "}
                          {OPTION_TYPE[p.strategy]}
                        </span>
                        <span className="ml-1.5 text-stone-400 text-xs">·{p.quantity}x</span>
                      </div>
                      {p.status === "open" && (
                        <FuseBar openDate={p.open_date} expirationDate={p.expiration_date} />
                      )}
                    </td>

                    {/* Net Premium */}
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span>{fmtUSD(p.net_premium)}</span>
                      <span className="text-stone-400 dark:text-stone-600 text-xs ml-1">/share</span>
                      {monthlyReturn &&
                        Number.isFinite(monthlyReturn[p.option_symbol]) &&
                        p.status === "open" && (
                          <div className={`text-xs font-normal ${premiumColor(monthlyReturn[p.option_symbol])}`}>
                            {monthlyReturn[p.option_symbol].toFixed(2)}%/mo
                          </div>
                        )}
                    </td>

                    {/* Spot vs Strike gauge */}
                    <td className="px-3 py-2 text-right">
                      {p.status === "open" && livePrice != null ? (
                        <StrikeGauge
                          spot={livePrice}
                          strike={p.strike}
                          strategy={p.strategy}
                        />
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>

                    {/* Theta/day */}
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(() => {
                        if (p.status !== "open" || !optionGreeks)
                          return <span className="text-stone-400">—</span>;
                        const rawTheta = optionGreeks.get(p.option_symbol);
                        if (rawTheta == null)
                          return <span className="text-stone-400">—</span>;
                        const isShort =
                          p.strategy === "cash_secured_put" ||
                          p.strategy === "covered_call";
                        const dailyTheta = (isShort ? -1 : 1) * rawTheta * 100 * p.quantity;
                        return (
                          <span
                            className={
                              dailyTheta >= 0
                                ? "text-green-600 dark:text-green-400"
                                : "text-red-600 dark:text-red-400"
                            }
                          >
                            {fmtUSD(dailyTheta)}
                          </span>
                        );
                      })()}
                    </td>

                    {/* % Captured */}
                    <td className="px-3 py-2 text-right">
                      <PctCaptured position={p} markPrice={markPrice} />
                    </td>

                    {/* Action chip */}
                    <td className="px-3 py-2">
                      <ActionChipBadge
                        position={p}
                        markPrice={markPrice}
                        livePrice={livePrice}
                        rollTarget={rollTargets?.get(p.option_symbol)}
                      />
                    </td>
                  </tr>

                  {p.assigned_equity_trades?.map((t) => (
                    <tr
                      key={`${p.option_symbol}-assignment-${t.id}`}
                      className="bg-amber-50 dark:bg-amber-900/10"
                    >
                      <td colSpan={6} className="px-3 py-1.5 text-xs text-stone-500">
                        ↳ {t.quantity} shares{" "}
                        {t.side === "sell" ? "called away" : "put to you"} at{" "}
                        {fmtUSD(t.avg_fill_price)} · {new Date(t.order_date + (t.order_date.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-stone-500">
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
