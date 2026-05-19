// Current-book snapshot for the CSP scanner: net long shares per ticker
// (from equity_trades) and open CSP collateral per ticker (from options_trades).
// Used by the ranking layer to penalize concentration and assignment overlap.

import { getServiceClient } from "@/lib/supabase";
import { buildPositions } from "@/lib/positions";
import type { EquityTrade, OptionsTrade } from "@/lib/types";

export type BookState = {
  longShares: Map<string, number>;         // ticker -> net shares currently held
  openCspCollateral: Map<string, number>;  // ticker -> $ tied up in open CSPs
};

const EMPTY: BookState = {
  longShares: new Map(),
  openCspCollateral: new Map(),
};

export function computeBookState(
  equityTrades: EquityTrade[],
  optionsTrades: OptionsTrade[],
): BookState {
  const longShares = new Map<string, number>();
  for (const t of equityTrades) {
    const delta = t.side === "buy" ? t.quantity : -t.quantity;
    longShares.set(t.symbol, (longShares.get(t.symbol) ?? 0) + delta);
  }
  // Drop zeros to keep the map small.
  for (const [k, v] of longShares) {
    if (v === 0) longShares.delete(k);
  }

  const openCspCollateral = new Map<string, number>();
  const positions = buildPositions(optionsTrades);
  for (const p of positions) {
    if (p.status !== "open" || p.strategy !== "cash_secured_put") continue;
    const collateral = p.strike * 100 * p.quantity;
    openCspCollateral.set(
      p.underlying,
      (openCspCollateral.get(p.underlying) ?? 0) + collateral,
    );
  }

  return { longShares, openCspCollateral };
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
