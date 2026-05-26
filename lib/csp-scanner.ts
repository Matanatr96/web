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
import { findDiscoveryCandidates, type DiscoveryDiagnostics } from "@/lib/csp-discovery";
import {
  startScanMetrics,
  finishScanMetrics,
  runWithConcurrency,
  type ScanMetrics,
} from "@/lib/scan-metrics";
import type { WatchlistItem } from "@/lib/types";

// Cap concurrent per-ticker work to stay under Tradier's ~120 req/min ceiling.
// Each ticker fires ~2 chain fetches + a history fetch in parallel inside the
// loop, so concurrency=5 ≈ 15 in-flight requests at peak.
const PER_TICKER_CONCURRENCY = 5;

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
  // "watchlist" = user-curated ticker; "discovered" = surfaced by the
  // universe prefilter. Discovered picks are NOT emailed in v1 — they only
  // show in the admin preview UI.
  source: "watchlist" | "discovered";
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
type BestPut = Pick<CspRecommendation,
  "underlying_price" | "expiration" | "dte" | "strike" | "bid" | "ask"
  | "delta" | "collateral" | "premium_per_contract" | "annualized_yield_pct"
  | "otm_pct" | "iv_pct"
>;

export type CspPickOutcome =
  | "ok"
  | "no_quote"
  | "no_expiration"
  | "no_band_candidate"
  | "capital_too_low"
  | "concentration_reject"
  | "error";

function bestPutInBand(
  chain: OptionQuote[],
  underlyingPrice: number,
  expiration: string,
  buyingPower: number,
): { pick: BestPut | null; reason: CspPickOutcome } {
  const dte = dteOf(expiration);
  if (dte <= 0) return { pick: null, reason: "no_expiration" };

  const candidates: BestPut[] = [];
  // Track whether any candidate passed liquidity but failed only the BP check —
  // distinguishes "scanner found nothing tradeable" from "BP too low".
  let liquidPassedButOverBp = false;
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
    if (collateral > buyingPower) {
      liquidPassedButOverBp = true;
      continue;
    }

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

  if (candidates.length === 0) {
    return {
      pick: null,
      reason: liquidPassedButOverBp ? "capital_too_low" : "no_band_candidate",
    };
  }
  candidates.sort((a, b) => b.annualized_yield_pct - a.annualized_yield_pct);
  return { pick: candidates[0], reason: "ok" };
}

export type CspDiagnostics = {
  watchlist_size: number;
  outcomes: Record<CspPickOutcome, number>;
  per_ticker: Array<{
    ticker: string;
    outcome: CspPickOutcome;
    detail?: string;
    source: "watchlist" | "discovered";
  }>;
  discovery?: DiscoveryDiagnostics;
};

export type ScanResult = {
  buying_power: number;
  recommendations: CspRecommendation[];
  diagnostics: CspDiagnostics;
  metrics: ScanMetrics | null;
};

export type ScanOptions = {
  // Enable the universe prefilter and merge discovered tickers into the scan.
  // Off by default so existing callers (legacy paths) are unaffected.
  discover?: boolean;
};

function emptyOutcomes(): Record<CspPickOutcome, number> {
  return {
    ok: 0,
    no_quote: 0,
    no_expiration: 0,
    no_band_candidate: 0,
    capital_too_low: 0,
    concentration_reject: 0,
    error: 0,
  };
}

