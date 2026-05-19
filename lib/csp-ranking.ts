// Ranks CSP candidates across tickers using four Tier-S signals:
//   1. Annualized yield (the target)
//   2. RV/IV gap — IV richness vs trailing 20d realized vol
//   3. Cushion in expected-move units — OTM buffer normalized by ATR·√DTE
//   4. IV term-structure slope — hard modifier; backwardation penalizes
//
// Each candidate gets a composite score in [0,1] and a human-readable reason
// surfacing the top two contributing factors plus any active penalty.

import { fetchDatedHistoryCached, getOptionChain, type OptionQuote } from "@/lib/quotes";

export type RankFactorKey = "yield" | "ivgap" | "cushion";

export type RankFactor = {
  key: RankFactorKey;
  weight: number;
  score: number; // 0..1
  display: string;
};

export type RankInputs = {
  annualized_yield_pct: number;
  underlying_price: number;
  strike: number;
  dte: number;
  iv_pct: number | null;        // candidate option IV, %
  rv20_pct: number | null;      // 20d annualized realized vol, %
  atr20: number | null;         // 20d close-to-close ATR, dollars
  back_atm_iv_pct: number | null; // ATM IV ~60d out, %
};

export type RankResult = {
  score: number;                  // 0..100 after penalty
  factors: RankFactor[];          // additive factors (top contributors)
  iv_rv_ratio: number | null;
  cushion_expected_moves: number | null;
  term_slope_pct: number | null;  // (front - back) / back * 100
  penalty_multiplier: number;     // 1 = none, <1 = backwardation
  reason: string;
};

// Weights sum to 1.0. Yield is the target, the other two are correctional.
const WEIGHTS: Record<RankFactorKey, number> = {
  yield: 0.40,
  ivgap: 0.30,
  cushion: 0.30,
};

// Reference points for normalization. Fixed (not min-max across batch) so a
// "good" score is good in absolute terms even with only 3 candidates.
const YIELD_REF_PCT = 15;       // 15% annualized = full score
const IVGAP_REF_RATIO = 1.5;    // IV is 50% above RV = full score
const CUSHION_REF_MOVES = 1.5;  // strike sits 1.5× expected move below spot = full

