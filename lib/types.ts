export type Restaurant = {
  id: number;
  name: string;
  city: string;
  category: string;
  cuisine: string;
  overall: number;
  food: number | null;
  value: number | null;
  service: number | null;
  ambiance: number | null;
  vegan_options: number | null;
  note: string | null;
  last_visited: string | null;
  created_at: string;
  updated_at: string;
};

export type RestaurantInput = Omit<Restaurant, "id" | "created_at" | "updated_at">;

export type OptionStrategy = "covered_call" | "cash_secured_put";
export type OptionSide = "sell_to_open" | "buy_to_close";
export type OptionType = "call" | "put";

export type OptionsTrade = {
  id: number;
  tradier_id: number;
  source: TradeSource;
  underlying: string;
  option_symbol: string;
  option_type: OptionType;
  strategy: OptionStrategy;
  side: OptionSide;
  strike: number;
  expiration_date: string;       // ISO date string
  quantity: number;
  avg_fill_price: number;        // premium per share
  status: string;
  order_date: string;            // ISO timestamp
  transaction_date: string | null;
  created_at: string;
  updated_at: string;
};

export type TradeSource = "prod" | "sandbox";

export type EquityTrade = {
  id: number;
  tradier_id: number;
  source: TradeSource;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  avg_fill_price: number;
  status: string;
  order_date: string;
  transaction_date: string | null;
  created_at: string;
  updated_at: string;
};

// Computed from equity_trades: current net shares + avg cost basis per ticker.
export type CurrentHolding = {
  symbol: string;
  shares: number;           // net shares currently held
  avg_cost_basis: number;   // average cost per share (avg cost method)
  total_cost: number;       // shares * avg_cost_basis
};

// A position groups all open/close trades for one option contract cycle.
export type OptionsPosition = {
  underlying: string;
  option_symbol: string;
  strategy: OptionStrategy;
  strike: number;
  expiration_date: string;
  quantity: number;
  premium_collected: number;     // credit received on open (per share)
  premium_paid: number | null;   // debit paid on close, if closed early (per share)
  net_premium: number;           // premium_collected - (premium_paid ?? 0)
  status: "open" | "closed" | "expired" | "assigned";
  open_date: string;
  close_date: string | null;
};
