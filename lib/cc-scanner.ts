// Covered-call idle-shares scanner.
//
// For each ticker where the user owns uncovered shares (longShares - openCcShares
// >= 100), finds the most attractive short call in the 0.15-0.30 delta band that
// can be covered by available shares. Liquidity gate mirrors the CSP scanner.
// Cross-ticker ranking uses lib/cc-ranking (sign-flipped cushion, call-OI skew,
// resistance technical), plus CC-specific modifiers (call-away near basis,
// ex-dividend inside DTE).
//
// Hard filters:
//   - strike >= cost basis (no guaranteed realized loss on call-away)
//   - bid > 0, spread <= 30%, bid-side depth via passesDepthFilter
//   - shares available to cover the contract

import {
  getWatchlistQuotes,
  getExpirations,
  getOptionChain,
  getNextExDivDate,
  type OptionQuote,
  type StockQuote,
} from "@/lib/quotes";
import {
  fetchHistoricalSignals,
  fetchBackAtmIvPct,
  calcTechnicalLevel,
  calcOiSkew,
  passesDepthFilter,
} from "@/lib/csp-ranking";
import { scoreCcRecommendation } from "@/lib/cc-ranking";
import { fetchBookState } from "@/lib/book-state";

// Wider delta band than CSPs — see brainstorm. CCs are commonly written
// further OTM since you're capping upside, not floor.
export const DELTA_MIN = 0.15;
export const DELTA_MAX = 0.30;

const MAX_SPREAD_PCT = 0.30;

const DTE_TARGET = 35;
const DTE_MIN = 14;
const DTE_MAX = 60;

export type CcRecommendation = {
  ticker: string;
  underlying_price: number;
  expiration: string;
  dte: number;
  strike: number;
  bid: number;
  ask: number;
  delta: number;                  // absolute value
  shares_committed: number;       // 100 per contract
  premium_per_contract: number;
  annualized_yield_pct: number;
  otm_pct: number;
  iv_pct: number | null;
  cost_basis: number | null;
  uncovered_shares: number;
  next_ex_div_date: string | null;
  ex_div_in_window: boolean;
  // Ranking outputs
  rank_score: number;
  rank_reason: string;
  rv20_pct: number | null;
  iv_rv_ratio: number | null;
  cushion_expected_moves: number | null;
  term_slope_pct: number | null;
  oi_skew_score: number | null;
  technical_score: number | null;
  rv_cone_percentile: number | null;
};

function pickExpiration(dates: string[]): string | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const withDte = dates.map((d) => {
    const dte = Math.round(
      (new Date(d + "T00:00:00").getTime() - today.getTime()) / 86_400_000,
    );
    return { date: d, dte };
  });
  const window = withDte.filter(({ dte }) => dte >= 21 && dte <= 45);
  const pool = window.length > 0
    ? window
    : withDte.filter(({ dte }) => dte >= DTE_MIN && dte <= DTE_MAX);
  if (pool.length === 0) return null;
  pool.sort((a, b) => Math.abs(a.dte - DTE_TARGET) - Math.abs(b.dte - DTE_TARGET));
  return pool[0].date;
}

function dteOf(expiration: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round(
    (new Date(expiration + "T00:00:00").getTime() - today.getTime()) / 86_400_000,
  );
}

type BestCall = Pick<CcRecommendation,
  "underlying_price" | "expiration" | "dte" | "strike" | "bid" | "ask"
  | "delta" | "shares_committed" | "premium_per_contract"
  | "annualized_yield_pct" | "otm_pct" | "iv_pct"
>;

export type CcPickOutcome =
  | "ok"
  | "no_quote"
  | "no_expiration"
  | "no_band_candidate"
  | "below_basis"
  | "error";

function bestCallInBand(
  chain: OptionQuote[],
  underlyingPrice: number,
  expiration: string,
  uncoveredShares: number,
  costBasis: number | null,
): { pick: BestCall | null; reason: CcPickOutcome } {
  const dte = dteOf(expiration);
  if (dte <= 0) return { pick: null, reason: "no_expiration" };
  const maxContracts = Math.floor(uncoveredShares / 100);
  if (maxContracts < 1) return { pick: null, reason: "no_band_candidate" };

  const candidates: BestCall[] = [];
  // Track whether liquid candidates existed but all were rejected for sitting
  // below cost basis — distinguishes that from "no liquid OTM call at all".
  let liquidButBelowBasis = false;
  for (const opt of chain) {
    if (opt.option_type !== "call") continue;
    if (opt.delta == null) continue;
    const absDelta = Math.abs(opt.delta);
    if (absDelta < DELTA_MIN || absDelta > DELTA_MAX) continue;

    const bid = opt.bid;
    const ask = opt.ask;
    if (bid <= 0 || ask <= 0) continue;
    const mid = (bid + ask) / 2;
    const spreadPct = mid > 0 ? (ask - bid) / mid : 1;
    if (spreadPct > MAX_SPREAD_PCT) continue;
    if (!passesDepthFilter(opt.bid_size, opt.ask_size)) continue;

    // Hard filter: don't lock in a guaranteed realized loss.
    if (costBasis != null && opt.strike < costBasis) {
      liquidButBelowBasis = true;
      continue;
    }

    // Yield against the capital tied up — use spot (current value of the
    // shares being lent). This matches how CSPs use strike (collateral).
    const annualized_yield_pct = (bid / underlyingPrice) * (365 / dte) * 100;

    candidates.push({
      underlying_price: underlyingPrice,
      expiration,
      dte,
      strike: opt.strike,
      bid,
      ask,
      delta: absDelta,
      shares_committed: 100,
      premium_per_contract: bid * 100,
      annualized_yield_pct,
      otm_pct: ((opt.strike - underlyingPrice) / underlyingPrice) * 100,
      iv_pct: opt.mid_iv != null ? opt.mid_iv * 100 : null,
    });
  }

  if (candidates.length === 0) {
    return {
      pick: null,
      reason: liquidButBelowBasis ? "below_basis" : "no_band_candidate",
    };
  }
  candidates.sort((a, b) => b.annualized_yield_pct - a.annualized_yield_pct);
  return { pick: candidates[0], reason: "ok" };
}

