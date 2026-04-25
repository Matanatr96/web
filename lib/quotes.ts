import { unstable_cache } from "next/cache";

const PROD_BASE = "https://api.tradier.com/v1";

function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  // NYSE: 9:30–16:00 ET = 13:30–20:00 UTC (ignores DST, good enough for cache-skip)
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= 810 && minutes < 1200;
}

type TradierQuote = {
  symbol: string;
  bid: number;
  ask: number;
};

type TradierQuotesResponse = {
  quotes: { quote: TradierQuote | TradierQuote[] } | null;
};

function toArray<T>(val: T | T[] | null | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function mid(q: TradierQuote): number {
  return (q.bid + q.ask) / 2;
}

async function fetchQuotesRaw(symbols: string[]): Promise<Map<string, number>> {
  const key = process.env.TRADIER_API_KEY;
  if (!key || symbols.length === 0) return new Map();

  const joined = symbols.join(",");
  const res = await fetch(
    `${PROD_BASE}/markets/quotes?symbols=${encodeURIComponent(joined)}&greeks=false`,
    {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
    },
  );

  if (!res.ok) return new Map();

  const data = (await res.json()) as TradierQuotesResponse;
  const quotes = toArray(data.quotes?.quote);
  return new Map(quotes.map((q) => [q.symbol, mid(q)]));
}

// Cached version — revalidates every 60s. Cache key is the sorted, joined symbol list.
const fetchQuotesCached = unstable_cache(
  fetchQuotesRaw,
  ["tradier-quotes"],
  { revalidate: 60 },
);

export type LiveQuotes = {
  prices: Map<string, number>; // equity symbol or OCC option symbol → mid price
  available: boolean;
};

export async function getLiveQuotes(
  equitySymbols: string[],
  optionSymbols: string[],
): Promise<LiveQuotes> {
  if (!isMarketOpen()) {
    return { prices: new Map(), available: false };
  }

  try {
    // Sort before joining so ["AAPL","TSLA"] and ["TSLA","AAPL"] share the same cache entry.
    const allSymbols = [...equitySymbols, ...optionSymbols].sort();
    if (allSymbols.length === 0) return { prices: new Map(), available: false };

    const prices = await fetchQuotesCached(allSymbols);
    return { prices, available: prices.size > 0 };
  } catch {
    return { prices: new Map(), available: false };
  }
}
