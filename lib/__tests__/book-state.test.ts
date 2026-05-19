import { describe, it, expect } from "vitest";
import { computeBookState } from "@/lib/book-state";
import type { EquityTrade, OptionsTrade } from "@/lib/types";

function eq(overrides: Partial<EquityTrade>): EquityTrade {
  return {
    id: 1, tradier_id: 1, source: "prod", symbol: "AAPL",
    side: "buy", quantity: 100, avg_fill_price: 150, status: "filled",
    order_date: "2026-01-01T00:00:00Z", transaction_date: null,
    created_at: "", updated_at: "", ...overrides,
  };
}

function opt(overrides: Partial<OptionsTrade>): OptionsTrade {
  return {
    id: 1, tradier_id: 1, source: "prod", underlying: "AAPL",
    option_symbol: "AAPL260619P00150000", option_type: "put",
    strategy: "cash_secured_put", side: "sell_to_open", strike: 150,
    expiration_date: "2026-06-19", quantity: 1, avg_fill_price: 2,
    status: "filled", order_date: "2026-04-01T00:00:00Z",
    transaction_date: null, created_at: "", updated_at: "", ...overrides,
  };
}

describe("computeBookState", () => {
  it("nets buys and sells per symbol", () => {
    const trades = [
      eq({ symbol: "AAPL", side: "buy", quantity: 200 }),
      eq({ id: 2, symbol: "AAPL", side: "sell", quantity: 50 }),
      eq({ id: 3, symbol: "TSLA", side: "buy", quantity: 10 }),
    ];
    const state = computeBookState(trades, []);
    expect(state.longShares.get("AAPL")).toBe(150);
    expect(state.longShares.get("TSLA")).toBe(10);
  });

  it("drops symbols that net to zero", () => {
    const state = computeBookState(
      [eq({ symbol: "AAPL", side: "buy", quantity: 100 }),
       eq({ id: 2, symbol: "AAPL", side: "sell", quantity: 100 })],
      [],
    );
    expect(state.longShares.has("AAPL")).toBe(false);
  });

  it("sums open CSP collateral per underlying", () => {
    const trades = [
      opt({ underlying: "NVDA", strike: 100, quantity: 2 }),
      opt({ id: 2, underlying: "NVDA", option_symbol: "NVDA260619P00110000", strike: 110, quantity: 1 }),
      opt({ id: 3, underlying: "AMD", option_symbol: "AMD260619P00080000", strike: 80, quantity: 1 }),
    ];
    const state = computeBookState([], trades);
    // NVDA: (100 * 100 * 2) + (110 * 100 * 1) = 20000 + 11000 = 31000
    expect(state.openCspCollateral.get("NVDA")).toBe(31_000);
    expect(state.openCspCollateral.get("AMD")).toBe(8_000);
  });

  it("ignores closed CSP positions and non-CSP strategies", () => {
    const closed = opt({
      side: "sell_to_open", underlying: "NVDA", strike: 100, quantity: 1,
      option_symbol: "NVDA260619P00100000",
    });
    const closer: OptionsTrade = {
      ...closed, id: 2, side: "buy_to_close",
      order_date: "2026-04-15T00:00:00Z",
    };
    const cc = opt({
      id: 3, underlying: "MSFT", strategy: "covered_call",
      option_type: "call", option_symbol: "MSFT260619C00400000",
    });
    const state = computeBookState([], [closed, closer, cc]);
    expect(state.openCspCollateral.size).toBe(0);
  });
});
