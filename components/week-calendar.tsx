"use client";

import { useMemo, useState } from "react";

// One cell in the GitHub-style weekly calendar.
export type WeekCell = {
  isoKey: string;
  weekStart: string; // YYYY-MM-DD
  weekEnd: string;
  // Numeric value driving the color intensity.
  value: number;
  // Optional secondary value used for an under-row mini bar (0..1 or null).
  secondary?: number | null;
  // Rich tooltip body. Caller-controlled so the component stays reusable.
  tooltip?: React.ReactNode;
};

type Props = {
  cells: WeekCell[];
  // Max value that maps to deepest color. Anything >= this is fully saturated.
  // If omitted, falls back to the max value in `cells`.
  scaleMax?: number;
  // Hex color used as the deepest shade. Default: emerald-600.
  accent?: string;
  // Label shown above the calendar in the upper-right corner.
  legendLabel?: string;
  // If true, render the secondary bar row under the grid.
  showSecondary?: boolean;
  // Label appended after the percentage in the secondary tooltip, e.g. "win rate".
  secondaryLabel?: string;
};

// GitHub-style heatmap: rows = days of week, columns = weeks. We only show one
// row (since each cell is already a week), but we lay months across the top.
export default function WeekCalendar({
  cells,
  scaleMax,
  accent = "#059669",
  legendLabel,
  showSecondary = false,
  secondaryLabel,
}: Props) {
  const [hover, setHover] = useState<{ cell: WeekCell; x: number; y: number } | null>(null);

  const max = useMemo(() => {
    if (scaleMax && scaleMax > 0) return scaleMax;
    return cells.reduce((m, c) => Math.max(m, c.value), 0) || 1;
  }, [cells, scaleMax]);

  const colorFor = (v: number): string => {
    if (v <= 0) return "transparent";
    const t = Math.min(1, v / max);
    // Five-step scale matching GitHub's intensity buckets.
    if (t < 0.2) return mix(accent, 0.18);
    if (t < 0.4) return mix(accent, 0.35);
    if (t < 0.6) return mix(accent, 0.55);
    if (t < 0.8) return mix(accent, 0.78);
    return accent;
  };

  // Month labels — show the abbreviation on the first cell of each month.
  const monthLabels = useMemo(() => {
    const labels: { idx: number; label: string }[] = [];
    let lastMonth = -1;
    cells.forEach((c, i) => {
      const m = Number(c.weekStart.slice(5, 7)) - 1;
      if (m !== lastMonth) {
        labels.push({ idx: i, label: MONTHS[m] });
        lastMonth = m;
      }
    });
    return labels;
  }, [cells]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between text-xs text-stone-500">
        <div className="flex flex-wrap gap-2">
          {monthLabels.map((m, i) => (
            <span key={`${m.label}-${i}`} className="tabular-nums">{m.label}</span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span>{legendLabel ?? "less"}</span>
          {[0.18, 0.35, 0.55, 0.78, 1].map((t, i) => (
            <span
              key={i}
              className="inline-block w-3 h-3 rounded-sm border border-stone-200 dark:border-stone-800"
              style={{ backgroundColor: mix(accent, t) }}
            />
          ))}
          <span>more</span>
        </div>
      </div>

      <div className="relative">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
        >
          {cells.map((c) => (
            <button
              key={c.isoKey}
              type="button"
              aria-label={`Week of ${c.weekStart}`}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const parent = (e.currentTarget as HTMLElement).offsetParent as HTMLElement | null;
                const parentRect = parent?.getBoundingClientRect();
                setHover({
                  cell: c,
                  x: rect.left - (parentRect?.left ?? 0) + rect.width / 2,
                  y: rect.top - (parentRect?.top ?? 0),
                });
              }}
              onMouseLeave={() => setHover(null)}
              onFocus={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const parent = (e.currentTarget as HTMLElement).offsetParent as HTMLElement | null;
                const parentRect = parent?.getBoundingClientRect();
                setHover({
                  cell: c,
                  x: rect.left - (parentRect?.left ?? 0) + rect.width / 2,
                  y: rect.top - (parentRect?.top ?? 0),
                });
              }}
              onBlur={() => setHover(null)}
              className="aspect-square w-full rounded-sm border border-stone-200 dark:border-stone-800 hover:ring-2 hover:ring-stone-400 dark:hover:ring-stone-500 transition-shadow"
              style={{ backgroundColor: c.value > 0 ? colorFor(c.value) : undefined }}
            />
          ))}
        </div>

        {showSecondary && (
          <div
            className="grid gap-1 mt-2"
            style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
          >
            {cells.map((c) => {
              const v = c.secondary ?? null;
              const h = v == null ? 0 : Math.max(0.05, Math.min(1, v));
              const title =
                v == null
                  ? `Week of ${c.weekStart}: no closed contracts`
                  : `Week of ${c.weekStart}: ${Math.round(v * 100)}%${secondaryLabel ? ` ${secondaryLabel}` : ""}`;
              return (
                <div
                  key={`bar-${c.isoKey}`}
                  title={title}
                  className="h-8 w-full rounded-sm border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900 relative overflow-hidden"
                >
                  {v != null && (
                    <div
                      className="absolute bottom-0 left-0 right-0 bg-sky-500/70 dark:bg-sky-400/70"
                      style={{ height: `${h * 100}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {hover && hover.cell.tooltip && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full mt-[-8px] min-w-[180px] max-w-xs rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 p-3 text-xs shadow-lg"
            style={{ left: hover.x, top: hover.y }}
          >
            {hover.cell.tooltip}
          </div>
        )}
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Mix an accent hex color with white at intensity `t` (0..1). t=1 returns the
// full accent color, t=0 returns white. Approximates GitHub's tinted buckets.
function mix(hex: string, t: number): string {
  const { r, g, b } = parseHex(hex);
  const blend = (c: number) => Math.round(255 + (c - 255) * t);
  return `rgb(${blend(r)} ${blend(g)} ${blend(b)})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
