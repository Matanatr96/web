// Composite ranking for CSP candidates.
//
// Tier-S (74% of additive weight): annualized yield, IV-vs-realized-vol gap,
// ATR-normalized OTM cushion. Plus a hard term-structure backwardation penalty.
//
// Tier-A (26% additive + book-state modifiers): put/call OI skew at the strike,
// strike sitting on a technical level (50d/200d MA or 60d low), RV cone position
// in trailing 1y. Modifiers: ticker concentration vs option BP, and assignment
// overlap with an existing long position. Bid-side depth is a hard pre-filter
// in `passesDepthFilter` — applied at candidate-selection time, not score time.
//
// Each candidate's final score is in [0, 100]: base composite × all modifiers × 100.
// `reason` surfaces the top two contributing factors plus active caveats.

import { fetchDatedHistoryCached, getOptionChain, type OptionQuote } from "@/lib/quotes";
import type { BookState } from "@/lib/book-state";

export type RankFactorKey =
  | "yield"
  | "ivgap"
  | "cushion"
  | "oi_skew"
  | "technical"
  | "rv_cone";

export type RankFactor = {
  key: RankFactorKey;
  weight: number;
  score: number;       // 0..1
  display: string;     // user-facing one-liner
  available: boolean;  // false = input data missing; excluded from base + renormalized
};

export type RankModifier = {
  // String rather than a closed union: the CC path adds its own modifier keys
  // (call_away_near_basis, ex_div_in_window). Keep the runtime contract loose.
  key: string;
  multiplier: number;  // <1 = penalty
  display: string;
};

export type RankInputs = {
  ticker: string;
  annualized_yield_pct: number;
  underlying_price: number;
  strike: number;
  dte: number;
  collateral: number;          // strike * 100
  iv_pct: number | null;
  rv20_pct: number | null;
  atr20: number | null;
  back_atm_iv_pct: number | null;
  // Tier-A extras
  oi_skew_score: number | null;        // 0..1, computed from chain
  oi_skew_display: string | null;
  technical_score: number | null;      // 0..1
  technical_display: string | null;
  rv_cone_percentile: number | null;   // 0..1 (1 = RV at all-time high in 1y)
  // Book state
  buying_power: number;
  existing_csp_collateral: number;     // $ already in open CSPs on this ticker
  existing_long_shares: number;        // shares held in this ticker
};

export type RankResult = {
  score: number;                  // 0..100, post-modifier
  factors: RankFactor[];
  modifiers: RankModifier[];
  iv_rv_ratio: number | null;
  cushion_expected_moves: number | null;
  term_slope_pct: number | null;
  penalty_multiplier: number;     // backwardation only (term-structure)
  modifier_multiplier: number;    // product of all RankModifier multipliers
  reason: string;
};

// Tier-S = premium-relative-to-risk + safety; Tier-A = supporting signals.
// `ivgap` is the cleanest edge signal so it leads. `yield` alone is collinear
// with IV at fixed delta/DTE, so it gets less weight than ivgap. `rv_cone` is
// partially redundant with ivgap (both reward elevated vol), so it's small.
export const WEIGHTS: Record<RankFactorKey, number> = {
  yield: 0.22,
  ivgap: 0.28,
  cushion: 0.24,
  oi_skew: 0.08,
  technical: 0.08,
  rv_cone: 0.06,
};

// Reference points for normalization (fixed, not min-max).
export const YIELD_REF_PCT = 20;
export const IVGAP_REF_RATIO = 1.5;
export const CUSHION_REF_MOVES = 1.5;

// Term-structure penalty thresholds.
export const TERM_BACKWARD_STRONG_PCT = 10;
export const TERM_BACKWARD_MILD_PCT = 5;
export const PENALTY_STRONG = 0.70;
export const PENALTY_MILD = 0.85;

// Concentration thresholds (% of option buying power on one ticker after fill).
export const CONCENTRATION_HARD_REJECT_PCT = 25;
const CONCENTRATION_SOFT_PCT = 15;
const CONCENTRATION_PENALTY = 0.60;

