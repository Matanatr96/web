import { describe, it, expect } from "vitest";
import { annotateAssignments } from "@/lib/assignment";
import type { EquityTrade, OptionsPosition } from "@/lib/types";

function makeTrade(
  overrides: Partial<EquityTrade> & Pick<EquityTrade, "symbol" | "side" | "quantity" | "avg_fill_price">,
): EquityTrade {
  return {
    id: 1,
    tradier_id: 1,
    source: "prod",
    status: "filled",
    order_date: "2024-06-21T14:00:00Z",
    transaction_date: null,
    created_at: "2024-06-21T00:00:00Z",
    updated_at: "2024-06-21T00:00:00Z",
    ...overrides,
  };
}

function makePosition(
  overrides: Partial<OptionsPosition> & Pick<OptionsPosition, "underlying" | "strategy" | "status" | "quantity" | "strike">,
): OptionsPosition {
  return {
    option_symbol: "AAPL240621C00180000",
    expiration_date: "2024-06-21",
    premium_collected: 1.50,
    premium_paid: null,
    net_premium: 1.50,
    open_date: "2024-06-01",
    close_date: null,
    ...overrides,
  };
}

describe("annotateAssignments", () => {
  describe("happy paths", () => {
    it("annotates covered_call with matching sell trade", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
      });
      const trade = makeTrade({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        avg_fill_price: 180.00,
      });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toEqual([trade]);
    });

    it("annotates cash_secured_put with matching buy trade", () => {
      const pos = makePosition({
        underlying: "GOOGL",
        strategy: "cash_secured_put",
        status: "assigned",
        quantity: 2,
        strike: 150,
        expiration_date: "2024-06-21",
      });
      const trade = makeTrade({
        symbol: "GOOGL",
        side: "buy",
        quantity: 200,
        avg_fill_price: 150.25,
      });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toEqual([trade]);
    });

    it("matches at the boundary of the $1.00 price tolerance", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
      });
      const trade = makeTrade({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        avg_fill_price: 181.00, // exactly $1.00 above strike
      });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toEqual([trade]);
    });

    it("matches when trade settles within the 3-day window", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "cash_secured_put",
        status: "assigned",
        quantity: 1,
        strike: 150,
        expiration_date: "2024-06-21",
      });
      const trade = makeTrade({
        symbol: "AAPL",
        side: "buy",
        quantity: 100,
        avg_fill_price: 150,
        order_date: "2024-06-23T14:00:00Z", // T+2.5 days — well within the 3-day window
      });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toEqual([trade]);
    });
  });

  describe("filtering — no match expected", () => {
    it("skips positions with status !== assigned", () => {
      for (const status of ["open", "closed", "expired"] as const) {
        const pos = makePosition({
          underlying: "AAPL",
          strategy: "covered_call",
          status,
          quantity: 1,
          strike: 180,
        });
        const trade = makeTrade({ symbol: "AAPL", side: "sell", quantity: 100, avg_fill_price: 180 });
        annotateAssignments([pos], [trade]);
        expect(pos.assigned_equity_trades).toBeUndefined();
      }
    });

    it("does not match when fill price is more than $1.00 from strike", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
      });
      const trade = makeTrade({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        avg_fill_price: 181.50, // $1.50 above strike
      });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toBeUndefined();
    });

    it("does not match when trade date is more than 3 days from expiration", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
        expiration_date: "2024-06-21",
      });
      const trade = makeTrade({
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        avg_fill_price: 180,
        order_date: "2024-06-26T14:00:00Z", // T+5
      });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toBeUndefined();
    });

    it("does not match covered_call against a buy trade", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
      });
      const trade = makeTrade({ symbol: "AAPL", side: "buy", quantity: 100, avg_fill_price: 180 });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toBeUndefined();
    });

    it("does not match cash_secured_put against a sell trade", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "cash_secured_put",
        status: "assigned",
        quantity: 1,
        strike: 150,
      });
      const trade = makeTrade({ symbol: "AAPL", side: "sell", quantity: 100, avg_fill_price: 150 });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toBeUndefined();
    });

    it("does not match when underlying symbols differ", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
      });
      const trade = makeTrade({ symbol: "MSFT", side: "sell", quantity: 100, avg_fill_price: 180 });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toBeUndefined();
    });
  });

  describe("documented limitations", () => {
    it("limitation #1: false positive — manual discretionary trade near strike is incorrectly matched", () => {
      const pos = makePosition({
        underlying: "GOOGL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
        expiration_date: "2024-06-21",
      });
      // This is a manual sell, not an assignment delivery, but all heuristic
      // criteria are satisfied so the match fires anyway.
      const discretionarySell = makeTrade({
        symbol: "GOOGL",
        side: "sell",
        quantity: 100,
        avg_fill_price: 180.50,
        order_date: "2024-06-20T14:00:00Z", // day before expiration
      });
      annotateAssignments([pos], [discretionarySell]);
      expect(pos.assigned_equity_trades).toEqual([discretionarySell]);
    });

    it("limitation #2: split fills — both trades are returned when each independently satisfies the filters", () => {
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "covered_call",
        status: "assigned",
        quantity: 1,
        strike: 180,
      });
      const fill1 = makeTrade({ id: 1, symbol: "AAPL", side: "sell", quantity: 100, avg_fill_price: 179.90 });
      const fill2 = makeTrade({ id: 2, symbol: "AAPL", side: "sell", quantity: 100, avg_fill_price: 180.10 });
      annotateAssignments([pos], [fill1, fill2]);
      expect(pos.assigned_equity_trades).toHaveLength(2);
      expect(pos.assigned_equity_trades).toContainEqual(fill1);
      expect(pos.assigned_equity_trades).toContainEqual(fill2);
    });

    it("limitation #3: no match when equity quantity does not equal option quantity * 100", () => {
      // A partial close before expiration leaves 1 contract; assignment delivers
      // 100 shares, but the position originally had 2 contracts so the quantity
      // heuristic fires against 200 and misses the 100-share trade.
      const pos = makePosition({
        underlying: "AAPL",
        strategy: "cash_secured_put",
        status: "assigned",
        quantity: 2, // expects 200 shares
        strike: 150,
      });
      const trade = makeTrade({
        symbol: "AAPL",
        side: "buy",
        quantity: 100, // only 1 contract worth of shares
        avg_fill_price: 150,
      });
      annotateAssignments([pos], [trade]);
      expect(pos.assigned_equity_trades).toBeUndefined();
    });

    it("limitation #4: long_call and long_put are skipped even when status is assigned", () => {
      for (const strategy of ["long_call", "long_put"] as const) {
        const pos = makePosition({
          underlying: "AAPL",
          strategy,
          status: "assigned",
          quantity: 1,
          strike: 180,
        });
        const trade = makeTrade({ symbol: "AAPL", side: "buy", quantity: 100, avg_fill_price: 180 });
        annotateAssignments([pos], [trade]);
        expect(pos.assigned_equity_trades).toBeUndefined();
      }
    });
  });

  it("only processes assigned positions and leaves others untouched", () => {
    const assigned = makePosition({
      underlying: "AAPL",
      strategy: "covered_call",
      status: "assigned",
      quantity: 1,
      strike: 180,
    });
    const open = makePosition({
      underlying: "AAPL",
      strategy: "covered_call",
      status: "open",
      quantity: 1,
      strike: 180,
    });
    const trade = makeTrade({ symbol: "AAPL", side: "sell", quantity: 100, avg_fill_price: 180 });
    annotateAssignments([assigned, open], [trade]);
    expect(assigned.assigned_equity_trades).toEqual([trade]);
    expect(open.assigned_equity_trades).toBeUndefined();
  });
});