export async function scanWatchlistForCsps(opts: ScanOptions = {}): Promise<ScanResult> {
  startScanMetrics();
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`watchlist fetch: ${error.message}`);
  const items = (data ?? []) as WatchlistItem[];
  if (items.length === 0 && !opts.discover) {
    return {
      buying_power: 0,
      recommendations: [],
      diagnostics: { watchlist_size: 0, outcomes: emptyOutcomes(), per_ticker: [] },
      metrics: finishScanMetrics(),
    };
  }

  const balances = await getAccountBalances();
  const buyingPower = balances?.option_buying_power ?? 0;
  if (buyingPower <= 0) {
    // Every ticker would fail capital_too_low — surface that clearly.
    const outcomes = emptyOutcomes();
    outcomes.capital_too_low = items.length;
    return {
      buying_power: 0,
      recommendations: [],
      diagnostics: {
        watchlist_size: items.length,
        outcomes,
        per_ticker: items.map((i) => ({
          ticker: i.ticker,
          outcome: "capital_too_low" as const,
          source: "watchlist" as const,
        })),
      },
      metrics: finishScanMetrics(),
    };
  }

  const bookState = await fetchBookState();
  const watchlistTickers = items.map((i) => i.ticker);

  // Build the combined scan set: watchlist + (optional) discovered tickers.
  // Discovered tickers come from the universe prefilter and are tagged so
  // the cron route can exclude them from emails while the admin UI shows
  // them alongside watchlist picks.
  let discoveredTickers: string[] = [];
  let discoveryDiag: DiscoveryDiagnostics | undefined;
  if (opts.discover) {
    const excluded = new Set(watchlistTickers.map((t) => t.toUpperCase()));
    const d = await findDiscoveryCandidates({ buyingPower, excluded });
    discoveredTickers = d.tickers;
    discoveryDiag = d.diagnostics;
  }

  const allTickers = [...watchlistTickers, ...discoveredTickers];
  const sourceByTicker = new Map<string, "watchlist" | "discovered">();
  for (const t of watchlistTickers) sourceByTicker.set(t, "watchlist");
  for (const t of discoveredTickers) sourceByTicker.set(t, "discovered");

  const quotes = await getWatchlistQuotes(allTickers);

  type TickerResult = { pick: CspRecommendation | null; outcome: CspPickOutcome; detail?: string };

  const perTicker: TickerResult[] = await runWithConcurrency(
    allTickers,
    PER_TICKER_CONCURRENCY,
    async (ticker): Promise<TickerResult> => {
      const quote: StockQuote | undefined = quotes.get(ticker);
      if (!quote?.last) return { pick: null, outcome: "no_quote" };
      try {
        const expirations = await getExpirations(ticker);
        const expiration = pickExpiration(expirations);
        if (!expiration) return { pick: null, outcome: "no_expiration" };

        const [chain, hist, backIvPct] = await Promise.all([
          getOptionChain(ticker, expiration),
          fetchHistoricalSignals(ticker),
          fetchBackAtmIvPct(ticker, expirations, expiration, quote.last),
        ]);

        const { pick: best, reason } = bestPutInBand(chain, quote.last, expiration, buyingPower);
        if (!best) return { pick: null, outcome: reason };

        const existingCsp = bookState.openCspCollateral.get(ticker) ?? 0;
        const concentrationPct =
          ((existingCsp + best.collateral) / buyingPower) * 100;
        // Hard reject before scoring — keeps the alert list focused on names
        // the user actually has room to add to.
        if (concentrationPct >= CONCENTRATION_HARD_REJECT_PCT) {
          return { pick: null, outcome: "concentration_reject", detail: `${concentrationPct.toFixed(0)}% of BP` };
        }

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
          pick: {
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
            source: sourceByTicker.get(ticker) ?? "watchlist",
          },
          outcome: "ok",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { pick: null, outcome: "error", detail: msg };
      }
    },
  );

  const outcomes = emptyOutcomes();
  const per_ticker: CspDiagnostics["per_ticker"] = [];
  const recommendations: CspRecommendation[] = [];
  for (let i = 0; i < allTickers.length; i++) {
    const r = perTicker[i];
    outcomes[r.outcome] += 1;
    per_ticker.push({
      ticker: allTickers[i],
      outcome: r.outcome,
      detail: r.detail,
      source: sourceByTicker.get(allTickers[i]) ?? "watchlist",
    });
    if (r.pick) recommendations.push(r.pick);
  }
  recommendations.sort((a, b) => b.rank_score - a.rank_score);

  return {
    buying_power: buyingPower,
    recommendations,
    diagnostics: {
      watchlist_size: items.length,
      outcomes,
      per_ticker,
      discovery: discoveryDiag,
    },
    metrics: finishScanMetrics(),
  };
}