// Assignment-overlap: if user already has ≥1 round lot in this name, getting
// assigned doubles down on a directional bet they already hold.
const OVERLAP_SHARES_THRESHOLD = 100;
const OVERLAP_PENALTY = 0.75;

// Bid-side depth pre-filter: thin bid relative to ask = the printed mid is fantasy.
export const DEPTH_RATIO_FILTER = 0.10;
export const DEPTH_ASK_MIN = 5;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function scoreRecommendation(input: RankInputs): RankResult {
  // --- 1. Yield ---
  const yieldScore = clamp01(input.annualized_yield_pct / YIELD_REF_PCT);

  // --- 2. RV/IV gap ---
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

  // --- 3. ATR-normalized cushion ---
  let cushionExpectedMoves: number | null = null;
  let cushionScore = 0;
  let cushionAvailable = false;
  let cushionDisplay = "ATR cushion unavailable";
  if (input.atr20 != null && input.atr20 > 0 && input.dte > 0) {
    const expectedMove = input.atr20 * Math.sqrt(input.dte);
    const cushionDollars = input.underlying_price - input.strike;
    cushionExpectedMoves = expectedMove > 0 ? cushionDollars / expectedMove : 0;
    cushionScore = clamp01(cushionExpectedMoves / CUSHION_REF_MOVES);
    cushionAvailable = true;
    cushionDisplay = `${cushionExpectedMoves.toFixed(1)}× expected move cushion`;
  }

  // --- 4. Put/call OI skew at strike (Tier-A) ---
  // null = no chain/too thin → exclude from base + renormalize.
  // 0 with a display = real signal of "balanced OI" → keep at weight.
  const oiSkewAvailable = input.oi_skew_score != null;
  const oiSkewScore = input.oi_skew_score ?? 0;
  const oiSkewDisplay = input.oi_skew_display ?? "OI skew unavailable";

  // --- 5. Strike on technical level (Tier-A) ---
  const technicalAvailable = input.technical_score != null;
  const technicalScore = input.technical_score ?? 0;
  const technicalDisplay = input.technical_display ?? "no nearby level";

  // --- 6. RV cone position (Tier-A) ---
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

  // Renormalize over available factors so a ticker with sparse Tier-A data
  // isn't structurally penalized vs one with full data.
  const available = factors.filter((f) => f.available);
  const totalAvailableWeight = available.reduce((s, f) => s + f.weight, 0);
  const base = totalAvailableWeight > 0
    ? available.reduce((acc, f) => acc + f.weight * f.score, 0) / totalAvailableWeight
    : 0;

  // --- Term-structure penalty (Tier-S hard modifier) ---
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

  // --- Tier-A modifiers ---
  const modifiers: RankModifier[] = [];

  // Concentration: existing CSP collateral + this rec, vs option BP.
  if (input.buying_power > 0) {
    const concentrationPct =
      ((input.existing_csp_collateral + input.collateral) / input.buying_power) * 100;
    if (concentrationPct >= CONCENTRATION_SOFT_PCT &&
        concentrationPct < CONCENTRATION_HARD_REJECT_PCT) {
      modifiers.push({
        key: "concentration",
        multiplier: CONCENTRATION_PENALTY,
        display: `concentration ${concentrationPct.toFixed(0)}% of BP`,
      });
    }
    // Hard reject (>=25%) is handled by the scanner before scoring runs.
  }

  // Assignment overlap: already holding a round lot of this name.
  if (input.existing_long_shares >= OVERLAP_SHARES_THRESHOLD) {
    modifiers.push({
      key: "assignment_overlap",
      multiplier: OVERLAP_PENALTY,
      display: `already long ${input.existing_long_shares} sh — assignment doubles bet`,
    });
  }

  const modifierMult = modifiers.reduce((acc, m) => acc * m.multiplier, 1);
  const finalScore = base * termPenalty * modifierMult * 100;

  // --- Reason string: top two drivers + caveats ---
  // Drivers are picked by weighted contribution so a small-weight factor with a
  // perfect score doesn't crowd out a heavy-weight factor with a moderate score.
  const sorted = [...factors]
    .filter((f) => f.available)
    .sort((a, b) => b.score * b.weight - a.score * a.weight);
  const drivers = sorted
    .filter((f) => f.score * f.weight >= 0.02)
    .slice(0, 2)
    .map((f) => f.display);

  const caveats: string[] = [];
  // Flag the weakest available Tier-S signal if it's hurting badly,
  // and separately flag if a Tier-S signal is missing entirely.
  const tierS = factors.filter((f) => f.key === "yield" || f.key === "ivgap" || f.key === "cushion");
  const tierSAvailable = tierS.filter((f) => f.available);
  const tierSMissing = tierS.filter((f) => !f.available);
  if (tierSAvailable.length > 0) {
    const weakest = [...tierSAvailable].sort((a, b) => a.score - b.score)[0];
    if (weakest.score < 0.25) caveats.push(`weak ${weakest.key}`);
  }
  for (const m of tierSMissing) caveats.push(`${m.key} unavailable`);
  if (termPenaltyReason) caveats.push(termPenaltyReason);
  for (const m of modifiers) caveats.push(m.display);

  let reason: string;
  if (drivers.length === 0) {
    reason = caveats.length > 0 ? `Penalized: ${caveats.join("; ")}` : "No standout factors";
  } else {
    reason = drivers.join(" · ");
    if (caveats.length > 0) reason += ` · ⚠ ${caveats.join("; ")}`;
  }

  return {
    score: finalScore,
    factors,
    modifiers,
    iv_rv_ratio: ivRvRatio,
    cushion_expected_moves: cushionExpectedMoves,
    term_slope_pct: termSlopePct,
    penalty_multiplier: termPenalty,
    modifier_multiplier: modifierMult,
    reason,
  };
}

