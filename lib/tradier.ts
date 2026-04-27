import type { OptionStrategy, OptionSide, OptionType } from "./types";

const PROD_BASE = "https://api.tradier.com/v1";
const SANDBOX_BASE = "https://sandbox.tradier.com/v1";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment.`);
  return v;
}

function getConfig(sandbox: boolean) {
  return sandbox
    ? { base: SANDBOX_BASE, key: requireEnv("TRADIER_SANDBOX_KEY"), account: requireEnv("TRADIER_SANDBOX_ACCOUNT") }
    : { base: PROD_BASE,    key: requireEnv("TRADIER_API_KEY"),     account: requireEnv("TRADIER_ACCOUNT_ID") };
}

async function tradierFetch<T>(path: string, sandbox: boolean): Promise<T> {
  const { base, key } = getConfig(sandbox);
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
  source: "prod" | "sandbox";
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
  source: "prod" | "sandbox";
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  avg_fill_price: number;
  status: string;
  order_date: string;
  transaction_date: string | null;
};

export async function fetchEquityOrders(sandbox = false): Promise<NormalizedEquityOrder[]> {
  const { account } = getConfig(sandbox);
  const data = await tradierFetch<TradierOrdersResponse>(
    `/accounts/${account}/orders`,
    sandbox,
  );

  if (!data.orders || data.orders === "null") return [];

  const raw = toArray(data.orders.order);

  return raw
    .filter((o) => o.class === "equity" && o.status?.toLowerCase() === "filled")
    .map((o): NormalizedEquityOrder => ({
      tradier_id:      o.id,
      source:          sandbox ? "sandbox" : "prod",
      symbol:          o.symbol.toUpperCase(),
      side:            o.side.toLowerCase() as "buy" | "sell",
      quantity:        o.exec_quantity || o.quantity,
      avg_fill_price:  o.avg_fill_price,
      status:          o.status,
      order_date:      o.create_date,
      transaction_date: o.transaction_date ?? null,
    }));
}

export async function fetchOrders(sandbox = false): Promise<NormalizedOrder[]> {
  const { account } = getConfig(sandbox);
  const data = await tradierFetch<TradierOrdersResponse>(
    `/accounts/${account}/orders`,
    sandbox,
  );

  if (!data.orders || data.orders === "null") return [];

  const raw = toArray(data.orders.order);

  return raw
    .filter((o) => o.class === "option" && o.status?.toLowerCase() === "filled")
    .flatMap((o): NormalizedOrder[] => {
      const strategy = inferStrategy(o);
      if (!strategy) return [];
      return [{
        tradier_id:      o.id,
        source:          sandbox ? "sandbox" : "prod",
        underlying:      o.symbol.toUpperCase(),
        option_symbol:   o.option_symbol,
        option_type:     o.option_type as OptionType,
        strategy,
        side:            o.side as OptionSide,
        strike:          o.strike,
        expiration_date: o.expiration_date,
        quantity:        o.exec_quantity || o.quantity,
        avg_fill_price:  o.avg_fill_price,
        status:          o.status,
        order_date:      o.create_date,
        transaction_date: o.transaction_date ?? null,
      }];
    });
}
