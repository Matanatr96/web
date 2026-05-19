// Composite ranking for covered-call candidates.
//
// Mirrors lib/csp-ranking with side-flipped interpretations:
// - cushion: dollars *above* spot (OTM call), normalized by expected move
// - oi_skew: call-OI dominance at strike (dealer-defended ceiling / gamma pin)
// - technical: strike near a resistance level (50d/200d MA, 60d high)
//
// Modifiers diverge entirely:
// - call_away_near_basis: strike < cost_basis × 1.02 → premium offset to a
//   weak realized gain; soft penalty. (strike < cost_basis is rejected
//   upstream by the scanner — that's a guaranteed loss.)
// - ex_div_in_window: an ex-dividend date falls inside the contract's DTE
//   window → early-assignment risk for ITM calls + losing the dividend if
//   called. Penalty since 0.15–0.30 delta calls can drift ITM fast.

import {
  WEIGHTS,
  YIELD_REF_PCT,
  IVGAP_REF_RATIO,
  CUSHION_REF_MOVES,
  TERM_BACKWARD_STRONG_PCT,
  TERM_BACKWARD_MILD_PCT,
  PENALTY_STRONG,
  PENALTY_MILD,
  clamp01,
  finalizeRankScore,
  type RankFactor,
  type RankModifier,
  type RankResult,
} from "@/lib/csp-ranking";

export type CcRankInputs = {
  ticker: string;
  annualized_yield_pct: number;
  underlying_price: number;
  strike: number;
  dte: number;
  iv_pct: number | null;
  rv20_pct: number | null;
  atr20: number | null;
  back_atm_iv_pct: number | null;
  oi_skew_score: number | null;
  oi_skew_display: string | null;
  technical_score: number | null;
  technical_display: string | null;
  rv_cone_percentile: number | null;
  // CC-specific book state
  cost_basis: number | null;
  ex_div_in_window: boolean;
};

// Soft caveat: strike below cost-basis × this multiplier → "weak realized gain".
const COST_BASIS_HEADROOM_MULT = 1.02;
const COST_BASIS_NEAR_PENALTY = 0.85;

// Ex-div penalty: an ex-div inside DTE for an OTM short call risks early
// assignment if the call drifts ITM near the date, and you lose the dividend
// if called.
const EX_DIV_PENALTY = 0.80;

