"use client";

import { useMemo, useState } from "react";
import type { HeatmapPoint, HeatmapOutcome } from "@/lib/strike-heatmap";
import type { OptionStrategy } from "@/lib/types";

type StrategyFilter = "all" | OptionStrategy;
type DteFilter = "all" | "short" | "mid" | "long";
type OutcomeFilter = "all" | HeatmapOutcome;

const STRATEGY_LABEL: Record<StrategyFilter, string> = {
  all: "All strategies",
  covered_call: "Covered call",
  cash_secured_put: "Cash-secured put",
  long_call: "Long call",
  long_put: "Long put",
};

const OUTCOME_LABEL: Record<HeatmapOutcome, string> = {
  expired_worthless: "Expired worthless",
  bought_back: "Bought to close",
  sold_to_close: "Sold to close",
  assigned: "Assigned",
};

const OUTCOME_COLOR: Record<HeatmapOutcome, string> = {
  expired_worthless: "#10b981", // green
  bought_back: "#f59e0b",       // amber
  sold_to_close: "#3b82f6",     // blue
  assigned: "#ef4444",          // red
};

const DTE_LABEL: Record<DteFilter, string> = {
  all: "All DTE",
  short: "0–14 DTE",
  mid: "15–45 DTE",
  long: "46+ DTE",
};

