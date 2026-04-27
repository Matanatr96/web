import type { EquityTrade, OptionsPosition } from "@/lib/types";

// HEURISTIC ASSIGNMENT MATCHING
//
// Matches assigned option positions to the equity trades that resulted from
// assignment (shares called away for covered calls, shares put to us for CSPs).
// There is no DB-level foreign key between equity_trades and options_trades, so
// this function infers the link using date proximity, quantity, and price.
//
// Known limitations — do not treat matched trades as ground truth:
//
//   1. FALSE POSITIVES: A manual buy/sell of the same underlying near the
//      expiration date at a price close to the strike will be incorrectly
//      labeled as an assignment delivery. Example: you sell 100 GOOGL shares
//      two days before a covered call expires at a strike of $180, and your
//      fill is $180.50 — this match will fire even though it was discretionary.
//
//   2. SPLIT FILLS: If Tradier splits an assignment into multiple equity orders
//      (e.g. two 50-share fills), both will be returned. But if a manual trade
//      on the same day also passes the filters, it will be included too.
//
//   3. QUANTITY ASSUMPTION: Matching requires equity quantity === option
//      quantity * 100. A partial close before expiration followed by assignment
//      on remaining contracts would produce a quantity mismatch and no match.
//
//   4. LONG OPTIONS: Long calls/puts can technically be assigned (exercise), but
//      this function only handles covered_call and cash_secured_put since those
//      are the strategies currently tracked. Long option exercises are skipped.

const DATE_WINDOW_DAYS   = 3;   // assignment settles T+1/T+2; allow up to T+3
const PRICE_TOLERANCE    = 1.00; // dollars from strike; assignment always at strike

function daysBetween(isoDate: string, isoTimestamp: string): number {
  const a = new Date(isoDate + "T00:00:00").getTime();
  const b = new Date(isoTimestamp).getTime();
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

export function annotateAssignments(
  positions: OptionsPosition[],
  equityTrades: EquityTrade[],
): void {
  for (const pos of positions) {
    if (pos.status !== "assigned") continue;
    if (pos.strategy !== "covered_call" && pos.strategy !== "cash_secured_put") continue;

    // Covered call → shares called away = equity sell
    // CSP          → shares put to us   = equity buy
    const expectedSide: EquityTrade["side"] =
      pos.strategy === "covered_call" ? "sell" : "buy";

    const expectedQty = pos.quantity * 100;

    const matches = equityTrades.filter(
      (t) =>
        t.symbol === pos.underlying &&
        t.side === expectedSide &&
        t.quantity === expectedQty &&
        Math.abs(t.avg_fill_price - pos.strike) <= PRICE_TOLERANCE &&
        daysBetween(pos.expiration_date, t.order_date) <= DATE_WINDOW_DAYS,
    );

    if (matches.length > 0) {
      pos.assigned_equity_trades = matches;
    }
  }
}
