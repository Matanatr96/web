import type { EquityTrade, OptionsPosition } from "@/lib/types";

// A closed "wheel" cycle: an assigned cash-secured put that delivered shares,
// followed by one or more covered calls, terminated either when a covered call
// assigned (shares called away) or when the underlying shares were sold.
export type WheelCycle = {
  underlying: string;
  start_date: string;          // CSP expiration / assignment date
  end_date: string;            // CC expiration (called_away) or equity sell date
  days_held: number;           // calendar days from start to end (min 1)
  csp_open_date: string;       // date the originating CSP was sold-to-open
  dte_at_open: number;         // calendar days from CSP open to CSP expiration (min 0)
  quantity: number;            // contracts on the originating CSP (shares = qty * 100)
  csp_strike: number;
  csp_premium: number;         // dollars credited from the originating CSP
  cc_premium: number;          // dollars credited net from all CCs in this cycle
  cc_count: number;
  exit: "called_away" | "sold";
  exit_price: number;          // per share at exit
  equity_pl: number;           // (exit_price - csp_strike) * 100 * qty
  total_premium: number;       // csp_premium + cc_premium
  total_profit: number;        // total_premium + equity_pl
  capital_at_risk: number;     // csp_strike * 100 * qty (cash the CSP locked up)
  return_pct: number;          // total_profit / capital_at_risk (decimal, 0.07 == 7%)
  annualized_return: number;   // return_pct * 365 / days_held (decimal)
};

function dateOnly(iso: string): string {
  // Accept either YYYY-MM-DD or full ISO timestamps; return YYYY-MM-DD.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function daysBetween(startISO: string, endISO: string): number {
  const a = new Date(dateOnly(startISO) + "T00:00:00Z").getTime();
  const b = new Date(dateOnly(endISO)   + "T00:00:00Z").getTime();
  return Math.max(1, Math.round((b - a) / 86400000));
}

// Build the list of closed wheel cycles, sorted by annualized return descending.
//
// Heuristic pairing — known limitations:
//   - Overlapping CSPs on the same ticker are paired with exits in FIFO order
//     (oldest CSP claims the next available exit event). This works for the
//     common case of sequential wheels; if you ran two parallel CSPs at very
//     different strikes that both got assigned, the pairing may not match the
//     real broker accounting.
//   - Equity-sell exits ignore the share count when there is no matching CC
//     assignment — we assume the first sell ≥ qty*100 shares after the CSP
//     assignment closed the wheel. Partial sells are not split into fractional
//     cycles for MVP simplicity.
export function buildWheelCycles(
  positions: OptionsPosition[],
  equityTrades: EquityTrade[],
): WheelCycle[] {
  const tickers = new Set<string>([
    ...positions.map((p) => p.underlying),
    ...equityTrades.map((t) => t.symbol),
  ]);

  const cycles: WheelCycle[] = [];

  for (const ticker of tickers) {
    const cspsAssigned = positions
      .filter((p) => p.underlying === ticker && p.strategy === "cash_secured_put" && p.status === "assigned")
      .sort((a, b) => a.expiration_date.localeCompare(b.expiration_date));

    if (cspsAssigned.length === 0) continue;

    const ccs = positions
      .filter((p) => p.underlying === ticker && p.strategy === "covered_call")
      .sort((a, b) => a.open_date.localeCompare(b.open_date));

    const sells = equityTrades
      .filter((t) => t.symbol === ticker && t.side === "sell")
      .sort((a, b) => a.order_date.localeCompare(b.order_date));

    const usedCcIds = new Set<string>();
    const usedSellIds = new Set<number>();

    for (const csp of cspsAssigned) {
      const startDate = csp.expiration_date;
      const sharesNeeded = csp.quantity * 100;

      // Find the next "exit event": an assigned covered call after the CSP
      // assignment that hasn't been claimed by an earlier wheel, or an equity
      // sell of ≥ shares_needed.
      const exitCC = ccs.find(
        (c) =>
          c.status === "assigned" &&
          c.expiration_date >= startDate &&
          !usedCcIds.has(c.option_symbol),
      );

      const exitSell = sells.find(
        (s) =>
          dateOnly(s.order_date) >= startDate &&
          s.quantity >= sharesNeeded &&
          !usedSellIds.has(s.id),
      );

      let exit: "called_away" | "sold";
      let endDate: string;
      let exitPrice: number;

      const ccDate  = exitCC  ? exitCC.expiration_date : null;
      const sellDate = exitSell ? dateOnly(exitSell.order_date) : null;

      if (ccDate && (!sellDate || ccDate <= sellDate)) {
        exit = "called_away";
        endDate = exitCC!.expiration_date;
        exitPrice = exitCC!.strike;
        usedCcIds.add(exitCC!.option_symbol);
      } else if (sellDate) {
        exit = "sold";
        endDate = sellDate;
        exitPrice = exitSell!.avg_fill_price;
        usedSellIds.add(exitSell!.id);
      } else {
        // Wheel still open — skip.
        continue;
      }

      // Sum premium from every CC opened on/after startDate and on/before endDate.
      // Skip OTHER assigned CCs — they will (or already did) terminate their own
      // wheel cycle, so their premium belongs there, not here. The exit CC for
      // this cycle is kept explicitly.
      const cycleCCs = ccs.filter(
        (c) =>
          dateOnly(c.open_date) >= startDate &&
          dateOnly(c.open_date) <= endDate &&
          (c.status !== "assigned" || c.option_symbol === exitCC?.option_symbol),
      );

      const ccPremium = cycleCCs.reduce(
        (sum, c) => sum + c.net_premium * c.quantity * 100,
        0,
      );

      const cspPremium = csp.net_premium * csp.quantity * 100;
      const equityPL = (exitPrice - csp.strike) * 100 * csp.quantity;
      const totalPremium = cspPremium + ccPremium;
      const totalProfit = totalPremium + equityPL;
      const capital = csp.strike * 100 * csp.quantity;
      const daysHeld = daysBetween(startDate, endDate);
      const returnPct = capital > 0 ? totalProfit / capital : 0;
      // Floor the annualization denominator at 7 days. A 1-day wheel scaled to
      // 365x dominates the DTE Oracle's median and crowns outliers as the
      // "sweet spot". days_held is still reported as the true holding period.
      const annualized = returnPct * (365 / Math.max(7, daysHeld));

      const cspOpenDate = dateOnly(csp.open_date);
      const dteAtOpen = Math.max(
        0,
        Math.round(
          (new Date(dateOnly(csp.expiration_date) + "T00:00:00Z").getTime() -
            new Date(cspOpenDate + "T00:00:00Z").getTime()) /
            86400000,
        ),
      );

      cycles.push({
        underlying: ticker,
        start_date: startDate,
        end_date: endDate,
        days_held: daysHeld,
        csp_open_date: cspOpenDate,
        dte_at_open: dteAtOpen,
        quantity: csp.quantity,
        csp_strike: csp.strike,
        csp_premium: cspPremium,
        cc_premium: ccPremium,
        cc_count: cycleCCs.length,
        exit,
        exit_price: exitPrice,
        equity_pl: equityPL,
        total_premium: totalPremium,
        total_profit: totalProfit,
        capital_at_risk: capital,
        return_pct: returnPct,
        annualized_return: annualized,
      });
    }
  }

  cycles.sort((a, b) => b.annualized_return - a.annualized_return);
  return cycles;
}

