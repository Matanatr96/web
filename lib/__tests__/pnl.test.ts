import { describe, it, expect } from "vitest";
import { buildTickerPnL } from "@/lib/pnl";
import type { EquityTrade, OptionsPosition } from "@/lib/types";

function makeTrade(
  overrides: Partial<EquityTrade> & Pick<EquityTrade, "symbol" | "side" | "quantity" | "avg_fill_price">,
): EquityTrade {
  return {
    id: 1,
    tradier_id: 1,
    source: "prod",
    status: "filled",
    order_date: "2024-01-01T00:00:00Z",
    transaction_date: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePosition(
  overrides: Partial<OptionsPosition> & Pick<OptionsPosition, "underlying" | "strategy" | "status" | "quantity" | "premium_collected" | "net_premium" | "strike">,
): OptionsPosition {
  return {
    option_symbol:   "AAPL240101C00150000",
    expiration_date: "2024-01-01",
    premium_paid:    null,
    open_date:       "2024-01-01",
    close_date:      null,
    ...overrides,
  };
}

// ─── equity only ─────────────────────────────────────────────────────────────

describe("buildTickerPnL — equity only", () => {
  it("returns empty array for no trades", () => {
    expect(buildTickerPnL([], [])).toEqual([]);
  });

  it("tracks a single buy correctly", () => {
    const trades = [makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100 })];
    const [result] = buildTickerPnL(trades, []);
    expect(result.ticker).toBe("AAPL");
    expect(result.shares_open).toBe(10);
    expect(result.avg_cost_basis).toBe(100);
    expect(result.equity_total_cost).toBe(1000);
    expect(result.equity_realized_pl).toBe(0);
    expect(result.trade_count).toBe(1);
    expect(result.total_gross_spend).toBe(1000);
  });

  it("computes weighted average cost basis after two buys at different prices", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(20);
    expect(result.avg_cost_basis).toBe(110);
    expect(result.total_gross_spend).toBe(2200);
  });

  it("books realized P/L on a sell and updates shares", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy",  quantity: 10, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity:  5, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(5);
    expect(result.avg_cost_basis).toBe(100);
    expect(result.equity_realized_pl).toBe(100); // 5 × (120 − 100)
  });

  it("zeroes avg_cost_basis when all shares are sold", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy",  quantity: 5, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity: 5, avg_fill_price: 110, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(0);
    expect(result.avg_cost_basis).toBe(0);
    expect(result.equity_realized_pl).toBe(50); // 5 × 10
  });

  it("cost basis stays fixed after a partial sell — does not update on sells", () => {
    // Buy 20 @ $100 (avg $100), sell 10 @ $120, then buy 5 @ $200
    // Sell should NOT change avg cost; subsequent buy should roll it correctly
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy",  quantity: 20, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity: 10, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "buy",  quantity: 10, avg_fill_price: 200, order_date: "2024-01-03T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(20);
    // After sell, we have 10 shares @ avg $100. Then buy 10 @ $200.
    // New avg = (10*100 + 10*200) / 20 = 150
    expect(result.avg_cost_basis).toBe(150);
    expect(result.equity_realized_pl).toBe(200); // 10 × (120 − 100)
  });

  it("books a loss when selling below cost basis", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy",  quantity: 10, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity:  5, avg_fill_price:  80, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.equity_realized_pl).toBe(-100); // 5 × (80 − 100)
  });

  it("sorts results by ticker alphabetically", () => {
    const trades = [
      makeTrade({ symbol: "TSLA", side: "buy", quantity: 1, avg_fill_price: 200 }),
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 1, avg_fill_price: 100 }),
    ];
    const results = buildTickerPnL(trades, []);
    expect(results.map((r) => r.ticker)).toEqual(["AAPL", "TSLA"]);
  });

  it("handles multiple tickers independently", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 5, avg_fill_price: 100 }),
      makeTrade({ symbol: "TSLA", side: "buy", quantity: 2, avg_fill_price: 200 }),
    ];
    const results = buildTickerPnL(trades, []);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.ticker === "AAPL")!.shares_open).toBe(5);
    expect(results.find((r) => r.ticker === "TSLA")!.shares_open).toBe(2);
  });

  it("processes trades in date order, not array order", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(20);
    expect(result.avg_cost_basis).toBe(110);
  });

  it("caps a sell at open shares when oversold quantity is given", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy",  quantity:  5, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity: 10, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(0);
    expect(result.equity_realized_pl).toBe(100); // only 5 shares at (120-100)
  });

  it("computes unrealized equity P/L when prices are provided", () => {
    const trades = [makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100 })];
    const prices = new Map([["AAPL", 110]]);
    const [result] = buildTickerPnL(trades, [], prices);
    expect(result.unrealized_equity_pl).toBe(100); // 10 × (110 − 100)
    expect(result.total_pl).toBe(100);
  });

  it("shows zero unrealized equity P/L when no shares are held", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy",  quantity: 5, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity: 5, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const prices = new Map([["AAPL", 200]]);
    const [result] = buildTickerPnL(trades, [], prices);
    expect(result.unrealized_equity_pl).toBe(0);
  });

  it("omits unrealized fields when no price map is provided", () => {
    const trades = [makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100 })];
    const [result] = buildTickerPnL(trades, []);
    expect(result.unrealized_equity_pl).toBeUndefined();
    expect(result.total_pl).toBeUndefined();
  });
});