const TERM_BACKWARD_STRONG_PCT = 10; // front >10% above back → strong penalty
const TERM_BACKWARD_MILD_PCT = 5;
const PENALTY_STRONG = 0.70;
const PENALTY_MILD = 0.85;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function scoreRecommendation(input: RankInputs): RankResult {
  // 1. Yield factor — capped reference.
  const yieldScore = clamp01(input.annualized_yield_pct / YIELD_REF_PCT);

  // 2. RV/IV gap — only meaningful when both numbers exist.
  let ivRvRatio: number | null = null;
  let ivgapScore = 0;
  let ivgapDisplay = "IV vs RV unavailable";
  if (
    input.iv_pct != null && input.iv_pct > 0 &&
    input.rv20_pct != null && input.rv20_pct > 0
  ) {
    ivRvRatio = input.iv_pct / input.rv20_pct;
    // Reward ratio above 1.0; map [1.0 .. IVGAP_REF_RATIO] → [0..1].
    ivgapScore = clamp01((ivRvRatio - 1) / (IVGAP_REF_RATIO - 1));
    ivgapDisplay = `IV ${input.iv_pct.toFixed(0)}% vs RV ${input.rv20_pct.toFixed(0)}% (${ivRvRatio.toFixed(2)}×)`;
  }

  // 3. ATR-normalized cushion — strike's distance below spot in expected-move units.
  let cushionExpectedMoves: number | null = null;
  let cushionScore = 0;
  let cushionDisplay = "ATR cushion unavailable";
  if (input.atr20 != null && input.atr20 > 0 && input.dte > 0) {
    const expectedMove = input.atr20 * Math.sqrt(input.dte);
    const cushionDollars = input.underlying_price - input.strike;
    cushionExpectedMoves = expectedMove > 0 ? cushionDollars / expectedMove : 0;
    cushionScore = clamp01(cushionExpectedMoves / CUSHION_REF_MOVES);
    cushionDisplay = `${cushionExpectedMoves.toFixed(1)}× expected move cushion`;
  }

  const factors: RankFactor[] = [
    {
      key: "yield",
      weight: WEIGHTS.yield,
      score: yieldScore,
      display: `${input.annualized_yield_pct.toFixed(1)}% ann. yield`,
    },
    { key: "ivgap", weight: WEIGHTS.ivgap, score: ivgapScore, display: ivgapDisplay },
    { key: "cushion", weight: WEIGHTS.cushion, score: cushionScore, display: cushionDisplay },
  ];

  const base = factors.reduce((acc, f) => acc + f.weight * f.score, 0);

  // 4. Term-structure penalty — backwardation = market pricing a near-term event.
  let termSlopePct: number | null = null;
  let penalty = 1.0;
  let penaltyReason: string | null = null;
  if (
    input.iv_pct != null && input.iv_pct > 0 &&
    input.back_atm_iv_pct != null && input.back_atm_iv_pct > 0
  ) {
    termSlopePct = ((input.iv_pct - input.back_atm_iv_pct) / input.back_atm_iv_pct) * 100;
    if (termSlopePct >= TERM_BACKWARD_STRONG_PCT) {
      penalty = PENALTY_STRONG;
      penaltyReason = `strong backwardation (front IV +${termSlopePct.toFixed(0)}% vs 60d)`;
    } else if (termSlopePct >= TERM_BACKWARD_MILD_PCT) {
      penalty = PENALTY_MILD;
      penaltyReason = `mild backwardation (front IV +${termSlopePct.toFixed(0)}% vs 60d)`;
    }
  }

  const finalScore = base * penalty * 100;

  // Reason: top 2 contributing factors (by weighted score), plus caveats.
  const sorted = [...factors].sort(
    (a, b) => b.score * b.weight - a.score * a.weight,
  );
  const drivers = sorted
    .filter((f) => f.score > 0.05)
    .slice(0, 2)
    .map((f) => f.display);
  const weakFactor = sorted[sorted.length - 1];
  const caveats: string[] = [];
  if (weakFactor && weakFactor.score < 0.35 && weakFactor.score > 0) {
    caveats.push(`weak ${weakFactor.key}`);
  }
  if (penaltyReason) caveats.push(penaltyReason);

  let reason: string;
  if (drivers.length === 0) {
    reason = penaltyReason ? `Penalized: ${penaltyReason}` : "No standout factors";
  } else {
    reason = drivers.join(" · ");
    if (caveats.length > 0) reason += ` · ⚠ ${caveats.join("; ")}`;
  }

  return {
    score: finalScore,
    factors,
    iv_rv_ratio: ivRvRatio,
    cushion_expected_moves: cushionExpectedMoves,
    term_slope_pct: termSlopePct,
    penalty_multiplier: penalty,
    reason,
  };
}

// --- Data fetchers -------------------------------------------------------

// 20d annualized historical volatility from closing prices, as a percent.
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

// Close-to-close ATR proxy in dollars. True ATR uses HLC; this is the
// best we can do from daily closes alone and is highly correlated.
export function calcAtr20(closes: number[]): number | null {
  if (closes.length < 21) return null;
  const recent = closes.slice(-21);
  const trs = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
  if (trs.length === 0) return null;
  return trs.reduce((s, t) => s + t, 0) / trs.length;
}

export async function fetchRvAndAtr(
  symbol: string,
): Promise<{ rv20_pct: number | null; atr20: number | null }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 45); // ~45 calendar days → ≥21 closes
  const startStr = start.toISOString().slice(0, 10);
  const endStr = today.toISOString().slice(0, 10);
  try {
    const dated = await fetchDatedHistoryCached(symbol, startStr, endStr);
    const closes = dated.map((d) => d.close);
    return { rv20_pct: calcRv20Pct(closes), atr20: calcAtr20(closes) };
  } catch {
    return { rv20_pct: null, atr20: null };
  }
}

// Pick the expiration nearest to ~60d after the front expiration we already
// chose, used as the "back month" for term-structure slope.
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

// ATM mid_iv (%) from a chain, picking the strike closest to spot. Uses puts
// to stay consistent with the CSP side; falls back to calls if needed.
export function atmIvPctFromChain(chain: OptionQuote[], spot: number): number | null {
  const withIv = chain.filter((o) => o.mid_iv != null && o.mid_iv > 0);
  if (withIv.length === 0) return null;
  const puts = withIv.filter((o) => o.option_type === "put");
  const pool = puts.length > 0 ? puts : withIv;
  pool.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  return pool[0].mid_iv! * 100;
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
