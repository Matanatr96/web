import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPositions } from "@/lib/positions";
import type { OptionsTrade } from "@/lib/types";

const FUTURE = "2099-01-01";
const PAST   = "2020-01-01";

let nextId = 1;

function makeTrade(
  overrides: Partial<OptionsTrade> & Pick<OptionsTrade, "side" | "avg_fill_price">,
): OptionsTrade {
  return {
    id:               nextId++,
    tradier_id:       nextId++,
    source:           "prod",
    underlying:       "AAPL",
    option_symbol:    "AAPL260101C00150000",
    option_type:      "call",
    strategy:         "covered_call",
    strike:           150,
    expiration_date:  FUTURE,
    quantity:         1,
    status:           "filled",
    order_date:       "2026-01-01T00:00:00Z",
    transaction_date: null,
    created_at:       "2026-01-01T00:00:00Z",
    updated_at:       "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => { nextId = 1; vi.useFakeTimers(); vi.setSystemTime(new Date("2026-04-27T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

// ─── short positions (CSP / CC) ────────────────────────────────────────────

describe("buildPositions — short positions", () => {
  it("returns empty array for no trades", () => {
    expect(buildPositions([])).toEqual([]);
  });

  it("builds an open covered call from a single sell_to_open", () => {
    const trades = [makeTrade({ side: "sell_to_open", avg_fill_price: 3.00, strategy: "covered_call", option_type: "call" })];
    const [pos] = buildPositions(trades);
    expect(pos.strategy).toBe("covered_call");
    expect(pos.status).toBe("open");
    expect(pos.premium_collected).toBe(3.00);
    expect(pos.premium_paid).toBeNull();
    expect(pos.net_premium).toBe(3.00);
  });

  it("builds an open cash-secured put from a single sell_to_open", () => {
    const trades = [makeTrade({
      side: "sell_to_open",
      avg_fill_price: 2.50,
      strategy: "cash_secured_put",
      option_type: "put",
      option_symbol: "AAPL260101P00140000",
      strike: 140,
    })];
    const [pos] = buildPositions(trades);
    expect(pos.strategy).toBe("cash_secured_put");
    expect(pos.status).toBe("open");
    expect(pos.strike).toBe(140);
    expect(pos.premium_collected).toBe(2.50);
    expect(pos.net_premium).toBe(2.50);
  });

  it("marks a covered call as closed when buy_to_close exists", () => {
    const trades = [
      makeTrade({ side: "sell_to_open",  avg_fill_price: 3.00, order_date: "2026-01-01T00:00:00Z" }),
      makeTrade({ side: "buy_to_close",  avg_fill_price: 0.50, order_date: "2026-02-01T00:00:00Z", strategy: "covered_call" }),
    ];
    const [pos] = buildPositions(trades);
    expect(pos.status).toBe("closed");
    expect(pos.premium_collected).toBe(3.00);
    expect(pos.premium_paid).toBe(0.50);
    expect(pos.net_premium).toBeCloseTo(2.50);
    expect(pos.close_date).toBe("2026-02-01T00:00:00Z");
  });

  it("marks position as expired when expiration is in the past and not closed", () => {
    const trades = [makeTrade({ side: "sell_to_open", avg_fill_price: 1.00, expiration_date: PAST })];
    const [pos] = buildPositions(trades);
    expect(pos.status).toBe("expired");
  });

  it("marks position as assigned when status=assigned and expiration is past", () => {
    const trades = [makeTrade({
      side: "sell_to_open",
      avg_fill_price: 1.00,
      expiration_date: PAST,
      status: "assigned",
    })];
    const [pos] = buildPositions(trades);
    expect(pos.status).toBe("assigned");
  });

  it("does not create a position when there is no open leg", () => {
    const trades = [makeTrade({ side: "buy_to_close", avg_fill_price: 0.50 })];
    expect(buildPositions(trades)).toHaveLength(0);
  });

  it("sets correct underlying, strike, expiration_date, quantity from the open leg", () => {
    const trades = [makeTrade({
      side: "sell_to_open",
      avg_fill_price: 2.00,
      underlying: "TSLA",
      strike: 200,
      quantity: 3,
      expiration_date: "2026-06-20",
    })];
    const [pos] = buildPositions(trades);
    expect(pos.underlying).toBe("TSLA");
    expect(pos.strike).toBe(200);
    expect(pos.quantity).toBe(3);
    expect(pos.expiration_date).toBe("2026-06-20");
  });
});

// ─── long positions ─────────────────────────────────────────────────────────

describe("buildPositions — long positions", () => {
  it("builds an open long call from buy_to_open", () => {
    const trades = [makeTrade({
      side: "buy_to_open",
      avg_fill_price: 4.00,
      strategy: "long_call",
      option_type: "call",
    })];
    const [pos] = buildPositions(trades);
    expect(pos.status).toBe("open");
    expect(pos.premium_paid).toBe(4.00);
    expect(pos.premium_collected).toBe(0);
    expect(pos.net_premium).toBe(-4.00);
  });

  it("closes a long call when sell_to_close exists", () => {
    const trades = [
      makeTrade({ side: "buy_to_open",   avg_fill_price: 4.00, strategy: "long_call", order_date: "2026-01-01T00:00:00Z" }),
      makeTrade({ side: "sell_to_close", avg_fill_price: 7.00, strategy: "long_call", order_date: "2026-02-01T00:00:00Z" }),
    ];
    const [pos] = buildPositions(trades);
    expect(pos.status).toBe("closed");
    expect(pos.premium_collected).toBe(7.00); // proceeds from sell_to_close
    expect(pos.premium_paid).toBe(4.00);
    expect(pos.net_premium).toBeCloseTo(3.00); // profit per share
  });

  it("builds an open long put", () => {
    const trades = [makeTrade({
      side: "buy_to_open",
      avg_fill_price: 2.50,
      strategy: "long_put",
      option_type: "put",
      option_symbol: "AAPL260101P00140000",
    })];
    const [pos] = buildPositions(trades);
    expect(pos.strategy).toBe("long_put");
    expect(pos.net_premium).toBe(-2.50);
  });
});

// ─── multi-position and ordering ────────────────────────────────────────────

describe("buildPositions — multiple positions", () => {
  it("produces one position per option_symbol", () => {
    const trades = [
      makeTrade({ side: "sell_to_open", avg_fill_price: 2.00, option_symbol: "AAPL260101C00150000" }),
      makeTrade({ side: "sell_to_open", avg_fill_price: 1.50, option_symbol: "AAPL260601C00160000" }),
    ];
    expect(buildPositions(trades)).toHaveLength(2);
  });

  it("sorts positions by open_date descending", () => {
    const trades = [
      makeTrade({ side: "sell_to_open", avg_fill_price: 2.00, option_symbol: "AAPL260101C00150000", order_date: "2026-01-01T00:00:00Z" }),
      makeTrade({ side: "sell_to_open", avg_fill_price: 1.50, option_symbol: "AAPL260601C00160000", order_date: "2026-03-01T00:00:00Z" }),
    ];
    const positions = buildPositions(trades);
    expect(positions[0].open_date).toBe("2026-03-01T00:00:00Z");
    expect(positions[1].open_date).toBe("2026-01-01T00:00:00Z");
  });

  it("folds multiple open legs for the same symbol into one position with summed qty and weighted avg premium", () => {
    const trades = [
      makeTrade({ side: "sell_to_open", avg_fill_price: 3.00, quantity: 1, order_date: "2026-01-01T00:00:00Z" }),
      makeTrade({ side: "sell_to_open", avg_fill_price: 2.00, quantity: 2, order_date: "2026-02-01T00:00:00Z" }),
    ];
    const positions = buildPositions(trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].quantity).toBe(3);
    expect(positions[0].premium_collected).toBeCloseTo((3.00 * 1 + 2.00 * 2) / 3); // 2.33…
    expect(positions[0].open_date).toBe("2026-01-01T00:00:00Z"); // earliest
  });

  it("groups open and close legs by option_symbol correctly", () => {
    const trades = [
      makeTrade({ side: "sell_to_open",  avg_fill_price: 3.00, option_symbol: "AAPL260101C00150000", order_date: "2026-01-01T00:00:00Z" }),
      makeTrade({ side: "buy_to_close",  avg_fill_price: 1.00, option_symbol: "AAPL260101C00150000", order_date: "2026-02-01T00:00:00Z", strategy: "covered_call" }),
      makeTrade({ side: "sell_to_open",  avg_fill_price: 2.00, option_symbol: "AAPL260601C00160000", order_date: "2026-03-01T00:00:00Z" }),
    ];
    const positions = buildPositions(trades);
    expect(positions).toHaveLength(2);
    const closed = positions.find((p) => p.option_symbol === "AAPL260101C00150000")!;
    const open   = positions.find((p) => p.option_symbol === "AAPL260601C00160000")!;
    expect(closed.status).toBe("closed");
    expect(open.status).toBe("open");
  });
});
