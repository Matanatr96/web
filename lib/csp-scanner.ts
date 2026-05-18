// CSP idle-capital scanner.
//
// For each ticker on the watchlist, finds the most attractive cash-secured put
// in the 0.10–0.20 delta band that fits the user's option buying power, with a
// liquidity filter mirroring the rest of the codebase. Returns a ranked list
// sorted by annualized yield. The cron route filters this list against the
// `sent_alerts` dedup table before emailing.

import { getServiceClient } from "@/lib/supabase";
import { getAccountBalances } from "@/lib/balances";
import {
  getWatchlistQuotes,
  getExpirations,
  getOptionChain,
  type OptionQuote,
  type StockQuote,
} from "@/lib/quotes";
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
  premium_per_contract: number; // bid * 100
  annualized_yield_pct: number; // (bid / strike) * (365 / dte) * 100
  otm_pct: number;
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

function bestPutInBand(
  chain: OptionQuote[],
  underlyingPrice: number,
  expiration: string,
  buyingPower: number,
): CspRecommendation | null {
  const dte = dteOf(expiration);
  if (dte <= 0) return null;

  const candidates: CspRecommendation[] = [];
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

    const collateral = opt.strike * 100;
    if (collateral > buyingPower) continue;

    const annualized_yield_pct = (bid / opt.strike) * (365 / dte) * 100;

    candidates.push({
      ticker: "",
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

  const tickers = items.map((i) => i.ticker);
  const quotes = await getWatchlistQuotes(tickers);

  // Fetch chains in parallel, one expiration per ticker.
  const perTicker = await Promise.all(
    tickers.map(async (ticker): Promise<CspRecommendation | null> => {
      const quote: StockQuote | undefined = quotes.get(ticker);
      if (!quote?.last) return null;
      try {
        const expirations = await getExpirations(ticker);
        const expiration = pickExpiration(expirations);
        if (!expiration) return null;
        const chain = await getOptionChain(ticker, expiration);
        const best = bestPutInBand(chain, quote.last, expiration, buyingPower);
        if (!best) return null;
        return { ...best, ticker };
      } catch {
        return null;
      }
    }),
  );

  const recommendations = perTicker
    .filter((r): r is CspRecommendation => r !== null)
    .sort((a, b) => b.annualized_yield_pct - a.annualized_yield_pct);

  return { buying_power: buyingPower, recommendations };
}
