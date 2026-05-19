import { describe, it, expect } from "vitest";
import {
  scoreRecommendation,
  calcRv20Pct,
  calcAtr20,
  pickBackExpiration,
  atmIvPctFromChain,
  calcOiSkew,
  calcTechnicalLevel,
  calcRvConePercentile,
  passesDepthFilter,
  type RankInputs,
} from "@/lib/csp-ranking";

function baseInput(overrides: Partial<RankInputs> = {}): RankInputs {
  return {
    ticker: "TEST",
    annualized_yield_pct: 9,
    underlying_price: 100,
    strike: 92,
    dte: 35,
    collateral: 9200,
    iv_pct: 35,
    rv20_pct: 25,
    atr20: 1.5,
    back_atm_iv_pct: 34, // (35-34)/34 ≈ 2.9% — below mild-backwardation threshold
    oi_skew_score: 0,
    oi_skew_display: null,
    technical_score: 0,
    technical_display: null,
    rv_cone_percentile: null,
    buying_power: 100_000,
    existing_csp_collateral: 0,
    existing_long_shares: 0,
    ...overrides,
  };
}

describe("scoreRecommendation — Tier S", () => {
  it("produces a positive score with no penalties for a healthy candidate", () => {
    const r = scoreRecommendation(baseInput());
    expect(r.score).toBeGreaterThan(15);
    expect(r.penalty_multiplier).toBe(1);
    expect(r.modifier_multiplier).toBe(1);
    expect(r.reason).toMatch(/yield|IV|cushion/i);
  });

  it("ranks higher yield above lower yield", () => {
    const lo = scoreRecommendation(baseInput({ annualized_yield_pct: 4 }));
    const hi = scoreRecommendation(baseInput({ annualized_yield_pct: 14 }));
    expect(hi.score).toBeGreaterThan(lo.score);
  });

  it("rewards IV richness over realized vol", () => {
    const flat = scoreRecommendation(baseInput({ iv_pct: 25, rv20_pct: 25 }));
    const rich = scoreRecommendation(baseInput({ iv_pct: 40, rv20_pct: 25 }));
    expect(rich.score).toBeGreaterThan(flat.score);
    expect(rich.iv_rv_ratio).toBeCloseTo(1.6, 2);
  });

  it("rewards larger ATR-normalized cushion", () => {
    const tight = scoreRecommendation(baseInput({ strike: 98 }));
    const wide = scoreRecommendation(baseInput({ strike: 85 }));
    expect(wide.score).toBeGreaterThan(tight.score);
    expect(wide.cushion_expected_moves).toBeGreaterThan(tight.cushion_expected_moves!);
  });

  it("applies a backwardation penalty when front IV >> back IV", () => {
    const calm = scoreRecommendation(baseInput({ iv_pct: 35, back_atm_iv_pct: 34 }));
    const backward = scoreRecommendation(baseInput({ iv_pct: 45, back_atm_iv_pct: 35 }));
    expect(backward.penalty_multiplier).toBeLessThan(1);
    expect(backward.score).toBeLessThan(calm.score);
    expect(backward.reason).toMatch(/backwardation/);
  });

  it("does not penalize contango (back > front)", () => {
    const r = scoreRecommendation(baseInput({ iv_pct: 30, back_atm_iv_pct: 35 }));
    expect(r.penalty_multiplier).toBe(1);
  });

  it("degrades gracefully when IV/RV/ATR are missing", () => {
    const r = scoreRecommendation(
      baseInput({ iv_pct: null, rv20_pct: null, atr20: null, back_atm_iv_pct: null }),
    );
    expect(r.iv_rv_ratio).toBeNull();
    expect(r.cushion_expected_moves).toBeNull();
    expect(r.term_slope_pct).toBeNull();
    // Only yield contributes: 9 / 15 * 0.30 * 100 = 18
    expect(r.score).toBeCloseTo(18, 0);
  });

  it("caps yield contribution at the reference point", () => {
    const at = scoreRecommendation(baseInput({ annualized_yield_pct: 15 }));
    const above = scoreRecommendation(baseInput({ annualized_yield_pct: 30 }));
    expect(above.score).toBeCloseTo(at.score, 5);
  });
});

