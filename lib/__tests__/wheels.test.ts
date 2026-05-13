import { describe, it, expect } from "vitest";
import { buildWheelCycles } from "@/lib/wheels";
import type { EquityTrade, OptionsPosition } from "@/lib/types";

let nextEquityId = 1;

function csp(overrides: Partial<OptionsPosition> = {}): OptionsPosition {
  return {
    underlying: "AAPL",
    option_symbol: `AAPL${overrides.expiration_date ?? "2026-02-20"}P00150000`,
    strategy: "cash_secured_put",
    strike: 150,
    expiration_date: "2026-02-20",
    quantity: 1,
    premium_collected: 2.00,
    premium_paid: null,
    net_premium: 2.00,
    status: "assigned",
    open_date: "2026-01-20T00:00:00Z",
    close_date: null,
    ...overrides,
  };
}

function cc(overrides: Partial<OptionsPosition> = {}): OptionsPosition {
  return {
    underlying: "AAPL",
    option_symbol: `AAPL${overrides.expiration_date ?? "2026-03-20"}C00160000`,
    strategy: "covered_call",
    strike: 160,
    expiration_date: "2026-03-20",
    quantity: 1,
    premium_collected: 1.50,
    premium_paid: null,
    net_premium: 1.50,
    status: "expired",
    open_date: "2026-02-21T00:00:00Z",
    close_date: null,
    ...overrides,
  };
}