export type CcDiagnostics = {
  uncovered_tickers: number;
  outcomes: Record<CcPickOutcome, number>;
  per_ticker: Array<{ ticker: string; outcome: CcPickOutcome; detail?: string }>;
};

export type CcScanResult = {
  recommendations: CcRecommendation[];
  diagnostics: CcDiagnostics;
};

function emptyCcOutcomes(): Record<CcPickOutcome, number> {
  return {
    ok: 0,
    no_quote: 0,
    no_expiration: 0,
    no_band_candidate: 0,
    below_basis: 0,
    error: 0,
  };
}

export async function scanHoldingsForCcs(): Promise<CcScanResult> {
  const bookState = await fetchBookState();

  const tickers: string[] = [];
  for (const [t, shares] of bookState.longShares) {
    const pledged = bookState.openCcShares.get(t) ?? 0;
    if (shares - pledged >= 100) tickers.push(t);
  }
  if (tickers.length === 0) {
    return {
      recommendations: [],
      diagnostics: { uncovered_tickers: 0, outcomes: emptyCcOutcomes(), per_ticker: [] },
    };
  }

  const quotes = await getWatchlistQuotes(tickers);

  type TickerResult = { pick: CcRecommendation | null; outcome: CcPickOutcome; detail?: string };

  const perTicker: TickerResult[] = await Promise.all(
    tickers.map(async (ticker): Promise<TickerResult> => {
      const quote: StockQuote | undefined = quotes.get(ticker);
      if (!quote?.last) return { pick: null, outcome: "no_quote" };
      const longShares = bookState.longShares.get(ticker) ?? 0;
      const pledged = bookState.openCcShares.get(ticker) ?? 0;
      const uncovered = longShares - pledged;
      const costBasis = bookState.costBasis.get(ticker) ?? null;
      try {
        const expirations = await getExpirations(ticker);
        const expiration = pickExpiration(expirations);
        if (!expiration) return { pick: null, outcome: "no_expiration" };

        const [chain, hist, backIvPct, nextExDiv] = await Promise.all([
          getOptionChain(ticker, expiration),
          fetchHistoricalSignals(ticker),
          fetchBackAtmIvPct(ticker, expirations, expiration, quote.last),
          getNextExDivDate(ticker),
        ]);

        const { pick: best, reason } = bestCallInBand(chain, quote.last, expiration, uncovered, costBasis);
        if (!best) return { pick: null, outcome: reason };

        const oiSkew = calcOiSkew(chain, best.strike, "call");
        const technical = calcTechnicalLevel(hist.closes, best.strike, quote.last, "resistance");
        const exDivInWindow =
          nextExDiv != null && nextExDiv <= expiration && nextExDiv >= new Date().toISOString().slice(0, 10);

        const ranked = scoreCcRecommendation({
          ticker,
          annualized_yield_pct: best.annualized_yield_pct,
          underlying_price: best.underlying_price,
          strike: best.strike,
          dte: best.dte,
          iv_pct: best.iv_pct,
          rv20_pct: hist.rv20_pct,
          atr20: hist.atr20,
          back_atm_iv_pct: backIvPct,
          oi_skew_score: oiSkew.score,
          oi_skew_display: oiSkew.display,
          technical_score: technical.score,
          technical_display: technical.display,
          rv_cone_percentile: hist.rv_cone_percentile,
          cost_basis: costBasis,
          ex_div_in_window: exDivInWindow,
        });

        return {
          pick: {
            ...best,
            ticker,
            cost_basis: costBasis,
            uncovered_shares: uncovered,
            next_ex_div_date: nextExDiv,
            ex_div_in_window: exDivInWindow,
            rv20_pct: hist.rv20_pct,
            iv_rv_ratio: ranked.iv_rv_ratio,
            cushion_expected_moves: ranked.cushion_expected_moves,
            term_slope_pct: ranked.term_slope_pct,
            rank_score: ranked.score,
            rank_reason: ranked.reason,
            oi_skew_score: oiSkew.score,
            technical_score: technical.score,
            rv_cone_percentile: hist.rv_cone_percentile,
          },
          outcome: "ok",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { pick: null, outcome: "error", detail: msg };
      }
    }),
  );

  const outcomes = emptyCcOutcomes();
  const per_ticker: CcDiagnostics["per_ticker"] = [];
  const recommendations: CcRecommendation[] = [];
  for (let i = 0; i < tickers.length; i++) {
    const r = perTicker[i];
    outcomes[r.outcome] += 1;
    per_ticker.push({ ticker: tickers[i], outcome: r.outcome, detail: r.detail });
    if (r.pick) recommendations.push(r.pick);
  }
  recommendations.sort((a, b) => b.rank_score - a.rank_score);

  return {
    recommendations,
    diagnostics: { uncovered_tickers: tickers.length, outcomes, per_ticker },
  };
}
