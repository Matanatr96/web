import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OptionsPosition } from "@/lib/types";

vi.mock("@/lib/quotes", () => ({
  getExpirations: vi.fn(),
  getOptionChain: vi.fn(),
  getHv30: vi.fn(),
}));

import { buildRollOrHoldRows } from "@/lib/roll-or-hold";
import { getExpirations, getOptionChain, getHv30 } from "@/lib/quotes";

const getExpirationsMock = vi.mocked(getExpirations);
const getOptionChainMock = vi.mocked(getOptionChain);
const getHv30Mock = vi.mocked(getHv30);

function csp(overrides: Partial<OptionsPosition> = {}): OptionsPosition {
  return {
    underlying: "AAPL",
    option_symbol: "AAPL250620P00150000",
    strategy: "cash_secured_put",
    strike: 150,
    expiration_date: "2026-05-22", // 5 DTE from frozen "today"
    quantity: 1,
    premium_collected: 2.0,
    premium_paid: null,
    net_premium: 2.0,
    status: "open",
    open_date: "2026-04-22T00:00:00Z",
    close_date: null,
    ...overrides,
  };
}

describe("buildRollOrHoldRows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Freeze "today" so DTE math is deterministic.
    vi.setSystemTime(new Date("2026-05-17T12:00:00Z"));
    getExpirationsMock.mockReset();
    getOptionChainMock.mockReset();
    getHv30Mock.mockReset();
    getHv30Mock.mockResolvedValue(null); // IV regime disabled unless a test opts in
    getExpirationsMock.mockResolvedValue(["2026-06-19"]); // 33 DTE from frozen today
    getOptionChainMock.mockResolvedValue([
      { strike: 150, option_type: "put", bid: 3.0, ask: 3.1, delta: -0.30, mid_iv: 0.40 },
      { strike: 145, option_type: "put", bid: 1.8, ask: 1.9, delta: -0.25, mid_iv: 0.42 },
    ]);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("uses the ask (not the mid) as close cost so net_credit reflects buy-to-close", async () => {
    const pos = csp({ expiration_date: "2026-05-22" }); // 5 DTE
    const liveMarks = new Map([[pos.option_symbol, 0.50]]); // mid
    const liveAsks = new Map([[pos.option_symbol, 0.60]]);  // ask = mid + 0.10

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);

    // Same-strike roll: new bid 3.0, close at ask 0.60 → net 2.40
    expect(row.same_strike?.net_credit).toBeCloseTo(2.40, 5);
    // Would have been 2.50 under the old mid-based bug — guard against regression.
    expect(row.same_strike?.net_credit).not.toBeCloseTo(2.50, 5);
  });

  it("falls back to mid * 1.10 when ask is unavailable (market closed)", async () => {
    const pos = csp({ expiration_date: "2026-05-22" });
    const liveMarks = new Map([[pos.option_symbol, 0.50]]);
    const liveAsks = new Map<string, number>(); // empty

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);

    // close_cost = 0.50 * 1.10 = 0.55, new bid 3.0 → net 2.45
    expect(row.same_strike?.net_credit).toBeCloseTo(2.45, 5);
  });

  it("caps annualization factor so 2 DTE doesn't produce a 15× extrinsic spike", async () => {
    const pos = csp({ expiration_date: "2026-05-19" }); // 2 DTE
    // mid 0.15 on a 150 strike CSP, spot above strike (OTM, no intrinsic)
    const liveMarks = new Map([
      [pos.option_symbol, 0.15],
      [pos.underlying, 160], // spot > strike → OTM put, full extrinsic
    ]);
    const liveAsks = new Map([[pos.option_symbol, 0.20]]);

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);

    expect(row.dte_remaining).toBe(2);
    expect(row.remaining_extrinsic).toBeCloseTo(0.15, 5);

    // Uncapped: (0.15 / 150) * (30/2) * 100 = 1.5%/mo
    // Capped at 6: (0.15 / 150) * 6 * 100 = 0.6%/mo
    expect(row.hold_monthly_return_pct).toBeCloseTo(0.6, 5);
    expect(row.hold_monthly_return_pct).toBeLessThan(1.5);
    expect(row.gamma_warning).toBe(true);
  });

  it("flags gamma_warning for positions with <= 5 DTE", async () => {
    const pos = csp({ expiration_date: "2026-05-22" }); // 5 DTE
    const liveMarks = new Map([[pos.option_symbol, 0.50], [pos.underlying, 160]]);
    const liveAsks = new Map([[pos.option_symbol, 0.55]]);

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);
    expect(row.dte_remaining).toBe(5);
    expect(row.gamma_warning).toBe(true);
  });

  it("flags illiquid strikes (>30% spread) and marks tight strikes liquid", async () => {
    getOptionChainMock.mockResolvedValue([
      // tight: ask 3.1, bid 3.0, mid 3.05, spread ≈ 3.3%
      { strike: 150, option_type: "put", bid: 3.0, ask: 3.1, delta: -0.30, mid_iv: 0.40 },
      // wide: ask 2.0, bid 1.0, mid 1.5, spread ≈ 66.7%
      { strike: 145, option_type: "put", bid: 1.0, ask: 2.0, delta: -0.25, mid_iv: 0.42 },
    ]);
    const pos = csp({ expiration_date: "2026-05-22" });
    const liveMarks = new Map([[pos.option_symbol, 0.50]]);
    const liveAsks = new Map([[pos.option_symbol, 0.60]]);

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);

    expect(row.same_strike?.is_liquid).toBe(true);
    expect(row.same_strike?.spread_pct).toBeCloseTo(0.1 / 3.05, 4);
    expect(row.best_strike?.is_liquid).toBe(false);
    expect(row.best_strike?.spread_pct).toBeGreaterThan(0.3);
  });

  it("computes iv_ratio from ATM mid_iv ÷ HV30", async () => {
    getHv30Mock.mockResolvedValue(40); // HV30 = 40%
    getOptionChainMock.mockResolvedValue([
      // ATM (spot 150) — mid_iv 0.60 = 60% IV → ratio 60/40 = 1.5
      { strike: 150, option_type: "put", bid: 3.0, ask: 3.1, delta: -0.30, mid_iv: 0.60 },
      { strike: 145, option_type: "put", bid: 1.8, ask: 1.9, delta: -0.25, mid_iv: 0.42 },
    ]);
    const pos = csp({ expiration_date: "2026-05-22" });
    const liveMarks = new Map([
      [pos.option_symbol, 0.50],
      [pos.underlying, 150], // spot at strike → ATM is 150
    ]);
    const liveAsks = new Map([[pos.option_symbol, 0.60]]);

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);
    expect(row.iv_ratio).toBeCloseTo(1.5, 5);
  });

  it("returns iv_ratio = null when HV30 is unavailable", async () => {
    getHv30Mock.mockResolvedValue(null);
    const pos = csp({ expiration_date: "2026-05-22" });
    const liveMarks = new Map([[pos.option_symbol, 0.50], [pos.underlying, 150]]);
    const liveAsks = new Map([[pos.option_symbol, 0.60]]);

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);
    expect(row.iv_ratio).toBeNull();
  });

  it("does not flag gamma_warning for positions with > 5 DTE", async () => {
    const pos = csp({ expiration_date: "2026-05-27" }); // 10 DTE
    const liveMarks = new Map([[pos.option_symbol, 0.50], [pos.underlying, 160]]);
    const liveAsks = new Map([[pos.option_symbol, 0.55]]);

    const [row] = await buildRollOrHoldRows([pos], new Map(), liveMarks, liveAsks);
    expect(row.dte_remaining).toBe(10);
    expect(row.gamma_warning).toBe(false);
    // 30/10 = 3 < cap of 6 — full annualization applies
    // remaining_extrinsic 0.50, capital 150 → (0.50/150) * 3 * 100 = 1.0%/mo
    expect(row.hold_monthly_return_pct).toBeCloseTo(1.0, 5);
  });
});