export function scoreCcRecommendation(input: CcRankInputs): RankResult {
  // --- 1. Yield ---
  const yieldScore = clamp01(input.annualized_yield_pct / YIELD_REF_PCT);

  // --- 2. IV vs RV gap (symmetric to CSP) ---
  let ivRvRatio: number | null = null;
  let ivgapScore = 0;
  let ivgapAvailable = false;
  let ivgapDisplay = "IV vs RV unavailable";
  if (
    input.iv_pct != null && input.iv_pct > 0 &&
    input.rv20_pct != null && input.rv20_pct > 0
  ) {
    ivRvRatio = input.iv_pct / input.rv20_pct;
    ivgapScore = clamp01((ivRvRatio - 1) / (IVGAP_REF_RATIO - 1));
    ivgapAvailable = true;
    ivgapDisplay = `IV ${input.iv_pct.toFixed(0)}% vs RV ${input.rv20_pct.toFixed(0)}% (${ivRvRatio.toFixed(2)}×)`;
  }

  // --- 3. ATR-normalized OTM cushion (strike above spot) ---
  let cushionExpectedMoves: number | null = null;
  let cushionScore = 0;
  let cushionAvailable = false;
  let cushionDisplay = "ATR cushion unavailable";
  if (input.atr20 != null && input.atr20 > 0 && input.dte > 0) {
    const expectedMove = input.atr20 * Math.sqrt(input.dte);
    const cushionDollars = input.strike - input.underlying_price; // flipped vs CSP
    cushionExpectedMoves = expectedMove > 0 ? cushionDollars / expectedMove : 0;
    cushionScore = clamp01(cushionExpectedMoves / CUSHION_REF_MOVES);
    cushionAvailable = true;
    cushionDisplay = `${cushionExpectedMoves.toFixed(1)}× expected move cushion`;
  }

  const oiSkewAvailable = input.oi_skew_score != null;
  const oiSkewScore = input.oi_skew_score ?? 0;
  const oiSkewDisplay = input.oi_skew_display ?? "OI skew unavailable";

  const technicalAvailable = input.technical_score != null;
  const technicalScore = input.technical_score ?? 0;
  const technicalDisplay = input.technical_display ?? "no nearby level";

  const rvConeAvailable = input.rv_cone_percentile != null;
  const rvConeScore = input.rv_cone_percentile ?? 0;
  const rvConeDisplay = input.rv_cone_percentile != null
    ? `RV at ${Math.round(input.rv_cone_percentile * 100)}th pct of 1y range`
    : "RV cone unavailable";

  const factors: RankFactor[] = [
    { key: "yield",     weight: WEIGHTS.yield,     score: yieldScore,     display: `${input.annualized_yield_pct.toFixed(1)}% ann. yield`, available: true },
    { key: "ivgap",     weight: WEIGHTS.ivgap,     score: ivgapScore,     display: ivgapDisplay,                                            available: ivgapAvailable },
    { key: "cushion",   weight: WEIGHTS.cushion,   score: cushionScore,   display: cushionDisplay,                                          available: cushionAvailable },
    { key: "oi_skew",   weight: WEIGHTS.oi_skew,   score: oiSkewScore,    display: oiSkewDisplay,                                           available: oiSkewAvailable },
    { key: "technical", weight: WEIGHTS.technical, score: technicalScore, display: technicalDisplay,                                        available: technicalAvailable },
    { key: "rv_cone",   weight: WEIGHTS.rv_cone,   score: rvConeScore,    display: rvConeDisplay,                                           available: rvConeAvailable },
  ];

  // --- Term-structure penalty (same shape as CSP) ---
  let termSlopePct: number | null = null;
  let termPenalty = 1.0;
  let termPenaltyReason: string | null = null;
  if (
    input.iv_pct != null && input.iv_pct > 0 &&
    input.back_atm_iv_pct != null && input.back_atm_iv_pct > 0
  ) {
    termSlopePct = ((input.iv_pct - input.back_atm_iv_pct) / input.back_atm_iv_pct) * 100;
    if (termSlopePct >= TERM_BACKWARD_STRONG_PCT) {
      termPenalty = PENALTY_STRONG;
      termPenaltyReason = `strong backwardation (front IV +${termSlopePct.toFixed(0)}% vs 60d)`;
    } else if (termSlopePct >= TERM_BACKWARD_MILD_PCT) {
      termPenalty = PENALTY_MILD;
      termPenaltyReason = `mild backwardation (front IV +${termSlopePct.toFixed(0)}% vs 60d)`;
    }
  }

  // --- CC modifiers ---
  const modifiers: RankModifier[] = [];

  if (
    input.cost_basis != null &&
    input.cost_basis > 0 &&
    input.strike < input.cost_basis * COST_BASIS_HEADROOM_MULT
  ) {
    const gainPct = ((input.strike - input.cost_basis) / input.cost_basis) * 100;
    modifiers.push({
      key: "call_away_near_basis",
      multiplier: COST_BASIS_NEAR_PENALTY,
      display: `strike only ${gainPct.toFixed(1)}% above basis`,
    });
  }

  if (input.ex_div_in_window) {
    modifiers.push({
      key: "ex_div_in_window",
      multiplier: EX_DIV_PENALTY,
      display: "ex-dividend date inside DTE",
    });
  }

  return finalizeRankScore({
    factors,
    modifiers,
    termPenalty,
    termPenaltyReason,
    ivRvRatio,
    cushionExpectedMoves,
    termSlopePct,
  });
}