function dteBucket(d: number): DteFilter {
  if (d <= 14) return "short";
  if (d <= 45) return "mid";
  return "long";
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export default function StrikeHeatmap({ points }: { points: HeatmapPoint[] }) {
  const [strategy, setStrategy] = useState<StrategyFilter>("all");
  const [dte, setDte] = useState<DteFilter>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [ticker, setTicker] = useState<string>("all");
  const [hover, setHover] = useState<HeatmapPoint | null>(null);

  const tickers = useMemo(
    () => Array.from(new Set(points.map((p) => p.underlying))).sort(),
    [points],
  );

  const filtered = useMemo(() => {
    return points.filter((p) => {
      if (strategy !== "all" && p.strategy !== strategy) return false;
      if (dte !== "all" && dteBucket(p.dte) !== dte) return false;
      if (outcome !== "all" && p.outcome !== outcome) return false;
      if (ticker !== "all" && p.underlying !== ticker) return false;
      return true;
    });
  }, [points, strategy, dte, outcome, ticker]);

  // Domain — symmetric around 0 so the diagonal is centered.
  const maxAbs = useMemo(() => {
    let m = 0.1;
    for (const p of filtered) {
      m = Math.max(m, Math.abs(p.pctOtmAtOpen), Math.abs(p.pctMove));
    }
    return Math.ceil(m * 20) / 20; // round up to nearest 5%
  }, [filtered]);

  // SVG geometry
  const W = 720;
  const H = 520;
  const PAD = { top: 24, right: 24, bottom: 56, left: 64 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const xScale = (v: number) => PAD.left + ((v + maxAbs) / (2 * maxAbs)) * innerW;
  const yScale = (v: number) => PAD.top + (1 - (v + maxAbs) / (2 * maxAbs)) * innerH;

  // Premium range for marker sizing
  const premiumAbs = filtered.map((p) => Math.abs(p.netPremium * p.quantity * 100));
  const maxPremium = Math.max(100, ...premiumAbs);
  const radius = (p: HeatmapPoint) => {
    const dollars = Math.abs(p.netPremium * p.quantity * 100);
    return 4 + Math.sqrt(dollars / maxPremium) * 10;
  };

  // Grid lines every 5%
  const gridStep = 0.05;
  const gridValues: number[] = [];
  for (let v = -Math.floor(maxAbs / gridStep) * gridStep; v <= maxAbs + 1e-9; v += gridStep) {
    gridValues.push(Number(v.toFixed(4)));
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 text-sm">
        <Select value={strategy} onChange={(v) => setStrategy(v as StrategyFilter)}
          options={Object.entries(STRATEGY_LABEL).map(([v, l]) => ({ value: v, label: l }))}
        />
        <Select value={dte} onChange={(v) => setDte(v as DteFilter)}
          options={Object.entries(DTE_LABEL).map(([v, l]) => ({ value: v, label: l }))}
        />
        <Select value={outcome} onChange={(v) => setOutcome(v as OutcomeFilter)}
          options={[
            { value: "all", label: "All outcomes" },
            ...Object.entries(OUTCOME_LABEL).map(([v, l]) => ({ value: v, label: l })),
          ]}
        />
        <Select value={ticker} onChange={setTicker}
          options={[{ value: "all", label: "All tickers" }, ...tickers.map((t) => ({ value: t, label: t }))]}
        />
        <span className="ml-auto text-stone-500 self-center">
          {filtered.length} of {points.length} positions
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs text-stone-600 dark:text-stone-400">
        {(Object.keys(OUTCOME_LABEL) as HeatmapOutcome[]).map((o) => (
          <span key={o} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: OUTCOME_COLOR[o] }} />
            {OUTCOME_LABEL[o]}
          </span>
        ))}
        <span className="ml-2">· marker size = $ premium at risk</span>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto border border-stone-200 dark:border-stone-800 rounded-lg bg-stone-50/40 dark:bg-stone-950/40">
          {/* Grid */}
          {gridValues.map((v) => (
            <g key={`gx-${v}`}>
              <line
                x1={xScale(v)} x2={xScale(v)} y1={PAD.top} y2={H - PAD.bottom}
                stroke="currentColor" className="text-stone-200 dark:text-stone-800"
                strokeWidth={v === 0 ? 1.5 : 0.5}
              />
              <text x={xScale(v)} y={H - PAD.bottom + 16} textAnchor="middle"
                className="fill-stone-500 text-[10px]">
                {(v * 100).toFixed(0)}%
              </text>
            </g>
          ))}
          {gridValues.map((v) => (
            <g key={`gy-${v}`}>
              <line
                x1={PAD.left} x2={W - PAD.right} y1={yScale(v)} y2={yScale(v)}
                stroke="currentColor" className="text-stone-200 dark:text-stone-800"
                strokeWidth={v === 0 ? 1.5 : 0.5}
              />
              <text x={PAD.left - 8} y={yScale(v) + 3} textAnchor="end"
                className="fill-stone-500 text-[10px]">
                {(v * 100).toFixed(0)}%
              </text>
            </g>
          ))}

          {/* Breakeven diagonal: y = x (move exactly equals starting cushion) */}
          <line
            x1={xScale(-maxAbs)} y1={yScale(-maxAbs)}
            x2={xScale(maxAbs)}  y2={yScale(maxAbs)}
            stroke="currentColor" strokeDasharray="4 4"
            className="text-stone-400 dark:text-stone-600"
            strokeWidth={1}
          />
          <text x={xScale(maxAbs) - 6} y={yScale(maxAbs) - 6} textAnchor="end"
            className="fill-stone-500 text-[10px]">
            breakeven (move = cushion)
          </text>

          {/* Axis labels */}
          <text x={PAD.left + innerW / 2} y={H - 8} textAnchor="middle"
            className="fill-stone-700 dark:fill-stone-300 text-xs font-medium">
            % OTM at open  →  cushion
          </text>
          <text x={14} y={PAD.top + innerH / 2}
            textAnchor="middle" transform={`rotate(-90 14 ${PAD.top + innerH / 2})`}
            className="fill-stone-700 dark:fill-stone-300 text-xs font-medium">
            % move toward ITM  →  danger
          </text>

          {/* Points */}
          {filtered.map((p) => {
            const cx = xScale(p.pctOtmAtOpen);
            const cy = yScale(p.pctMove);
            return (
              <circle
                key={p.optionSymbol}
                cx={cx} cy={cy} r={radius(p)}
                fill={OUTCOME_COLOR[p.outcome]}
                fillOpacity={0.55}
                stroke={OUTCOME_COLOR[p.outcome]}
                strokeWidth={1.25}
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "pointer" }}
              />
            );
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 max-w-xs rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 p-3 text-xs shadow-lg pointer-events-none">
            <div className="font-mono font-medium">{hover.optionSymbol}</div>
            <div className="text-stone-500 mt-0.5">
              {hover.underlying} · {STRATEGY_LABEL[hover.strategy as StrategyFilter]} · ${hover.strike.toFixed(2)}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              <span className="text-stone-500">Outcome</span>
              <span style={{ color: OUTCOME_COLOR[hover.outcome] }}>{OUTCOME_LABEL[hover.outcome]}</span>
              <span className="text-stone-500">Held</span>
              <span>{hover.dte}d</span>
              <span className="text-stone-500">Cushion at open</span>
              <span>{fmtPct(hover.pctOtmAtOpen)}</span>
              <span className="text-stone-500">Move toward ITM</span>
              <span>{fmtPct(hover.pctMove)}</span>
              <span className="text-stone-500">Spot open → close</span>
              <span>${hover.spotAtOpen.toFixed(2)} → ${hover.spotAtClose.toFixed(2)}</span>
              <span className="text-stone-500">Net premium</span>
              <span>{fmtUsd(hover.netPremium * hover.quantity * 100)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Summary stats */}
      <Stats points={filtered} />
    </div>
  );
}

function Stats({ points }: { points: HeatmapPoint[] }) {
  if (points.length === 0) return null;
  const avgCushion = points.reduce((s, p) => s + p.pctOtmAtOpen, 0) / points.length;
  const medianCushion = (() => {
    const sorted = [...points].map((p) => p.pctOtmAtOpen).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  })();
  const blewThrough = points.filter((p) => p.pctMove > p.pctOtmAtOpen).length;
  const blewThroughPct = (blewThrough / points.length) * 100;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
      <Stat label="Positions" value={String(points.length)} />
      <Stat label="Median cushion" value={fmtPct(medianCushion)} />
      <Stat label="Avg cushion" value={fmtPct(avgCushion)} />
      <Stat label="Blew through" value={`${blewThrough} (${blewThroughPct.toFixed(0)}%)`} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Select({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 px-2.5 py-1.5 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
