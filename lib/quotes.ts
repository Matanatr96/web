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
  greeks?: { delta: number | null; mid_iv: number | null } | null;
};

type TradierChainResponse = {
  options: { option: TradierOption | TradierOption[] } | null;
};

type TradierHistoryDay = { date: string; close: number };
type TradierHistoryResponse = {
  history: { day: TradierHistoryDay | TradierHistoryDay[] } | null;
};

export type OptionCandidate = {
  expiration: string;
  dte: number;
  strike: number;
  bid: number;
  mid: number;
  delta: number | null;
  otm_pct: number;
  monthly_return_pct: number; // (bid / capital) * (30 / dte) * 100
};

export type IvData = {
  current: number;  // IV of selected option as % (e.g. 65)
  hv30: number;     // 30-day historical volatility as % (e.g. 42)
  ratio: number;    // current / hv30 — >1 means options are "expensive"
};

export type WheelOptions = {
  puts: OptionCandidate[];
  calls: OptionCandidate[];
  iv: IvData | null;
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

async function fetchPriceHistoryRaw(symbol: string, start: string, end: string): Promise<number[]> {
  const key = process.env.TRADIER_API_KEY;
  if (!key) return [];
  const res = await fetch(
    `${PROD_BASE}/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${start}&end=${end}`,
    { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as TradierHistoryResponse;
  return toArray(data.history?.day).map((d) => d.close);
}

const fetchPriceHistoryCached = unstable_cache(
  fetchPriceHistoryRaw,
  ["tradier-price-history"],
  { revalidate: 14400, tags: ["watchlist-data"] }, // 4h — daily prices update EOD
);

// Annualized 30-day historical volatility from a series of closing prices.
function calcHv30(closes: number[]): number {
  if (closes.length < 31) return 0;
  const recent = closes.slice(-31);
  const logReturns = recent.slice(1).map((p, i) => Math.log(p / recent[i]));
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

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

// Find the option closest to a target delta (absolute value, e.g. 0.25).
// Falls back to OTM% selection if greeks are unavailable.
function pickClosest(
  options: TradierOption[],
  type: "put" | "call",
  currentPrice: number,
  deltaTarget: number,
): TradierOption | null {
  const filtered = options.filter((o) => o.option_type === type && (o.bid ?? 0) > 0);
  if (filtered.length === 0) return null;

  const withGreeks = filtered.filter((o) => o.greeks?.delta != null);
  if (withGreeks.length > 0) {
    const target = type === "put" ? -deltaTarget : deltaTarget;
    withGreeks.sort(
      (a, b) =>
        Math.abs((a.greeks!.delta ?? 0) - target) -
        Math.abs((b.greeks!.delta ?? 0) - target),
    );
    return withGreeks[0];
  }

  // Fallback: rough OTM% approximation when greeks aren't available.
  const otmPct = deltaTarget * 40; // ~0.25 delta ≈ 10% OTM
  const targetStrike =
    type === "put"
      ? currentPrice * (1 - otmPct / 100)
      : currentPrice * (1 + otmPct / 100);
  filtered.sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));
  return filtered[0];
}

// Pick up to 2 options at the given delta targets, deduplicated by strike.
function pickTwo(
  options: TradierOption[],
  type: "put" | "call",
  currentPrice: number,
  targets: [number, number],
): TradierOption[] {
  const first = pickClosest(options, type, currentPrice, targets[0]);
  const second = pickClosest(options, type, currentPrice, targets[1]);
  if (!first) return second ? [second] : [];
  if (!second || second.strike === first.strike) return [first];
  return type === "put"
    ? [first, second].sort((a, b) => b.strike - a.strike) // higher strike first for puts
    : [first, second].sort((a, b) => a.strike - b.strike); // lower strike first for calls
}

function toCandidate(
  opt: TradierOption,
  expiration: string,
  dte: number,
  currentPrice: number,
  type: "put" | "call",
): OptionCandidate {
  const bid = opt.bid ?? 0;
  const ask = opt.ask ?? bid;
  const otm_pct =
    type === "put"
      ? ((currentPrice - opt.strike) / currentPrice) * 100
      : ((opt.strike - currentPrice) / currentPrice) * 100;
  // Capital at risk per share: strike for CSPs, current price for CCs.
  const capital = type === "put" ? opt.strike : currentPrice;
  const monthly_return_pct = dte > 0 ? (bid / capital) * (30 / dte) * 100 : 0;
  return { expiration, dte, strike: opt.strike, bid, mid: (bid + ask) / 2, delta: opt.greeks?.delta ?? null, otm_pct, monthly_return_pct };
}

export async function getWheelOptions(
  tickers: string[],
  quotes: Map<string, StockQuote>,
): Promise<Map<string, WheelOptions>> {
  if (tickers.length === 0) return new Map();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expirations = await Promise.all(
    tickers.map(async (ticker) => ({
      ticker,
      expiration: pickExpiration(await fetchExpirationsCached(ticker)),
    })),
  );

  const startDate = new Date(today);
  startDate.setFullYear(startDate.getFullYear() - 1);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = today.toISOString().slice(0, 10);

  const valid = expirations.filter((r) => r.expiration !== null);

  const [chains, histories] = await Promise.all([
    Promise.all(
      valid.map(async ({ ticker, expiration }) => ({
        ticker,
        expiration: expiration!,
        chain: await fetchOptionChainCached(ticker, expiration!),
      })),
    ),
    Promise.all(
      valid.map(async ({ ticker }) => ({
        ticker,
        closes: await fetchPriceHistoryCached(ticker, startStr, endStr),
      })),
    ),
  ]);

  const historyMap = new Map(histories.map(({ ticker, closes }) => [ticker, closes]));

  const result = new Map<string, WheelOptions>();
  for (const { ticker, expiration, chain } of chains) {
    const last = quotes.get(ticker)?.last;
    if (!last) continue;

    const dte = Math.round(
      (new Date(expiration + "T00:00:00").getTime() - today.getTime()) / 86_400_000,
    );

    const puts = pickTwo(chain, "put", last, [0.25, 0.20]).map((o) => toCandidate(o, expiration, dte, last, "put"));
    const calls = pickTwo(chain, "call", last, [0.25, 0.20]).map((o) => toCandidate(o, expiration, dte, last, "call"));

    // IV from the 0.25-delta put (first put); HV from price history.
    const ivSource = puts[0];
    const rawIv = ivSource ? (chain.find((o) => o.option_type === "put" && o.strike === ivSource.strike)?.greeks?.mid_iv ?? null) : null;
    const hv30 = calcHv30(historyMap.get(ticker) ?? []);
    const currentIv = rawIv != null ? rawIv * 100 : null;
    const iv: IvData | null =
      currentIv != null && hv30 > 0
        ? { current: currentIv, hv30, ratio: currentIv / hv30 }
        : null;

    result.set(ticker, { puts, calls, iv });
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