describe("scoreRecommendation — Tier A additive", () => {
  it("rewards heavy put-OI dominance at strike", () => {
    const none = scoreRecommendation(baseInput({ oi_skew_score: 0, oi_skew_display: "" }));
    const heavy = scoreRecommendation(baseInput({ oi_skew_score: 1.0, oi_skew_display: "80% put OI" }));
    expect(heavy.score).toBeGreaterThan(none.score);
  });

  it("rewards a strike sitting on a technical level", () => {
    const off = scoreRecommendation(baseInput({ technical_score: 0 }));
    const on = scoreRecommendation(baseInput({ technical_score: 1.0, technical_display: "50d MA 1% away" }));
    expect(on.score).toBeGreaterThan(off.score);
    expect(on.reason).toMatch(/50d MA|MA|cushion|yield|IV/);
  });

  it("rewards RV at a high cone percentile", () => {
    const low = scoreRecommendation(baseInput({ rv_cone_percentile: 0.1 }));
    const high = scoreRecommendation(baseInput({ rv_cone_percentile: 0.9 }));
    expect(high.score).toBeGreaterThan(low.score);
  });
});

describe("scoreRecommendation — Tier A modifiers", () => {
  it("penalizes when ticker concentration is in the soft band (15-25% of BP)", () => {
    // existing 12k + this 9.2k = 21.2k on 100k BP = 21.2% → soft
    const clean = scoreRecommendation(baseInput({ existing_csp_collateral: 0 }));
    const conc = scoreRecommendation(baseInput({ existing_csp_collateral: 12_000 }));
    expect(conc.score).toBeLessThan(clean.score);
    expect(conc.modifiers.some((m) => m.key === "concentration")).toBe(true);
    expect(conc.reason).toMatch(/concentration/);
  });

  it("does not penalize concentration under the soft threshold", () => {
    const r = scoreRecommendation(baseInput({ existing_csp_collateral: 4_000 }));
    expect(r.modifiers.some((m) => m.key === "concentration")).toBe(false);
  });

  it("penalizes when user already holds a round lot (assignment overlap)", () => {
    const flat = scoreRecommendation(baseInput({ existing_long_shares: 0 }));
    const overlap = scoreRecommendation(baseInput({ existing_long_shares: 200 }));
    expect(overlap.score).toBeLessThan(flat.score);
    expect(overlap.modifiers.some((m) => m.key === "assignment_overlap")).toBe(true);
    expect(overlap.reason).toMatch(/already long/);
  });

  it("does not penalize when user holds fewer than 100 shares", () => {
    const r = scoreRecommendation(baseInput({ existing_long_shares: 50 }));
    expect(r.modifiers.some((m) => m.key === "assignment_overlap")).toBe(false);
  });

  it("compounds multiple modifiers multiplicatively", () => {
    const both = scoreRecommendation(
      baseInput({ existing_csp_collateral: 12_000, existing_long_shares: 300 }),
    );
    // 0.60 (concentration) * 0.75 (overlap) = 0.45
    expect(both.modifier_multiplier).toBeCloseTo(0.45, 2);
  });
});

describe("calcRv20Pct / calcAtr20", () => {
  it("calcRv20Pct returns null when given fewer than 21 closes", () => {
    expect(calcRv20Pct([])).toBeNull();
    expect(calcRv20Pct(Array(20).fill(100))).toBeNull();
  });

  it("calcRv20Pct returns ~0 for a flat series", () => {
    expect(calcRv20Pct(Array(25).fill(100))).toBeCloseTo(0, 5);
  });

  it("calcAtr20 computes mean absolute close-to-close change", () => {
    const series = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 100 : 102));
    expect(calcAtr20(series)).toBeCloseTo(2, 5);
  });
});

describe("pickBackExpiration", () => {
  it("picks the expiration closest to front + 60d", () => {
    expect(
      pickBackExpiration(
        ["2026-06-20", "2026-07-18", "2026-08-22", "2026-09-19", "2026-12-19"],
        "2026-06-20",
      ),
    ).toBe("2026-08-22");
  });

  it("returns null when no expirations sit after the front", () => {
    expect(pickBackExpiration(["2026-05-01"], "2026-06-20")).toBeNull();
  });
});

