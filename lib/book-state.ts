// Current-book snapshot for the CSP + CC scanners.
//
// CSP path: net long shares per ticker, open CSP collateral per ticker.
// CC path: shares pledged to open short calls per ticker, average cost basis
// per share. Used by the ranking layer to penalize concentration, assignment
// overlap, and to gate covered-call strikes against locked-in losses.

import { getServiceClient } from "@/lib/supabase";
import { buildPositions } from "@/lib/positions";
import type { EquityTrade, OptionsTrade } from "@/lib/types";

export type BookState = {
  longShares: Map<string, number>;         // ticker -> net shares currently held
  openCspCollateral: Map<string, number>;  // ticker -> $ tied up in open CSPs
  openCcShares: Map<string, number>;       // ticker -> shares pledged to open short calls
  costBasis: Map<string, number>;          // ticker -> avg cost per share (avg cost method)
};

const EMPTY: BookState = {
  longShares: new Map(),
  openCspCollateral: new Map(),
  openCcShares: new Map(),
  costBasis: new Map(),
};

export function computeBookState(
  equityTrades: EquityTrade[],
  optionsTrades: OptionsTrade[],
): BookState {
  // Running net shares + avg cost basis. Avg-cost method: buys raise the
  // weighted average; sells reduce shares but don't change the per-share
  // basis. Mirrors how lib/pnl computes it elsewhere.
  const longShares = new Map<string, number>();
  const totalCost = new Map<string, number>();
  const sortedEq = [...equityTrades].sort(
    (a, b) => a.order_date.localeCompare(b.order_date),
  );
  for (const t of sortedEq) {
    const sym = t.symbol;
    const curShares = longShares.get(sym) ?? 0;
    const curCost = totalCost.get(sym) ?? 0;
    if (t.side === "buy") {
      longShares.set(sym, curShares + t.quantity);
      totalCost.set(sym, curCost + t.quantity * t.avg_fill_price);
    } else {
      const avg = curShares > 0 ? curCost / curShares : 0;
      const newShares = curShares - t.quantity;
      longShares.set(sym, newShares);
      // Sells reduce total cost at the avg basis; if we flatten or flip negative,
      // reset cost to zero so a re-entry rebuilds the avg cleanly.
      totalCost.set(sym, newShares > 0 ? newShares * avg : 0);
    }
  }
  // Drop zeros to keep the maps small.
  for (const [k, v] of longShares) {
    if (v === 0) {
      longShares.delete(k);
      totalCost.delete(k);
    }
  }
  const costBasis = new Map<string, number>();
  for (const [k, shares] of longShares) {
    const cost = totalCost.get(k) ?? 0;
    if (shares > 0) costBasis.set(k, cost / shares);
  }

  const openCspCollateral = new Map<string, number>();
  const openCcShares = new Map<string, number>();
  const positions = buildPositions(optionsTrades);
  for (const p of positions) {
    if (p.status !== "open") continue;
    if (p.strategy === "cash_secured_put") {
      const collateral = p.strike * 100 * p.quantity;
      openCspCollateral.set(
        p.underlying,
        (openCspCollateral.get(p.underlying) ?? 0) + collateral,
      );
    } else if (p.strategy === "covered_call") {
      openCcShares.set(
        p.underlying,
        (openCcShares.get(p.underlying) ?? 0) + 100 * p.quantity,
      );
    }
  }

  return { longShares, openCspCollateral, openCcShares, costBasis };
}

export async function fetchBookState(): Promise<BookState> {
  const supabase = getServiceClient();
  const [eqRes, optRes] = await Promise.all([
    supabase.from("equity_trades").select("*").eq("source", "prod"),
    supabase.from("options_trades").select("*").eq("source", "prod"),
  ]);
  if (eqRes.error) {
    console.error("[book-state] equity_trades fetch", eqRes.error);
    return EMPTY;
  }
  if (optRes.error) {
    console.error("[book-state] options_trades fetch", optRes.error);
    return EMPTY;
  }
  return computeBookState(
    (eqRes.data ?? []) as EquityTrade[],
    (optRes.data ?? []) as OptionsTrade[],
  );
}
