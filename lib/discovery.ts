import { getWatchlistQuotes, getWheelOptions, type StockQuote, type IvData, type OptionCandidate, type WheelOptions } from "@/lib/quotes";
import universe from "@/data/discovery_universe.json";

export type UniverseEntry = { ticker: string; sector: string };

export type DiscoveryCandidate = {
  ticker: string;
  sector: string;
  quote: StockQuote;
  iv: IvData | null;
  bestPut: OptionCandidate | null;
  score: number;
};

export type DiscoveryFilters = {
  minMonthlyReturnPct: number; // e.g. 0.5
  minIvRatio: number;          // e.g. 1.0 (current_iv / hv30)
  maxResults: number;          // e.g. 25
};

export const DEFAULT_FILTERS: DiscoveryFilters = {
  minMonthlyReturnPct: 0.5,
  minIvRatio: 1.0,
  maxResults: 25,
};

const CHUNK_SIZE = 8;

function getUniverse(): UniverseEntry[] {
  return universe as UniverseEntry[];
}

async function inChunks<T, R>(items: T[], size: number, fn: (chunk: T[]) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(await fn(items.slice(i, i + size)));
  }
  return results;
}

export async function runDiscovery(
  excludedTickers: string[],
  filters: DiscoveryFilters = DEFAULT_FILTERS,
): Promise<DiscoveryCandidate[]> {
  const excluded = new Set(excludedTickers.map((t) => t.toUpperCase()));
  const entries = getUniverse().filter((e) => !excluded.has(e.ticker.toUpperCase()));
  const sectorByTicker = new Map(entries.map((e) => [e.ticker, e.sector]));
  const tickers = entries.map((e) => e.ticker);

  // Single batched quotes call (Tradier accepts comma-joined symbols).
  const quotes = await getWatchlistQuotes(tickers);

  // Wheel options call is heavier (expirations + chain + history per ticker),
  // so chunk it to avoid hammering Tradier.
  const wheelChunks = await inChunks(tickers, CHUNK_SIZE, (chunk) => getWheelOptions(chunk, quotes));
  const wheel = new Map<string, WheelOptions>();
  for (const m of wheelChunks) for (const [k, v] of m) wheel.set(k, v);

  const candidates: DiscoveryCandidate[] = [];
  for (const ticker of tickers) {
    const quote = quotes.get(ticker);
    const opts = wheel.get(ticker);
    if (!quote || !opts) continue;

    const bestPut = opts.puts[0] ?? null; // ~0.25-delta put — highest premium of the pair
    if (!bestPut) continue;

    const ivRatio = opts.iv?.ratio ?? 0;
    if (bestPut.monthly_return_pct < filters.minMonthlyReturnPct) continue;
    if (ivRatio < filters.minIvRatio) continue;

    // Composite: 60% monthly yield (normalized to a 2%/mo ceiling),
    // 40% IV richness (normalized to a 2.0× ceiling).
    const yieldNorm = Math.min(bestPut.monthly_return_pct / 2, 1);
    const ivNorm = Math.min(ivRatio / 2, 1);
    const score = 0.6 * yieldNorm + 0.4 * ivNorm;

    candidates.push({
      ticker,
      sector: sectorByTicker.get(ticker) ?? "—",
      quote,
      iv: opts.iv,
      bestPut,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, filters.maxResults);
}
