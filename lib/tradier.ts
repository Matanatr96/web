import type { OptionStrategy, OptionSide, OptionType } from "./types";

const PROD_BASE = "https://api.tradier.com/v1";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment.`);
  return v;
}

function getConfig() {
  return { base: PROD_BASE, key: requireEnv("TRADIER_API_KEY"), account: requireEnv("TRADIER_ACCOUNT_ID") };
}

async function tradierFetch<T>(path: string): Promise<T> {
  const { base, key } = getConfig();
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(`Tradier network error fetching ${url}: ${e instanceof Error ? e.message : e}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tradier ${res.status} from ${url}: ${text}`);
  }
  if (!text) {
    throw new Error(`Tradier returned empty response from ${url}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Tradier returned non-JSON from ${url} (status ${res.status}): ${text.slice(0, 200)}`);
  }
}

// Raw shapes returned by Tradier's orders API.
type TradierOrder = {
  id: number;
  type: string;
  symbol: string;
  option_symbol: string;
  side: string;
  quantity: number;
  status: string;
  price: number;
  avg_fill_price: number;
  exec_quantity: number;
  class: string;       // "option" for single-leg options
  option_type: string; // "call" | "put"
  strike: number;
  expiration_date: string;
  create_date: string;
  transaction_date: string | null;
};

type TradierOrdersResponse = {
  orders: { order: TradierOrder | TradierOrder[] } | "null";
};

// Normalize Tradier's inconsistent single-vs-array wrapping.
function toArray<T>(val: T | T[]): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

// Parse OCC option symbol (e.g. "GOOG260522C00360000") into its components.
// Exported for testing.
// Sandbox omits option_type, strike, and expiration_date as separate fields.
export function parseOptionSymbol(symbol: string): { option_type: string; strike: number; expiration_date: string } | null {
  const match = symbol.match(/^.+?(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;
  const [, yy, mm, dd, type, strikeStr] = match;
  return {
    option_type:     type === "C" ? "call" : "put",
    strike:          parseInt(strikeStr, 10) / 1000,
    expiration_date: `20${yy}-${mm}-${dd}`,
  };
}

function inferStrategy(order: TradierOrder): OptionStrategy | null {
  const side = order.side.toLowerCase();
  const optionType = order.option_type?.toLowerCase() ?? "";
  if (side === "sell_to_open" || side === "buy_to_close") {
    if (optionType === "put")  return "cash_secured_put";
    if (optionType === "call") return "covered_call";
  }
  if (side === "buy_to_open" || side === "sell_to_close") {
    if (optionType === "put")  return "long_put";
    if (optionType === "call") return "long_call";
  }
  return null;
}

export type NormalizedOrder = {
  tradier_id: number;
  source: "prod";
  underlying: string;
  option_symbol: string;
  option_type: OptionType;
  strategy: OptionStrategy;
  side: OptionSide;
  strike: number;
  expiration_date: string;
  quantity: number;
  avg_fill_price: number;
  status: string;
  order_date: string;
  transaction_date: string | null;
};

export type NormalizedEquityOrder = {
  tradier_id: number;
  source: "prod";
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  avg_fill_price: number;
  status: string;
  order_date: string;
  transaction_date: string | null;
};

// Fetches all pages of /accounts/{id}/orders. Tradier paginates this endpoint
// (default 25 per page) so a single call can silently miss orders for accounts
// with many recent fills.
//
// IMPORTANT: /orders only returns the CURRENT market session's orders per
// Tradier docs. Once a day rolls over, trades fall off this endpoint. The DB
// retains them via prior syncs, but if a trade is opened and closed without a
// sync happening in between, both legs will be permanently invisible. Migrating
// to /accounts/{id}/history is a follow-up that needs the real response shape.
async function fetchAllOrders(): Promise<TradierOrder[]> {
  const { account } = getConfig();
  const pageSize = 100;
  const all: TradierOrder[] = [];
  for (let page = 1; page <= 50; page++) {
    const data = await tradierFetch<TradierOrdersResponse>(
      `/accounts/${account}/orders?page=${page}&limit=${pageSize}&includeTags=true`,
    );
    if (!data.orders || data.orders === "null") break;
    const batch = toArray(data.orders.order);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}

export async function fetchEquityOrders(): Promise<NormalizedEquityOrder[]> {
  const raw = await fetchAllOrders();

  return raw
    .filter((o) => o.class === "equity" && o.status?.toLowerCase() === "filled")
    .map((o): NormalizedEquityOrder => ({
      tradier_id:      o.id,
      source:          "prod",
      symbol:          o.symbol.toUpperCase(),
      side:            o.side.toLowerCase() as "buy" | "sell",
      quantity:        o.exec_quantity || o.quantity,
      avg_fill_price:  o.avg_fill_price,
      status:          o.status,
      order_date:      o.create_date,
      transaction_date: o.transaction_date ?? null,
    }));
}

// --- /history endpoint: backfill source for past-session trades --------------

type TradierHistoryEvent = {
  amount: number;
  date: string;
  type: string;          // "trade", "option", "dividend", etc.
  trade?: {
    commission: number;
    description: string;
    price: number;
    quantity: number;    // negative = sell, positive = buy
    symbol: string;
    trade_type: string;  // "option", "equity"
  };
};

type TradierHistoryResponse = {
  history: { event: TradierHistoryEvent | TradierHistoryEvent[] } | "null";
};

// Deterministic synthetic tradier_id for /history-sourced rows. /history events
// don't include an order id, so we hash the trade's invariants into a negative
// 32-bit number that won't collide with real Tradier order ids (always positive).
// Re-running backfill is idempotent because the same trade produces the same id.
export function syntheticHistoryId(
  symbol: string,
  isoDate: string,
  quantity: number,
  price: number,
): number {
  const s = `hist|${symbol}|${isoDate}|${quantity}|${price}`;
  let h = 0 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (((h * 31) >>> 0) + s.charCodeAt(i)) >>> 0;
  }
  return -(h + 1);
}

// Fetch all option-trade history events. /history paginates; iterate until empty.
export async function fetchHistoricalEquityOrders(): Promise<NormalizedEquityOrder[]> {
  const { account } = getConfig();
  const pageSize = 100;
  const events: TradierHistoryEvent[] = [];
  for (let page = 1; page <= 50; page++) {
    const data = await tradierFetch<TradierHistoryResponse>(
      `/accounts/${account}/history?page=${page}&limit=${pageSize}&type=trade`,
    );
    if (!data.history || data.history === "null") break;
    const batch = toArray(data.history.event);
    if (batch.length === 0) break;
    events.push(...batch);
    if (batch.length < pageSize) break;
  }

  const out: NormalizedEquityOrder[] = [];
  for (const ev of events) {
    if (ev.type !== "trade" || !ev.trade) continue;
    if (ev.trade.trade_type?.toLowerCase() !== "equity") continue;
    const symbol = ev.trade.symbol?.toUpperCase();
    if (!symbol) continue;
    const qty = ev.trade.quantity;
    if (!qty) continue;
    const qtyAbs = Math.abs(qty);
    const side: "buy" | "sell" = qty > 0 ? "buy" : "sell";
    out.push({
      tradier_id:      syntheticHistoryId(symbol, ev.date, qty, ev.trade.price),
      source:          "prod",
      symbol,
      side,
      quantity:        qtyAbs,
      avg_fill_price:  ev.trade.price,
      status:          "filled",
      order_date:      ev.date,
      transaction_date: ev.date,
    });
  }
  return out;
}

export async function fetchHistoricalOptionOrders(): Promise<NormalizedOrder[]> {
  const { account } = getConfig();
  const pageSize = 100;
  const events: TradierHistoryEvent[] = [];
  for (let page = 1; page <= 50; page++) {
    const data = await tradierFetch<TradierHistoryResponse>(
      `/accounts/${account}/history?page=${page}&limit=${pageSize}&type=option`,
    );
    if (!data.history || data.history === "null") break;
    const batch = toArray(data.history.event);
    if (batch.length === 0) break;
    events.push(...batch);
    if (batch.length < pageSize) break;
  }

  // Group by option_symbol so we can infer open vs close from chronological
  // order of the qty-sign within each symbol.
  type Item = { ev: TradierHistoryEvent; symbol: string; date: string; qty: number; price: number };
  const items: Item[] = [];
  for (const ev of events) {
    if (ev.type !== "trade" || !ev.trade) continue;
    if (ev.trade.trade_type?.toLowerCase() !== "option") continue;
    const symbol = ev.trade.symbol;
    if (!symbol) continue;
    items.push({ ev, symbol, date: ev.date, qty: ev.trade.quantity, price: ev.trade.price });
  }
  items.sort((a, b) => a.date.localeCompare(b.date));

  const seenOpenSide = new Map<string, "buy" | "sell">();
  const out: NormalizedOrder[] = [];
  for (const it of items) {
    const parsed = parseOptionSymbol(it.symbol);
    if (!parsed) continue;
    const qtyAbs = Math.abs(it.qty);
    if (!qtyAbs) continue;

    const sign: "buy" | "sell" = it.qty > 0 ? "buy" : "sell";
    const opened = seenOpenSide.get(it.symbol);

    let side: OptionSide;
    let strategy: OptionStrategy;
    if (!opened) {
      // First event seen for this symbol — assume it's the open.
      seenOpenSide.set(it.symbol, sign);
      if (sign === "sell") {
        side = "sell_to_open";
        strategy = parsed.option_type === "put" ? "cash_secured_put" : "covered_call";
      } else {
        side = "buy_to_open";
        strategy = parsed.option_type === "put" ? "long_put" : "long_call";
      }
    } else if (sign !== opened) {
      // Opposite sign of opening — this is the close.
      side = opened === "sell" ? "buy_to_close" : "sell_to_close";
      strategy = opened === "sell"
        ? (parsed.option_type === "put" ? "cash_secured_put" : "covered_call")
        : (parsed.option_type === "put" ? "long_put" : "long_call");
    } else {
      // Same sign as the open — scaling into the position. Treat as additional open.
      side = sign === "sell" ? "sell_to_open" : "buy_to_open";
      strategy = sign === "sell"
        ? (parsed.option_type === "put" ? "cash_secured_put" : "covered_call")
        : (parsed.option_type === "put" ? "long_put" : "long_call");
    }

    out.push({
      tradier_id:      syntheticHistoryId(it.symbol, it.date, it.qty, it.price),
      source:          "prod",
      underlying:      it.symbol.replace(/\d{6}[CP]\d{8}$/, "").toUpperCase(),
      option_symbol:   it.symbol,
      option_type:     parsed.option_type as OptionType,
      strategy,
      side,
      strike:          parsed.strike,
      expiration_date: parsed.expiration_date,
      quantity:        qtyAbs,
      avg_fill_price:  it.price,
      status:          "filled",
      order_date:      it.date,
      transaction_date: it.date,
    });
  }
  return out;
}

export async function fetchOrders(): Promise<NormalizedOrder[]> {
  const raw = await fetchAllOrders();

  return raw
    .filter((o) => o.class === "option" && o.status?.toLowerCase() === "filled")
    .flatMap((o): NormalizedOrder[] => {
      const parsed = parseOptionSymbol(o.option_symbol ?? "");
      if (!parsed && !o.option_type) {
        console.warn("[fetchOrders] could not parse option_symbol, dropping trade:", JSON.stringify(o));
      }
      const resolved = {
        option_type:     o.option_type ?? parsed?.option_type,
        strike:          o.strike      ?? parsed?.strike,
        expiration_date: o.expiration_date ?? parsed?.expiration_date,
      };
      const orderWithResolved = { ...o, ...resolved };
      const strategy = inferStrategy(orderWithResolved);
      if (!strategy) {
        console.warn("[fetchOrders] could not infer strategy, dropping trade:", JSON.stringify({ id: o.id, side: o.side, option_type: resolved.option_type, symbol: o.option_symbol }));
        return [];
      }
      return [{
        tradier_id:      o.id,
        source:          "prod",
        underlying:      o.symbol.toUpperCase(),
        option_symbol:   o.option_symbol,
        option_type:     resolved.option_type as OptionType,
        strategy,
        side:            o.side as OptionSide,
        strike:          resolved.strike!,
        expiration_date: resolved.expiration_date!,
        quantity:        o.exec_quantity || o.quantity,
        avg_fill_price:  o.avg_fill_price,
        status:          o.status,
        order_date:      o.create_date,
        transaction_date: o.transaction_date ?? null,
      }];
    });
}
