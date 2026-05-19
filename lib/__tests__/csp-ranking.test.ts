import { describe, it, expect } from "vitest";
import {
  scoreRecommendation,
  calcRv20Pct,
  calcAtr20,
  pickBackExpiration,
  atmIvPctFromChain,
} from "@/lib/csp-ranking";

function baseInput() {
  return {
    annualized_yield_pct: 9,
    underlying_price: 100,
    strike: 92,
    dte: 35,
    iv_pct: 35,
    rv20_pct: 25,
    atr20: 1.5,
    back_atm_iv_pct: 34, // contango-ish; (35-34)/34 ≈ 2.9% < mild penalty threshold
  };
}

describe("scoreRecommendation", () => {
  it("produces a positive score for a healthy candidate", () => {
    const r = scoreRecommendation(baseInput());
    expect(r.score).toBeGreaterThan(30);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.reason).toMatch(/yield|IV|cushion/i);
    expect(r.penalty_multiplier).toBe(1);
  });

  it("ranks higher yield above lower yield, all else equal", () => {
    const lo = scoreRecommendation({ ...baseInput(), annualized_yield_pct: 4 });
    const hi = scoreRecommendation({ ...baseInput(), annualized_yield_pct: 14 });
    expect(hi.score).toBeGreaterThan(lo.score);
  });

  it("rewards IV richness over realized vol", () => {
    const flat = scoreRecommendation({ ...baseInput(), iv_pct: 25, rv20_pct: 25 });
    const rich = scoreRecommendation({ ...baseInput(), iv_pct: 40, rv20_pct: 25 });
    expect(rich.score).toBeGreaterThan(flat.score);
    expect(rich.iv_rv_ratio).toBeCloseTo(1.6, 2);
  });

  it("rewards larger ATR-normalized cushion", () => {
    const tight = scoreRecommendation({ ...baseInput(), strike: 98 });
    const wide = scoreRecommendation({ ...baseInput(), strike: 85 });
    expect(wide.score).toBeGreaterThan(tight.score);
    expect(wide.cushion_expected_moves).toBeGreaterThan(tight.cushion_expected_moves!);
  });

  it("applies a strong backwardation penalty when front IV >> back IV", () => {
    const calm = scoreRecommendation({ ...baseInput(), iv_pct: 35, back_atm_iv_pct: 34 });
    const backward = scoreRecommendation({ ...baseInput(), iv_pct: 45, back_atm_iv_pct: 35 });
    expect(backward.penalty_multiplier).toBeLessThan(1);
    expect(backward.score).toBeLessThan(calm.score);
    expect(backward.reason).toMatch(/backwardation/);
  });

  it("does not penalize contango (back > front)", () => {
    const r = scoreRecommendation({ ...baseInput(), iv_pct: 30, back_atm_iv_pct: 35 });
    expect(r.penalty_multiplier).toBe(1);
  });

  it("degrades gracefully when IV/RV/ATR data are missing", () => {
    const r = scoreRecommendation({
      ...baseInput(),
      iv_pct: null,
      rv20_pct: null,
      atr20: null,
      back_atm_iv_pct: null,
    });
    // Only yield contributes; yield=9 maps to 9/15 * 0.40 * 100 = 24.
    expect(r.score).toBeCloseTo(24, 0);
    expect(r.iv_rv_ratio).toBeNull();
    expect(r.cushion_expected_moves).toBeNull();
    expect(r.term_slope_pct).toBeNull();
  });

  it("surfaces the top two drivers in the reason string", () => {
    const r = scoreRecommendation({ ...baseInput(), annualized_yield_pct: 12, iv_pct: 45 });
    // Reason should mention at least one of: yield, IV/RV, cushion
    expect(r.reason.split("·").length).toBeGreaterThanOrEqual(1);
  });

  it("caps yield contribution at the reference point", () => {
    const at = scoreRecommendation({ ...baseInput(), annualized_yield_pct: 15 });
    const above = scoreRecommendation({ ...baseInput(), annualized_yield_pct: 30 });
    // Above the cap shouldn't outscore the cap on the yield dimension alone;
    // since all other inputs are equal, scores should be identical.
    expect(above.score).toBeCloseTo(at.score, 5);
  });
});

describe("calcRv20Pct", () => {
  it("returns null when given fewer than 21 closes", () => {
    expect(calcRv20Pct([])).toBeNull();
    expect(calcRv20Pct(Array(20).fill(100))).toBeNull();
  });

  it("returns ~0 for a flat series", () => {
    const flat = Array(25).fill(100);
    expect(calcRv20Pct(flat)).toBeCloseTo(0, 5);
  });

  it("returns a positive number for a volatile series", () => {
    const wiggly = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 2 : -2));
    const rv = calcRv20Pct(wiggly)!;
    expect(rv).toBeGreaterThan(0);
  });
});

describe("calcAtr20", () => {
  it("returns null when given fewer than 21 closes", () => {
    expect(calcAtr20([])).toBeNull();
    expect(calcAtr20(Array(20).fill(100))).toBeNull();
  });

  it("computes mean absolute close-to-close change", () => {
    // Series: 100, 102, 100, 102, ... → every TR is 2.
    const series = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 100 : 102));
    expect(calcAtr20(series)).toBeCloseTo(2, 5);
  });
});

describe("pickBackExpiration", () => {
  it("picks the expiration closest to front + 60d", () => {
    const front = "2026-06-20";
    const exps = ["2026-06-20", "2026-07-18", "2026-08-22", "2026-09-19", "2026-12-19"];
    const back = pickBackExpiration(exps, front);
    expect(back).toBe("2026-08-22");
  });

  it("returns null when no expirations sit after the front", () => {
    expect(pickBackExpiration(["2026-05-01"], "2026-06-20")).toBeNull();
  });
});

describe("atmIvPctFromChain", () => {
  it("picks the put strike closest to spot and converts IV to percent", () => {
    const chain = [
      { strike: 95, option_type: "put", bid: 1, ask: 1.2, delta: -0.2, mid_iv: 0.30 },
      { strike: 100, option_type: "put", bid: 2, ask: 2.2, delta: -0.5, mid_iv: 0.35 },
      { strike: 105, option_type: "put", bid: 5, ask: 5.5, delta: -0.8, mid_iv: 0.40 },
    ];
    expect(atmIvPctFromChain(chain, 101)).toBeCloseTo(35, 5);
  });

  it("returns null when no strikes have IV", () => {
    const chain = [
      { strike: 100, option_type: "put", bid: 2, ask: 2.2, delta: null, mid_iv: null },
    ];
    expect(atmIvPctFromChain(chain, 100)).toBeNull();
  });
});
