import { describe, it, expect } from "vitest";
import { scoreCcRecommendation, type CcRankInputs } from "@/lib/cc-ranking";
import { calcOiSkew, calcTechnicalLevel } from "@/lib/csp-ranking";
import type { OptionQuote } from "@/lib/quotes";

function baseInput(overrides: Partial<CcRankInputs> = {}): CcRankInputs {
  return {
    ticker: "TEST",
    annualized_yield_pct: 9,
    underlying_price: 100,
    strike: 108,
    dte: 35,
    iv_pct: 35,
    rv20_pct: 25,
    atr20: 1.5,
    back_atm_iv_pct: 34,
    oi_skew_score: 0,
    oi_skew_display: null,
    technical_score: 0,
    technical_display: null,
    rv_cone_percentile: 0.5,
    cost_basis: 90,
    ex_div_in_window: false,
    ...overrides,
  };
}

describe("scoreCcRecommendation", () => {
  it("produces a 0..100 score with a non-empty reason", () => {
    const res = scoreCcRecommendation(baseInput());
    expect(res.score).toBeGreaterThan(0);
    expect(res.score).toBeLessThanOrEqual(100);
    expect(res.reason.length).toBeGreaterThan(0);
  });

  it("cushion flips: strike *above* spot is positive cushion for CC", () => {
    const above = scoreCcRecommendation(baseInput({ strike: 108 }));
    const below = scoreCcRecommendation(baseInput({ strike: 92 }));
    // ATR-normalized cushion is (strike - spot) / em — above spot = positive
    expect(above.cushion_expected_moves).toBeGreaterThan(0);
    expect(below.cushion_expected_moves).toBeLessThan(0);
  });

  it("applies call_away_near_basis penalty when strike close to basis", () => {
    const near = scoreCcRecommendation(
      baseInput({ strike: 91, cost_basis: 90 }), // 91 < 90 * 1.02 = 91.8
    );
    expect(near.modifiers.some((m) => m.key === "call_away_near_basis")).toBe(true);
    expect(near.modifier_multiplier).toBeLessThan(1);
  });

  it("does not apply call_away_near_basis when strike comfortably above basis", () => {
    const safe = scoreCcRecommendation(
      baseInput({ strike: 100, cost_basis: 90 }),
    );
    expect(safe.modifiers.some((m) => m.key === "call_away_near_basis")).toBe(false);
  });

  it("applies ex_div_in_window penalty", () => {
    const withDiv = scoreCcRecommendation(baseInput({ ex_div_in_window: true }));
    const withoutDiv = scoreCcRecommendation(baseInput({ ex_div_in_window: false }));
    expect(withDiv.modifiers.some((m) => m.key === "ex_div_in_window")).toBe(true);
    expect(withDiv.score).toBeLessThan(withoutDiv.score);
  });

  it("renormalizes when Tier-A signals are missing", () => {
    const sparse = scoreCcRecommendation(
      baseInput({
        oi_skew_score: null,
        technical_score: null,
        rv_cone_percentile: null,
      }),
    );
    // With all Tier-A missing, only Tier-S contributes — score should still be reasonable.
    expect(sparse.score).toBeGreaterThan(0);
  });
});

describe("calcOiSkew with side=call", () => {
  function opt(strike: number, type: "put" | "call", oi: number): OptionQuote {
    return { strike, option_type: type, bid: 1, ask: 1.05, bid_size: 50, ask_size: 50, open_interest: oi, delta: null, mid_iv: null };
  }
  it("rewards call-OI dominance when side=call", () => {
    const chain = [opt(100, "call", 800), opt(100, "put", 200)];
    const { score, display } = calcOiSkew(chain, 100, "call");
    expect(score).toBeGreaterThan(0.5);
    expect(display).toContain("call-OI");
  });
  it("default side=put still works for backward compat", () => {
    const chain = [opt(100, "put", 800), opt(100, "call", 200)];
    expect(calcOiSkew(chain, 100).score).toBeGreaterThan(0.5);
  });
});

describe("calcTechnicalLevel with direction=resistance", () => {
  it("scores high when strike sits near 60d high", () => {
    // Trending up: closes 80..139, last = 139, 60d high = 139
    const closes = Array.from({ length: 60 }, (_, i) => 80 + i);
    // spot ~ 139, strike near 60d high
    const { score, display } = calcTechnicalLevel(closes, 139, 139, "resistance");
    expect(score).toBe(1);
    expect(display).toContain("60d high");
  });
});
