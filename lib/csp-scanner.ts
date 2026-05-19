// CSP idle-capital scanner.
//
// For each ticker on the watchlist, finds the most attractive cash-secured put
// in the 0.10–0.20 delta band that fits the user's option buying power, with a
// liquidity filter mirroring the rest of the codebase. Cross-ticker ranking is
// a Tier-S + Tier-A composite (see `lib/csp-ranking.ts`) plus book-state-aware
// modifiers (concentration vs option BP, assignment overlap with held shares).
// Bid-side depth is a hard pre-filter applied while picking the per-ticker best.
// The cron route filters this list against the `sent_alerts` dedup table before
// emailing.

import { getServiceClient } from "@/lib/supabase";
import { getAccountBalances } from "@/lib/balances";
import {
  getWatchlistQuotes,
  getExpirations,
  getOptionChain,
  type OptionQuote,
  type StockQuote,
} from "@/lib/quotes";
import {
  scoreRecommendation,
  fetchHistoricalSignals,
  fetchBackAtmIvPct,
  calcTechnicalLevel,
  calcOiSkew,
  passesDepthFilter,
  CONCENTRATION_HARD_REJECT_PCT,
} from "@/lib/csp-ranking";
import { fetchBookState } from "@/lib/book-state";
import type { WatchlistItem } from "@/lib/types";

// v1: hardcoded. Admin override is v2.
export const DELTA_MIN = 0.10;
export const DELTA_MAX = 0.20;

// Liquidity gate: skip strikes with bid=0 or (ask-bid)/mid > 30%.
const MAX_SPREAD_PCT = 0.30;

// Expiration window: prefer 21–45 DTE, fall back to 14–60.
const DTE_TARGET = 35;
const DTE_MIN = 14;
const DTE_MAX = 60;

export type CspRecommendation = {
  ticker: string;
  underlying_price: number;
  expiration: string;
  dte: number;
  strike: number;
  bid: number;
  ask: number;
  delta: number;            // absolute value
  collateral: number;       // strike * 100
  premium_per_contract: number;
  annualized_yield_pct: number;
  otm_pct: number;
  iv_pct: number | null;
  // Ranking outputs — populated after cross-ticker scoring.
  rank_score: number;
  rank_reason: string;
  rv20_pct: number | null;
  iv_rv_ratio: number | null;
  cushion_expected_moves: number | null;
  term_slope_pct: number | null;
  // Tier-A telemetry
  oi_skew_score: number | null;
  technical_score: number | null;
  rv_cone_percentile: number | null;
  concentration_pct: number | null;
  existing_long_shares: number;
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

// Per-ticker best put: within the delta band, applies spread + depth filters,
// then picks the highest annualized-yield contract that fits buying power. The
// richer cross-ticker scoring is done downstream — within-ticker selection
// stays simple to keep the search tractable.
function bestPutInBand(
  chain: OptionQuote[],
  underlyingPrice: number,
  expiration: string,
  buyingPower: number,
): Pick<CspRecommendation,
  "underlying_price" | "expiration" | "dte" | "strike" | "bid" | "ask"
  | "delta" | "collateral" | "premium_per_contract" | "annualized_yield_pct"
  | "otm_pct" | "iv_pct"
> | null {
  const dte = dteOf(expiration);
  if (dte <= 0) return null;

  const candidates: Array<NonNullable<ReturnType<typeof bestPutInBand>>> = [];
  for (const opt of chain) {
    if (opt.option_type !== "put") continue;
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

    const collateral = opt.strike * 100;
    if (collateral > buyingPower) continue;

    const annualized_yield_pct = (bid / opt.strike) * (365 / dte) * 100;

    candidates.push({
      underlying_price: underlyingPrice,
      expiration,
      dte,
      strike: opt.strike,
      bid,
      ask,
      delta: absDelta,
      collateral,
      premium_per_contract: bid * 100,
      annualized_yield_pct,
      otm_pct: ((underlyingPrice - opt.strike) / underlyingPrice) * 100,
      iv_pct: opt.mid_iv != null ? opt.mid_iv * 100 : null,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.annualized_yield_pct - a.annualized_yield_pct);
  return candidates[0];
}

export type ScanResult = {
  buying_power: number;
  recommendations: CspRecommendation[];
};

export async function scanWatchlistForCsps(): Promise<ScanResult> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`watchlist fetch: ${error.message}`);
  const items = (data ?? []) as WatchlistItem[];
  if (items.length === 0) return { buying_power: 0, recommendations: [] };

  const balances = await getAccountBalances();
  const buyingPower = balances?.option_buying_power ?? 0;
  if (buyingPower <= 0) return { buying_power: 0, recommendations: [] };

  const bookState = await fetchBookState();
  const tickers = items.map((i) => i.ticker);
  const quotes = await getWatchlistQuotes(tickers);

  const perTicker = await Promise.all(
    tickers.map(async (ticker): Promise<CspRecommendation | null> => {
      const quote: StockQuote | undefined = quotes.get(ticker);
      if (!quote?.last) return null;
      try {
        const expirations = await getExpirations(ticker);
        const expiration = pickExpiration(expirations);
        if (!expiration) return null;

        const [chain, hist, backIvPct] = await Promise.all([
          getOptionChain(ticker, expiration),
          fetchHistoricalSignals(ticker),
          fetchBackAtmIvPct(ticker, expirations, expiration, quote.last),
        ]);

        const best = bestPutInBand(chain, quote.last, expiration, buyingPower);
        if (!best) return null;

        const existingCsp = bookState.openCspCollateral.get(ticker) ?? 0;
        const concentrationPct =
          ((existingCsp + best.collateral) / buyingPower) * 100;
        // Hard reject before scoring — keeps the alert list focused on names
        // the user actually has room to add to.
        if (concentrationPct >= CONCENTRATION_HARD_REJECT_PCT) return null;

        const existingLongShares = bookState.longShares.get(ticker) ?? 0;
        const oiSkew = calcOiSkew(chain, best.strike);
        const technical = calcTechnicalLevel(hist.closes, best.strike, quote.last);

        const ranked = scoreRecommendation({
          ticker,
          annualized_yield_pct: best.annualized_yield_pct,
          underlying_price: best.underlying_price,
          strike: best.strike,
          dte: best.dte,
          collateral: best.collateral,
          iv_pct: best.iv_pct,
          rv20_pct: hist.rv20_pct,
          atr20: hist.atr20,
          back_atm_iv_pct: backIvPct,
          oi_skew_score: oiSkew.score,
          oi_skew_display: oiSkew.display,
          technical_score: technical.score,
          technical_display: technical.display,
          rv_cone_percentile: hist.rv_cone_percentile,
          buying_power: buyingPower,
          existing_csp_collateral: existingCsp,
          existing_long_shares: existingLongShares,
        });

        return {
          ...best,
          ticker,
          rv20_pct: hist.rv20_pct,
          iv_rv_ratio: ranked.iv_rv_ratio,
          cushion_expected_moves: ranked.cushion_expected_moves,
          term_slope_pct: ranked.term_slope_pct,
          rank_score: ranked.score,
          rank_reason: ranked.reason,
          oi_skew_score: oiSkew.score,
          technical_score: technical.score,
          rv_cone_percentile: hist.rv_cone_percentile,
          concentration_pct: concentrationPct,
          existing_long_shares: existingLongShares,
        };
      } catch {
        return null;
      }
    }),
  );

  const recommendations = perTicker
    .filter((r): r is CspRecommendation => r !== null)
    .sort((a, b) => b.rank_score - a.rank_score);

  return { buying_power: buyingPower, recommendations };
}