// ─── options only ─────────────────────────────────────────────────────────────

describe("buildTickerPnL — options", () => {
  it("accumulates realized P/L from a closed short position", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "closed",
      quantity:          1,
      strike:            150,
      premium_collected: 3,
      net_premium:       2, // collected 3, paid 1 to close
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.options_realized_pl).toBe(200); // 2 × 1 × 100
    expect(result.total_realized_pl).toBe(200);
  });

  it("accumulates realized P/L from an expired position", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "cash_secured_put",
      status:            "expired",
      quantity:          2,
      strike:            140,
      premium_collected: 1.50,
      net_premium:       1.50, // expired worthless — keep full premium
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.options_realized_pl).toBe(300); // 1.50 × 2 × 100
  });

  it("accumulates realized P/L from an assigned position", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "cash_secured_put",
      status:            "assigned",
      quantity:          1,
      strike:            150,
      premium_collected: 2.00,
      net_premium:       2.00,
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.options_realized_pl).toBe(200);
  });

  it("tracks open premium for open short positions", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "open",
      quantity:          2,
      strike:            150,
      premium_collected: 3,
      net_premium:       3,
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.options_open_premium).toBe(600); // 3 × 2 × 100
    expect(result.options_realized_pl).toBe(0);
  });

  it("tracks CSP collateral for open cash-secured puts", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "cash_secured_put",
      status:            "open",
      quantity:          2,
      strike:            150,
      premium_collected: 2,
      net_premium:       2,
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.csp_collateral).toBe(30000); // 150 × 100 × 2
    expect(result.total_capital_tied_up).toBe(30000);
  });

  it("does not count CSP collateral for covered calls", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "open",
      quantity:          1,
      strike:            150,
      premium_collected: 3,
      net_premium:       3,
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.csp_collateral).toBe(0);
  });

  it("computes unrealized P/L for an open short (mark below entry → profit)", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "open",
      quantity:          1,
      strike:            150,
      premium_collected: 3,
      net_premium:       3,
    });
    const prices = new Map([["AAPL", 155], ["AAPL240101C00150000", 1.5]]);
    const [result] = buildTickerPnL([], [pos], prices);
    expect(result.unrealized_options_pl).toBe(150); // (3 − 1.5) × 1 × 100
  });

  it("computes unrealized P/L for an open short (mark above entry → loss)", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "open",
      quantity:          1,
      strike:            150,
      premium_collected: 3,
      net_premium:       3,
    });
    const prices = new Map([["AAPL", 155], ["AAPL240101C00150000", 5.0]]);
    const [result] = buildTickerPnL([], [pos], prices);
    expect(result.unrealized_options_pl).toBe(-200); // (3 − 5) × 1 × 100
  });

  it("computes unrealized P/L for an open long call (mark above entry → profit)", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "long_call",
      status:            "open",
      quantity:          1,
      strike:            150,
      premium_collected: 0,
      premium_paid:      3,
      net_premium:       -3,
    });
    const prices = new Map([["AAPL", 155], ["AAPL240101C00150000", 6.0]]);
    const [result] = buildTickerPnL([], [pos], prices);
    expect(result.unrealized_options_pl).toBe(300); // (6 − 3) × 1 × 100
  });

  it("computes unrealized P/L for an open long put (mark above entry → profit)", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "long_put",
      status:            "open",
      quantity:          2,
      strike:            140,
      option_symbol:     "AAPL240101P00140000",
      premium_collected: 0,
      premium_paid:      2,
      net_premium:       -2,
    });
    const prices = new Map([["AAPL", 130], ["AAPL240101P00140000", 5.0]]);
    const [result] = buildTickerPnL([], [pos], prices);
    expect(result.unrealized_options_pl).toBe(600); // (5 − 2) × 2 × 100
  });

  it("skips unrealized options P/L when option mark price is absent", () => {
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "open",
      quantity:          1,
      strike:            150,
      premium_collected: 3,
      net_premium:       3,
    });
    // Prices map has the equity ticker but not the option symbol
    const prices = new Map([["AAPL", 155]]);
    const [result] = buildTickerPnL([], [pos], prices);
    // Open position exists but no mark — leave undefined so callers can
    // fall back to options_open_premium instead of treating it as $0 P/L.
    expect(result.unrealized_options_pl).toBeUndefined();
  });

  it("leaves unrealized_equity_pl undefined when shares are open but no quote is available", () => {
    const trade = makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100 });
    // Empty prices map — quote lookup misses
    const prices = new Map<string, number>();
    const [result] = buildTickerPnL([trade], [], prices);
    expect(result.unrealized_equity_pl).toBeUndefined();
  });

  it("combines equity and options for the same ticker", () => {
    const trade = makeTrade({ symbol: "AAPL", side: "buy", quantity: 100, avg_fill_price: 100 });
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "closed",
      quantity:          1,
      strike:            110,
      premium_collected: 2,
      net_premium:       2,
    });
    const [result] = buildTickerPnL([trade], [pos]);
    expect(result.ticker).toBe("AAPL");
    expect(result.shares_open).toBe(100);
    expect(result.options_realized_pl).toBe(200); // 2 × 1 × 100
    expect(result.total_realized_pl).toBe(200);   // equity realized = 0, options = 200
  });

  it("includes equity cost in total_capital_tied_up", () => {
    const trade = makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 150 });
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "cash_secured_put",
      status:            "open",
      quantity:          1,
      strike:            140,
      premium_collected: 2,
      net_premium:       2,
    });
    const [result] = buildTickerPnL([trade], [pos]);
    expect(result.equity_total_cost).toBe(1500);       // 10 × 150
    expect(result.csp_collateral).toBe(14000);         // 140 × 100 × 1
    expect(result.total_capital_tied_up).toBe(15500);  // 1500 + 14000
  });

  it("combines equity and options tickers into one sorted list", () => {
    const trade = makeTrade({ symbol: "TSLA", side: "buy", quantity: 1, avg_fill_price: 200 });
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "closed",
      quantity:          1,
      strike:            150,
      premium_collected: 2,
      net_premium:       2,
    });
    const results = buildTickerPnL([trade], [pos]);
    expect(results.map((r) => r.ticker)).toEqual(["AAPL", "TSLA"]);
  });

  it("total_pl sums realized + unrealized equity + unrealized options", () => {
    const trade = makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100 });
    const pos = makePosition({
      underlying:        "AAPL",
      strategy:          "covered_call",
      status:            "closed",
      quantity:          1,
      strike:            110,
      premium_collected: 3,
      net_premium:       2, // paid 1 to close
    });
    // No open positions, so unrealized_options_pl = 0
    const prices = new Map([["AAPL", 115]]);
    const [result] = buildTickerPnL([trade], [pos], prices);
    expect(result.equity_realized_pl).toBe(0);
    expect(result.options_realized_pl).toBe(200);       // 2 × 1 × 100
    expect(result.unrealized_equity_pl).toBe(150);      // 10 × (115 − 100)
    expect(result.unrealized_options_pl).toBe(0);
    expect(result.total_pl).toBeCloseTo(350);           // 0 + 200 + 150 + 0
  });
});