// --- Tier-S data fetchers (existing) -------------------------------------

export function calcRv20Pct(closes: number[]): number | null {
  if (closes.length < 21) return null;
  const recent = closes.slice(-21);
  const logReturns = recent.slice(1).map((p, i) => Math.log(p / recent[i]));
  if (logReturns.length === 0) return null;
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

export function calcAtr20(closes: number[]): number | null {
  if (closes.length < 21) return null;
  const recent = closes.slice(-21);
  const trs = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
  if (trs.length === 0) return null;
  return trs.reduce((s, t) => s + t, 0) / trs.length;
}

// --- Tier-A: technical level proximity ----------------------------------

function simpleMa(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((s, c) => s + c, 0) / n;
}

// Bonus for the strike sitting near a relevant technical level.
// - direction="support" (CSP): 50d MA, 200d MA, 60d low — a strike that lands
//   on a defended floor has less assignment risk than naive delta implies.
// - direction="resistance" (CC): 50d MA, 200d MA, 60d high — a strike at a
//   ceiling has less call-away risk than naive delta implies.
// Returns [score 0..1, display string]. Within 3% of any level = 1.0, 5% = 0.5,
// further = 0. We pick the *closest* level so the reason names a specific anchor.
export function calcTechnicalLevel(
  closes: number[],
  strike: number,
  spot: number,
  direction: "support" | "resistance" = "support",
): { score: number; display: string | null } {
  if (closes.length < 50 || spot <= 0) return { score: 0, display: null };
  const ma50 = simpleMa(closes, 50);
  const ma200 = simpleMa(closes, 200);
  const extreme60 = closes.length >= 60
    ? (direction === "support"
        ? { name: "60d low", value: Math.min(...closes.slice(-60)) }
        : { name: "60d high", value: Math.max(...closes.slice(-60)) })
    : null;

  const levels: Array<{ name: string; value: number }> = [];
  if (ma50 != null) levels.push({ name: "50d MA", value: ma50 });
  if (ma200 != null) levels.push({ name: "200d MA", value: ma200 });
  if (extreme60 != null) levels.push(extreme60);
  if (levels.length === 0) return { score: 0, display: null };

  let bestScore = 0;
  let bestName: string | null = null;
  for (const lvl of levels) {
    const pctAway = Math.abs(strike - lvl.value) / spot;
    let s = 0;
    if (pctAway <= 0.03) s = 1;
    else if (pctAway <= 0.05) s = 0.5;
    if (s > bestScore) {
      bestScore = s;
      bestName = `${lvl.name} ${(pctAway * 100).toFixed(1)}% away`;
    }
  }
  return { score: bestScore, display: bestName };
}

// --- Tier-A: RV cone position --------------------------------------------

// Rolling 20d annualized RV at each step where there are ≥21 prior closes.
function rollingRv20Series(closes: number[]): number[] {
  if (closes.length < 22) return [];
  const out: number[] = [];
  for (let i = 21; i <= closes.length; i++) {
    const v = calcRv20Pct(closes.slice(0, i));
    if (v != null) out.push(v);
  }
  return out;
}

// Percentile rank of the most recent RV20 within the trailing-year cone (0..1).
// Higher = current realized vol is elevated relative to the past year, which the
// Tier-A theory says is a mean-reversion setup that often coincides with IV
// pricing in fear that won't be sustained.
export function calcRvConePercentile(closes: number[]): number | null {
  const series = rollingRv20Series(closes);
  if (series.length < 30) return null; // need at least a month of points
  const current = series[series.length - 1];
  const sorted = [...series].sort((a, b) => a - b);
  let rank = 0;
  for (const v of sorted) {
    if (v <= current) rank++;
  }
  return rank / sorted.length;
}

// --- Tier-A: OI skew at strike -------------------------------------------

// Same-side OI dominance in a ±N-strike band around the candidate strike.
// - side="put" (CSP): heavy put OI is a dealer-defended floor.
// - side="call" (CC): heavy call OI is a dealer-defended ceiling / gamma pin.
// In both cases the printed delta understates how much friction there is at
// that strike.
export function calcOiSkew(
  chain: OptionQuote[],
  strike: number,
  side: "put" | "call" = "put",
  bandStrikes = 2,
): { score: number; display: string | null } {
  const strikes = [...new Set(chain.map((o) => o.strike))].sort((a, b) => a - b);
  if (strikes.length === 0) return { score: 0, display: null };
  const idx = strikes.findIndex((s) => s >= strike);
  if (idx < 0) return { score: 0, display: null };
  const lo = strikes[Math.max(0, idx - bandStrikes)];
  const hi = strikes[Math.min(strikes.length - 1, idx + bandStrikes)];

  let putOi = 0;
  let callOi = 0;
  for (const o of chain) {
    if (o.strike < lo || o.strike > hi) continue;
    if (o.option_type === "put") putOi += o.open_interest;
    else if (o.option_type === "call") callOi += o.open_interest;
  }
  const total = putOi + callOi;
  if (total < 100) return { score: 0, display: "OI too thin" };

  const sameSideOi = side === "put" ? putOi : callOi;
  const share = sameSideOi / total;
  // Map 50%→0, 80%+→1, linear in between.
  const score = Math.max(0, Math.min(1, (share - 0.5) / 0.3));
  const label = side === "put" ? "put-OI" : "call-OI";
  const display = `${(share * 100).toFixed(0)}% ${label} dominance (±${bandStrikes} strikes)`;
  return { score, display };
}

// --- Bid-side depth pre-filter -------------------------------------------

// True = candidate is liquid enough for the printed mid to be realistic.
// We only filter when the ask side actually has size (avoiding false rejects
// when a feed returns 0 for both).
export function passesDepthFilter(bidSize: number, askSize: number): boolean {
  if (askSize < DEPTH_ASK_MIN) return true;
  if (bidSize <= 0) return false;
  return bidSize / askSize >= DEPTH_RATIO_FILTER;
}

// --- Combined fetchers (used by the scanner) -----------------------------

// Pull ~380 calendar days of history once per ticker, then derive RV20, ATR20,
// MAs, and the cone series from the same series.
export async function fetchHistoricalSignals(symbol: string): Promise<{
  closes: number[];
  rv20_pct: number | null;
  atr20: number | null;
  rv_cone_percentile: number | null;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 380);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = today.toISOString().slice(0, 10);
  try {
    const dated = await fetchDatedHistoryCached(symbol, startStr, endStr);
    const closes = dated.map((d) => d.close);
    return {
      closes,
      rv20_pct: calcRv20Pct(closes),
      atr20: calcAtr20(closes),
      rv_cone_percentile: calcRvConePercentile(closes),
    };
  } catch {
    return { closes: [], rv20_pct: null, atr20: null, rv_cone_percentile: null };
  }
}

