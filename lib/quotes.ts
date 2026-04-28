import { unstable_cache } from "next/cache";

const PROD_BASE = "https://api.tradier.com/v1";

export function isMarketOpen(): boolean {
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

export type StockQuote = {
  symbol: string;
  last: number | null;
  change: number | null;
  change_percentage: number | null;
};

type TradierFullQuote = {
  symbol: string;
  last: number | null;
  change: number | null;
  change_percentage: number | null;
  bid: number;
  ask: number;
};

type TradierFullQuotesResponse = {
  quotes: { quote: TradierFullQuote | TradierFullQuote[] } | null;
};

async function fetchStockQuotesRaw(symbols: string[]): Promise<StockQuote[]> {
  const key = process.env.TRADIER_API_KEY;
  if (!key || symbols.length === 0) return [];

  const joined = symbols.join(",");
  const res = await fetch(
    `${PROD_BASE}/markets/quotes?symbols=${encodeURIComponent(joined)}&greeks=false`,
    {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
    },
  );
  if (!res.ok) return [];

  const data = (await res.json()) as TradierFullQuotesResponse;
  const quotes = toArray(data.quotes?.quote);
  return quotes.map((q) => ({
    symbol: q.symbol,
    last: q.last ?? null,
    change: q.change ?? null,
    change_percentage: q.change_percentage ?? null,
  }));
}

const fetchStockQuotesCached = unstable_cache(
  fetchStockQuotesRaw,
  ["tradier-stock-quotes"],
  { revalidate: 60, tags: ["watchlist-data"] },
);

// Always fetches regardless of market hours so the last known price is visible.
export async function getWatchlistQuotes(symbols: string[]): Promise<Map<string, StockQuote>> {
  if (symbols.length === 0) return new Map();
  try {
    const quotes = await fetchStockQuotesCached([...symbols].sort());
    return new Map(quotes.map((q) => [q.symbol, q]));
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Options chain + wheel candidate helpers
// ---------------------------------------------------------------------------

type TradierExpirationsResponse = {
  expirations: { date: string | string[] } | null;
};

type TradierOption = {
  symbol: string;
  option_type: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  expiration_date: string;
  greeks?: { delta: number | null } | null;
};

type TradierChainResponse = {
  options: { option: TradierOption | TradierOption[] } | null;
};

export type WheelCandidate = {
  expiration: string;   // ISO date of chosen expiration
  dte: number;          // days to expiration
  strike: number;       // put strike
  bid: number;          // premium per share (bid)
  mid: number;          // premium per share (mid)
  delta: number | null; // put delta (negative, e.g. -0.25)
  otm_pct: number;      // % below current price (positive = OTM)
};

async function fetchExpirationsRaw(symbol: string): Promise<string[]> {
  const key = process.env.TRADIER_API_KEY;
  if (!key) return [];
  const res = await fetch(
    `${PROD_BASE}/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=false`,
    { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as TradierExpirationsResponse;
  const dates = data.expirations?.date;
  if (!dates) return [];
  return Array.isArray(dates) ? dates : [dates];
}

const fetchExpirationsCached = unstable_cache(
  fetchExpirationsRaw,
  ["tradier-expirations"],
  { revalidate: 3600, tags: ["watchlist-data"] },
);

async function fetchOptionChainRaw(symbol: string, expiration: string): Promise<TradierOption[]> {
  const key = process.env.TRADIER_API_KEY;
  if (!key) return [];
  const res = await fetch(
    `${PROD_BASE}/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`,
    { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as TradierChainResponse;
  return toArray(data.options?.option);
}

const fetchOptionChainCached = unstable_cache(
  fetchOptionChainRaw,
  ["tradier-option-chain"],
  { revalidate: 300, tags: ["watchlist-data"] },
);

// Pick the expiration closest to targetDte (default 35) within the 21–60 DTE window.
function pickExpiration(dates: string[], targetDte = 35): string | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const withDte = dates.map((d) => {
    const dte = Math.round(
      (new Date(d + "T00:00:00").getTime() - today.getTime()) / 86_400_000,
    );
    return { date: d, dte };
  });

  const window = withDte.filter(({ dte }) => dte >= 21 && dte <= 60);
  const pool = window.length > 0 ? window : withDte.filter(({ dte }) => dte > 7);
  if (pool.length === 0) return null;

  pool.sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
  return pool[0].date;
}

// Pick the put closest to 8% OTM with a non-zero bid.
function pickPut(options: TradierOption[], currentPrice: number): TradierOption | null {
  const target = currentPrice * 0.92;
  const puts = options.filter((o) => o.option_type === "put" && (o.bid ?? 0) > 0);
  if (puts.length === 0) return null;
  puts.sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target));
  return puts[0];
}

export async function getWheelCandidates(
  tickers: string[],
  quotes: Map<string, StockQuote>,
): Promise<Map<string, WheelCandidate>> {
  if (tickers.length === 0) return new Map();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Fetch all expirations in parallel, then all chains in parallel.
  const expirations = await Promise.all(
    tickers.map(async (ticker) => ({
      ticker,
      expiration: pickExpiration(await fetchExpirationsCached(ticker)),
    })),
  );

  const chains = await Promise.all(
    expirations
      .filter((r) => r.expiration !== null)
      .map(async ({ ticker, expiration }) => ({
        ticker,
        expiration: expiration!,
        chain: await fetchOptionChainCached(ticker, expiration!),
      })),
  );

  const result = new Map<string, WheelCandidate>();
  for (const { ticker, expiration, chain } of chains) {
    const last = quotes.get(ticker)?.last;
    if (!last) continue;

    const put = pickPut(chain, last);
    if (!put) continue;

    const dte = Math.round(
      (new Date(expiration + "T00:00:00").getTime() - today.getTime()) / 86_400_000,
    );
    const bid = put.bid ?? 0;
    const ask = put.ask ?? bid;

    result.set(ticker, {
      expiration,
      dte,
      strike: put.strike,
      bid,
      mid: (bid + ask) / 2,
      delta: put.greeks?.delta ?? null,
      otm_pct: ((last - put.strike) / last) * 100,
    });
  }

  return result;
}

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
