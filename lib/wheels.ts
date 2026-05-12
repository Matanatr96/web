import type { EquityTrade, OptionsPosition } from "@/lib/types";

// A closed "wheel" cycle: an assigned cash-secured put that delivered shares,
// followed by one or more covered calls, terminated either when a covered call
// assigned (shares called away) or when the underlying shares were sold.
export type WheelCycle = {
  underlying: string;
  start_date: string;          // CSP expiration / assignment date
  end_date: string;            // CC expiration (called_away) or equity sell date
  days_held: number;           // calendar days from start to end (min 1)
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
      const cycleCCs = ccs.filter(
        (c) =>
          dateOnly(c.open_date) >= startDate &&
          dateOnly(c.open_date) <= endDate &&
          (c.option_symbol === exitCC?.option_symbol || !usedCcIds.has(c.option_symbol) || c.status !== "assigned"),
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
      const annualized = returnPct * (365 / daysHeld);

      cycles.push({
        underlying: ticker,
        start_date: startDate,
        end_date: endDate,
        days_held: daysHeld,
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
