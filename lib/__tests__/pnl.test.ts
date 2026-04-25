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
    option_symbol: "AAPL240101C00150000",
    option_type: "call",
    expiration_date: "2024-01-01",
    premium_paid: null,
    open_date: "2024-01-01",
    close_date: null,
    ...overrides,
  };
}

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
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity: 5, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(5);
    expect(result.avg_cost_basis).toBe(100);
    expect(result.equity_realized_pl).toBe(100); // 5 * (120 - 100)
  });

  it("zeroes avg_cost_basis when all shares are sold", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 5, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "sell", quantity: 5, avg_fill_price: 110, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(0);
    expect(result.avg_cost_basis).toBe(0);
    expect(result.equity_realized_pl).toBe(50); // 5 * 10
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
    const aapl = results.find((r) => r.ticker === "AAPL")!;
    const tsla = results.find((r) => r.ticker === "TSLA")!;
    expect(aapl.shares_open).toBe(5);
    expect(tsla.shares_open).toBe(2);
  });

  it("processes trades in date order, not array order", () => {
    // Buy 10 @ 100, then buy 10 @ 120 — but given in reverse order in the array
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    // Result should be same regardless of input order
    expect(result.shares_open).toBe(20);
    expect(result.avg_cost_basis).toBe(110);
  });

  it("does not let a sell exceed open shares", () => {
    const trades = [
      makeTrade({ symbol: "AAPL", side: "buy", quantity: 5, avg_fill_price: 100, order_date: "2024-01-01T00:00:00Z" }),
      // Attempt to sell 10 but only 5 are open — should cap at 5
      makeTrade({ symbol: "AAPL", side: "sell", quantity: 10, avg_fill_price: 120, order_date: "2024-01-02T00:00:00Z" }),
    ];
    const [result] = buildTickerPnL(trades, []);
    expect(result.shares_open).toBe(0);
    expect(result.equity_realized_pl).toBe(100); // only 5 shares worth
  });
});

describe("buildTickerPnL — options", () => {
  it("accumulates realized P/L from closed positions", () => {
    const pos = makePosition({
      underlying: "AAPL",
      strategy: "covered_call",
      status: "closed",
      quantity: 1,
      strike: 150,
      premium_collected: 3,
      net_premium: 2, // collected 3, paid 1 to close
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.options_realized_pl).toBe(200); // 2 * 1 * 100
    expect(result.total_realized_pl).toBe(200);
  });

  it("tracks open premium for open short positions", () => {
    const pos = makePosition({
      underlying: "AAPL",
      strategy: "covered_call",
      status: "open",
      quantity: 2,
      strike: 150,
      premium_collected: 3,
      net_premium: 3,
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.options_open_premium).toBe(600); // 3 * 2 * 100
    expect(result.options_realized_pl).toBe(0);
  });

  it("tracks CSP collateral for open cash-secured puts", () => {
    const pos = makePosition({
      underlying: "AAPL",
      strategy: "cash_secured_put",
      status: "open",
      quantity: 2,
      strike: 150,
      premium_collected: 2,
      net_premium: 2,
    });
    const [result] = buildTickerPnL([], [pos]);
    expect(result.csp_collateral).toBe(30000); // 150 * 100 * 2
    expect(result.total_capital_tied_up).toBe(30000);
  });

  it("computes unrealized options P/L for short positions with live prices", () => {
    const pos = makePosition({
      underlying: "AAPL",
      strategy: "covered_call",
      status: "open",
      quantity: 1,
      strike: 150,
      premium_collected: 3,
      net_premium: 3,
    });
    const prices = new Map([["AAPL", 155], ["AAPL240101C00150000", 1.5]]);
    const [result] = buildTickerPnL([], [pos], prices);
    // Short: profit when mark < entry credit; entry=3, mark=1.5 → profit
    expect(result.unrealized_options_pl).toBe(150); // (3 - 1.5) * 1 * 100
  });

  it("computes unrealized equity P/L when prices are provided", () => {
    const trades = [makeTrade({ symbol: "AAPL", side: "buy", quantity: 10, avg_fill_price: 100 })];
    const prices = new Map([["AAPL", 110]]);
    const [result] = buildTickerPnL(trades, [], prices);
    expect(result.unrealized_equity_pl).toBe(100); // 10 * (110 - 100)
    expect(result.total_pl).toBe(100);
  });

  it("combines equity and options tickers into one list", () => {
    const trade = makeTrade({ symbol: "TSLA", side: "buy", quantity: 1, avg_fill_price: 200 });
    const pos = makePosition({
      underlying: "AAPL",
      strategy: "covered_call",
      status: "closed",
      quantity: 1,
      strike: 150,
      premium_collected: 2,
      net_premium: 2,
    });
    const results = buildTickerPnL([trade], [pos]);
    expect(results.map((r) => r.ticker).sort()).toEqual(["AAPL", "TSLA"]);
  });
});