function sell(overrides: Partial<EquityTrade> = {}): EquityTrade {
  return {
    id: nextEquityId++,
    tradier_id: nextEquityId,
    source: "prod",
    symbol: "AAPL",
    side: "sell",
    quantity: 100,
    avg_fill_price: 165,
    status: "filled",
    order_date: "2026-04-01T00:00:00Z",
    transaction_date: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("buildWheelCycles", () => {
  it("returns empty when no assigned CSPs exist", () => {
    expect(buildWheelCycles([], [])).toEqual([]);
    // CSPs that expired worthless are not the start of a wheel.
    expect(buildWheelCycles([csp({ status: "expired" })], [])).toEqual([]);
  });

  it("builds a basic wheel: CSP assigned → CC assigned", () => {
    const positions = [
      csp({ strike: 150, net_premium: 2.00, expiration_date: "2026-02-20" }),
      cc({ strike: 160, net_premium: 1.50, expiration_date: "2026-03-20", status: "assigned" }),
    ];
    const [cycle] = buildWheelCycles(positions, []);
    expect(cycle.exit).toBe("called_away");
    expect(cycle.csp_premium).toBe(200);   // 2.00 × 100 × 1
    expect(cycle.cc_premium).toBe(150);    // 1.50 × 100 × 1
    expect(cycle.equity_pl).toBe(1000);    // (160 - 150) × 100
    expect(cycle.total_profit).toBe(1350);
    expect(cycle.capital_at_risk).toBe(15000);
    expect(cycle.return_pct).toBeCloseTo(1350 / 15000);
    expect(cycle.start_date).toBe("2026-02-20");
    expect(cycle.end_date).toBe("2026-03-20");
    expect(cycle.days_held).toBe(28);
  });

  it("accumulates premium across multiple CCs in one cycle", () => {
    const positions = [
      csp({ strike: 150, net_premium: 2.00 }),
      cc({ option_symbol: "AAPL_CC1", net_premium: 1.20, expiration_date: "2026-03-20", open_date: "2026-02-21T00:00:00Z", status: "expired" }),
      cc({ option_symbol: "AAPL_CC2", net_premium: 1.10, expiration_date: "2026-04-17", open_date: "2026-03-21T00:00:00Z", status: "expired" }),
      cc({ option_symbol: "AAPL_CC3", strike: 165, net_premium: 1.00, expiration_date: "2026-05-15", open_date: "2026-04-18T00:00:00Z", status: "assigned" }),
    ];
    const [cycle] = buildWheelCycles(positions, []);
    expect(cycle.cc_count).toBe(3);
    expect(cycle.cc_premium).toBeCloseTo(330);   // (1.20 + 1.10 + 1.00) × 100
    expect(cycle.exit_price).toBe(165);
    expect(cycle.equity_pl).toBe(1500);          // (165 - 150) × 100
    expect(cycle.end_date).toBe("2026-05-15");
  });

  it("closes a wheel via equity sell when no CC was assigned", () => {
    const positions = [csp({ strike: 150, net_premium: 2.00 })];
    const equity = [sell({ order_date: "2026-03-15T14:00:00Z", avg_fill_price: 155, quantity: 100 })];
    const [cycle] = buildWheelCycles(positions, equity);
    expect(cycle.exit).toBe("sold");
    expect(cycle.exit_price).toBe(155);
    expect(cycle.equity_pl).toBe(500);
    expect(cycle.end_date).toBe("2026-03-15");
  });

  it("excludes wheels that are still open", () => {
    const positions = [csp()];  // assigned CSP but no CC assignment / sell
    expect(buildWheelCycles(positions, [])).toEqual([]);
  });

  it("ignores equity sells that predate the CSP assignment", () => {
    const positions = [csp({ expiration_date: "2026-02-20" })];
    const equity = [sell({ order_date: "2026-01-01T00:00:00Z" })];
    expect(buildWheelCycles(positions, equity)).toEqual([]);
  });

  it("prefers the earliest exit event (CC vs sell) when both qualify", () => {
    const positions = [
      csp({ strike: 150, net_premium: 2.00 }),
      cc({ strike: 160, expiration_date: "2026-03-20", status: "assigned" }),
    ];
    // A later sell shouldn't take precedence over an earlier CC assignment.
    const equity = [sell({ order_date: "2026-04-01T00:00:00Z", avg_fill_price: 170 })];
    const [cycle] = buildWheelCycles(positions, equity);
    expect(cycle.exit).toBe("called_away");
    expect(cycle.exit_price).toBe(160);
  });

  it("ranks cycles by annualized return descending", () => {
    const slow = [
      csp({ underlying: "SLOW", option_symbol: "SLOW_P", strike: 100, net_premium: 1.00, expiration_date: "2026-02-01" }),
      cc({ underlying: "SLOW", option_symbol: "SLOW_C", strike: 105, net_premium: 1.00, expiration_date: "2027-02-01", open_date: "2026-02-02T00:00:00Z", status: "assigned" }),
    ];
    const fast = [
      csp({ underlying: "FAST", option_symbol: "FAST_P", strike: 100, net_premium: 1.00, expiration_date: "2026-02-01" }),
      cc({ underlying: "FAST", option_symbol: "FAST_C", strike: 105, net_premium: 1.00, expiration_date: "2026-02-08", open_date: "2026-02-02T00:00:00Z", status: "assigned" }),
    ];
    const cycles = buildWheelCycles([...slow, ...fast], []);
    expect(cycles[0].underlying).toBe("FAST");
    expect(cycles[1].underlying).toBe("SLOW");
    expect(cycles[0].annualized_return).toBeGreaterThan(cycles[1].annualized_return);
  });

  it("pairs overlapping wheels in FIFO order", () => {
    const positions = [
      csp({ option_symbol: "CSP1", strike: 150, expiration_date: "2026-02-20", net_premium: 2.00 }),
      csp({ option_symbol: "CSP2", strike: 155, expiration_date: "2026-03-20", net_premium: 2.50 }),
      cc({ option_symbol: "CC1", strike: 160, expiration_date: "2026-04-17", open_date: "2026-02-21T00:00:00Z", status: "assigned" }),
      cc({ option_symbol: "CC2", strike: 165, expiration_date: "2026-05-15", open_date: "2026-03-21T00:00:00Z", status: "assigned" }),
    ];
    const cycles = buildWheelCycles(positions, []);
    expect(cycles).toHaveLength(2);
    const csp1Cycle = cycles.find((c) => c.csp_strike === 150)!;
    const csp2Cycle = cycles.find((c) => c.csp_strike === 155)!;
    expect(csp1Cycle.exit_price).toBe(160);  // CSP1 → CC1
    expect(csp2Cycle.exit_price).toBe(165);  // CSP2 → CC2
  });

  it("handles multi-contract CSPs by scaling capital and premium", () => {
    const positions = [
      csp({ quantity: 3, strike: 150, net_premium: 2.00 }),
      cc({ quantity: 3, strike: 160, net_premium: 1.50, expiration_date: "2026-03-20", status: "assigned" }),
    ];
    const [cycle] = buildWheelCycles(positions, []);
    expect(cycle.quantity).toBe(3);
    expect(cycle.capital_at_risk).toBe(45000);
    expect(cycle.csp_premium).toBe(600);
    expect(cycle.cc_premium).toBe(450);
    expect(cycle.equity_pl).toBe(3000);
  });
});