// --- DTE Oracle -------------------------------------------------------------
// Bucket closed wheel cycles by DTE-at-open (days between CSP sell-to-open and
// its expiration) and compute the median annualized return per bucket.

export type DteBucketKey = "0-7" | "8-14" | "15-21" | "22-35" | "36+";

export type DteBucket = {
  key: DteBucketKey;
  label: string;
  min: number;
  max: number | null;       // null = open-ended (36+)
  count: number;
  median_annualized: number; // decimal (0.10 == 10%)
  mean_annualized: number;   // decimal
};

const BUCKET_DEFS: { key: DteBucketKey; label: string; min: number; max: number | null }[] = [
  { key: "0-7",   label: "0–7 DTE",   min: 0,  max: 7   },
  { key: "8-14",  label: "8–14 DTE",  min: 8,  max: 14  },
  { key: "15-21", label: "15–21 DTE", min: 15, max: 21  },
  { key: "22-35", label: "22–35 DTE", min: 22, max: 35  },
  { key: "36+",   label: "36+ DTE",   min: 36, max: null },
];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function bucketCyclesByDte(cycles: WheelCycle[]): DteBucket[] {
  return BUCKET_DEFS.map((def) => {
    const inBucket = cycles.filter((c) => {
      if (c.dte_at_open < def.min) return false;
      if (def.max !== null && c.dte_at_open > def.max) return false;
      return true;
    });
    const annualized = inBucket.map((c) => c.annualized_return);
    const mean = annualized.length > 0
      ? annualized.reduce((s, x) => s + x, 0) / annualized.length
      : 0;
    return {
      key: def.key,
      label: def.label,
      min: def.min,
      max: def.max,
      count: inBucket.length,
      median_annualized: median(annualized),
      mean_annualized: mean,
    };
  });
}

// Sweet-spot insight: compare the best meaningful bucket (>=3 trades) against
// the weakest meaningful bucket. Returns null if fewer than two qualifying buckets.
export type SweetSpotInsight = {
  bestBucket: DteBucket;
  worstBucket: DteBucket;
  ratio: number;            // bestBucket.median / worstBucket.median (only if both > 0)
  deltaPct: number;         // bestBucket.median - worstBucket.median
};

export function findSweetSpot(buckets: DteBucket[], minTrades = 3): SweetSpotInsight | null {
  const meaningful = buckets.filter((b) => b.count >= minTrades);
  if (meaningful.length < 2) return null;
  const sorted = [...meaningful].sort((a, b) => b.median_annualized - a.median_annualized);
  const best  = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best.key === worst.key) return null;
  const ratio = worst.median_annualized > 0 ? best.median_annualized / worst.median_annualized : 0;
  return {
    bestBucket: best,
    worstBucket: worst,
    ratio,
    deltaPct: best.median_annualized - worst.median_annualized,
  };
}