describe("atmIvPctFromChain", () => {
  const chainEntry = (s: number, mid_iv: number | null) => ({
    strike: s,
    option_type: "put" as const,
    bid: 1, ask: 1.2, bid_size: 10, ask_size: 10, open_interest: 100,
    delta: -0.5, mid_iv,
  });

  it("picks the put strike closest to spot and converts IV to percent", () => {
    const chain = [
      chainEntry(95, 0.30),
      chainEntry(100, 0.35),
      chainEntry(105, 0.40),
    ];
    expect(atmIvPctFromChain(chain, 101)).toBeCloseTo(35, 5);
  });

  it("returns null when no strikes have IV", () => {
    expect(atmIvPctFromChain([chainEntry(100, null)], 100)).toBeNull();
  });
});

describe("calcOiSkew", () => {
  const opt = (s: number, type: "put" | "call", oi: number) => ({
    strike: s, option_type: type, bid: 0.5, ask: 0.6,
    bid_size: 10, ask_size: 10, open_interest: oi, delta: null, mid_iv: null,
  });

  it("returns 1.0 score when OI is overwhelmingly puts in the band", () => {
    const chain = [
      opt(95, "put", 500), opt(95, "call", 50),
      opt(100, "put", 800), opt(100, "call", 100),
      opt(105, "put", 300), opt(105, "call", 50),
    ];
    const { score } = calcOiSkew(chain, 100);
    expect(score).toBe(1);
  });

  it("returns 0 when OI is balanced", () => {
    const chain = [
      opt(100, "put", 200), opt(100, "call", 200),
    ];
    expect(calcOiSkew(chain, 100).score).toBe(0);
  });

  it("returns 0 with thin OI", () => {
    expect(
      calcOiSkew([opt(100, "put", 10), opt(100, "call", 10)], 100).score,
    ).toBe(0);
  });
});

describe("calcTechnicalLevel", () => {
  it("rewards strike within 3% of a 50d MA", () => {
    const closes = Array(60).fill(100);
    const { score, display } = calcTechnicalLevel(closes, 99, 100);
    expect(score).toBe(1);
    expect(display).toMatch(/50d MA/);
  });

  it("partial credit between 3% and 5%", () => {
    const closes = Array(60).fill(100);
    expect(calcTechnicalLevel(closes, 96, 100).score).toBe(0.5);
  });

  it("no credit beyond 5%", () => {
    const closes = Array(60).fill(100);
    expect(calcTechnicalLevel(closes, 90, 100).score).toBe(0);
  });

  it("returns 0 score with display=null when too few closes", () => {
    expect(calcTechnicalLevel(Array(10).fill(100), 100, 100).score).toBe(0);
  });
});

describe("calcRvConePercentile", () => {
  it("returns null when there's too little history", () => {
    expect(calcRvConePercentile(Array(25).fill(100))).toBeNull();
  });

  it("returns ~1.0 when recent vol spikes above the trailing range", () => {
    const calm = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));
    const wild = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 3 : -3));
    const pct = calcRvConePercentile([...calm, ...wild])!;
    expect(pct).toBeGreaterThan(0.8);
  });

  it("returns a low percentile when recent vol is below the trailing range", () => {
    const wild = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 3 : -3));
    const calm = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 0.05 : -0.05));
    const pct = calcRvConePercentile([...wild, ...calm])!;
    expect(pct).toBeLessThan(0.3);
  });
});

describe("passesDepthFilter", () => {
  it("passes when ask depth is small (no signal to filter on)", () => {
    expect(passesDepthFilter(0, 2)).toBe(true);
  });

  it("rejects when bid is zero and ask has real depth", () => {
    expect(passesDepthFilter(0, 50)).toBe(false);
  });

  it("rejects when bid/ask ratio is below 10%", () => {
    expect(passesDepthFilter(2, 50)).toBe(false);
  });

  it("passes when bid/ask ratio is healthy", () => {
    expect(passesDepthFilter(20, 50)).toBe(true);
  });
});