export function pickBackExpiration(
  expirations: string[],
  frontExpiration: string,
): string | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDte =
    Math.round(
      (new Date(frontExpiration + "T00:00:00").getTime() - today.getTime()) / 86_400_000,
    ) + 60;
  const candidates = expirations
    .filter((d) => d > frontExpiration)
    .map((d) => ({
      date: d,
      dte: Math.round(
        (new Date(d + "T00:00:00").getTime() - today.getTime()) / 86_400_000,
      ),
    }));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
  return candidates[0].date;
}

export function atmIvPctFromChain(chain: OptionQuote[], spot: number): number | null {
  const withIv = chain.filter((o) => o.mid_iv != null && o.mid_iv > 0);
  if (withIv.length === 0) return null;
  const puts = withIv.filter((o) => o.option_type === "put");
  const pool = puts.length > 0 ? puts : withIv;
  pool.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  return pool[0].mid_iv! * 100;
}

// Shared finalizer used by both CSP and CC scoring: takes an already-computed
// factor set + modifier list and produces a normalized 0..100 score plus the
// reason string. The caller owns interpretation (which factors and modifiers
// make sense for its side); this only handles the common math + presentation.
export function finalizeRankScore(args: {
  factors: RankFactor[];
  modifiers: RankModifier[];
  termPenalty: number;
  termPenaltyReason: string | null;
  ivRvRatio: number | null;
  cushionExpectedMoves: number | null;
  termSlopePct: number | null;
}): RankResult {
  const { factors, modifiers, termPenalty, termPenaltyReason } = args;

  const available = factors.filter((f) => f.available);
  const totalAvailableWeight = available.reduce((s, f) => s + f.weight, 0);
  const base = totalAvailableWeight > 0
    ? available.reduce((acc, f) => acc + f.weight * f.score, 0) / totalAvailableWeight
    : 0;

  const modifierMult = modifiers.reduce((acc, m) => acc * m.multiplier, 1);
  const finalScore = base * termPenalty * modifierMult * 100;

  const sorted = [...factors]
    .filter((f) => f.available)
    .sort((a, b) => b.score * b.weight - a.score * a.weight);
  const drivers = sorted
    .filter((f) => f.score * f.weight >= 0.02)
    .slice(0, 2)
    .map((f) => f.display);

  const caveats: string[] = [];
  const tierS = factors.filter(
    (f) => f.key === "yield" || f.key === "ivgap" || f.key === "cushion",
  );
  const tierSAvailable = tierS.filter((f) => f.available);
  const tierSMissing = tierS.filter((f) => !f.available);
  if (tierSAvailable.length > 0) {
    const weakest = [...tierSAvailable].sort((a, b) => a.score - b.score)[0];
    if (weakest.score < 0.25) caveats.push(`weak ${weakest.key}`);
  }
  for (const m of tierSMissing) caveats.push(`${m.key} unavailable`);
  if (termPenaltyReason) caveats.push(termPenaltyReason);
  for (const m of modifiers) caveats.push(m.display);

  let reason: string;
  if (drivers.length === 0) {
    reason = caveats.length > 0 ? `Penalized: ${caveats.join("; ")}` : "No standout factors";
  } else {
    reason = drivers.join(" · ");
    if (caveats.length > 0) reason += ` · ⚠ ${caveats.join("; ")}`;
  }

  return {
    score: finalScore,
    factors,
    modifiers,
    iv_rv_ratio: args.ivRvRatio,
    cushion_expected_moves: args.cushionExpectedMoves,
    term_slope_pct: args.termSlopePct,
    penalty_multiplier: termPenalty,
    modifier_multiplier: modifierMult,
    reason,
  };
}

export async function fetchBackAtmIvPct(
  symbol: string,
  expirations: string[],
  frontExpiration: string,
  spot: number,
): Promise<number | null> {
  const back = pickBackExpiration(expirations, frontExpiration);
  if (!back) return null;
  try {
    const chain = await getOptionChain(symbol, back);
    return atmIvPctFromChain(chain, spot);
  } catch {
    return null;
  }
}

