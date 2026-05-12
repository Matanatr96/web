import { fetchDatedHistoryCached, type DatedClose } from "@/lib/quotes";
import { buildPositions } from "@/lib/positions";
import type { OptionsTrade, OptionsPosition, OptionStrategy } from "@/lib/types";

export type HeatmapOutcome =
  | "expired_worthless"   // short: kept premium; long: lost premium
  | "bought_back"         // short: closed early
  | "sold_to_close"       // long: closed early
  | "assigned";           // short: stock changed hands

export type HeatmapPoint = {
  optionSymbol: string;
  underlying: string;
  strategy: OptionStrategy;
  isLong: boolean;
  strike: number;
  openDate: string;        // YYYY-MM-DD
  closeDate: string;       // YYYY-MM-DD
  dte: number;             // calendar days held
  spotAtOpen: number;
  spotAtClose: number;
  // x-axis: % OTM at open (positive = cushion / room to be wrong)
  pctOtmAtOpen: number;
  // y-axis: % move toward ITM, from open to close
  // For short calls / long calls: up move = toward ITM
  // For short puts / long puts:  down move = toward ITM
  pctMove: number;
  outcome: HeatmapOutcome;
  netPremium: number;      // signed $ per share; positive = credit kept, negative = debit lost
  quantity: number;
};

function toDate(s: string): string {
  // Normalize ISO timestamp or date to YYYY-MM-DD
  return s.slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86_400_000);
}

// Find the close at-or-before the given date in a sorted (ascending) series.
// Falls back to the nearest after if no on-or-before match exists.
function closeOn(series: DatedClose[], date: string): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  let bestBefore = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      bestBefore = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestBefore >= 0) return series[bestBefore].close;
  return series[0].close;
}

function resolveOutcome(p: OptionsPosition, isLong: boolean): HeatmapOutcome | null {
  if (p.status === "open") return null;
  if (p.status === "assigned") return "assigned";
  if (p.status === "closed") return isLong ? "sold_to_close" : "bought_back";
  if (p.status === "expired") return "expired_worthless";
  return null;
}

export async function buildHeatmapPoints(trades: OptionsTrade[]): Promise<HeatmapPoint[]> {
  const positions = buildPositions(trades);

  // Per ticker, find the date range we need history for.
  type Range = { min: string; max: string };
  const rangeByTicker = new Map<string, Range>();

  const candidates: { p: OptionsPosition; isLong: boolean; outcome: HeatmapOutcome; closeDate: string }[] = [];

  for (const p of positions) {
    const isLong = p.strategy === "long_call" || p.strategy === "long_put";
    const outcome = resolveOutcome(p, isLong);
    if (!outcome) continue;

    const openDate = toDate(p.open_date);
    const closeDate = toDate(p.close_date ?? p.expiration_date);

    candidates.push({ p, isLong, outcome, closeDate });

    const r = rangeByTicker.get(p.underlying);
    const min = !r || openDate < r.min ? openDate : r.min;
    const max = !r || closeDate > r.max ? closeDate : r.max;
    rangeByTicker.set(p.underlying, { min, max });
  }

  // Fetch one history series per ticker covering its full range.
  const histories = new Map<string, DatedClose[]>();
  await Promise.all(
    Array.from(rangeByTicker.entries()).map(async ([ticker, { min, max }]) => {
      const series = await fetchDatedHistoryCached(ticker, min, max);
      // Tradier returns ascending; ensure it.
      series.sort((a, b) => a.date.localeCompare(b.date));
      histories.set(ticker, series);
    }),
  );

  const points: HeatmapPoint[] = [];
  for (const { p, isLong, outcome, closeDate } of candidates) {
    const series = histories.get(p.underlying) ?? [];
    const openDate = toDate(p.open_date);
    const spotAtOpen = closeOn(series, openDate);
    const spotAtClose = closeOn(series, closeDate);
    if (spotAtOpen == null || spotAtClose == null || spotAtOpen <= 0) continue;

    const isCall = p.strategy === "covered_call" || p.strategy === "long_call";
    // % OTM at open: positive when strike is favorably distant.
    // Calls are OTM when strike > spot. Puts are OTM when strike < spot.
    const pctOtmAtOpen = isCall
      ? (p.strike - spotAtOpen) / spotAtOpen
      : (spotAtOpen - p.strike) / spotAtOpen;

    // % move toward ITM, from open to close.
    // For calls (long or short), up move = toward ITM.
    // For puts,  down move = toward ITM.
    const rawMove = (spotAtClose - spotAtOpen) / spotAtOpen;
    const pctMove = isCall ? rawMove : -rawMove;

    points.push({
      optionSymbol: p.option_symbol,
      underlying: p.underlying,
      strategy: p.strategy,
      isLong,
      strike: p.strike,
      openDate,
      closeDate,
      dte: daysBetween(openDate, closeDate),
      spotAtOpen,
      spotAtClose,
      pctOtmAtOpen,
      pctMove,
      outcome,
      netPremium: p.net_premium,
      quantity: p.quantity,
    });
  }

  return points;
}
