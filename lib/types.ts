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
  address: string | null;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RestaurantInput = Omit<Restaurant, "id" | "created_at" | "updated_at">;

export type OptionStrategy = "covered_call" | "cash_secured_put" | "long_call" | "long_put";
export type OptionSide = "sell_to_open" | "buy_to_close" | "buy_to_open" | "sell_to_close";
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
  current_price?: number;
  unrealized_pl?: number;   // shares * (current_price - avg_cost_basis)
};

// Per-ticker realized P/L across equity + options, derived from trade history.
export type TickerPnL = {
  ticker: string;
  shares_open: number;          // net shares currently held
  avg_cost_basis: number;       // running average cost per share
  equity_total_cost: number;    // shares_open * avg_cost_basis
  equity_realized_pl: number;   // profit/loss booked from share sells
  options_realized_pl: number;  // profit/loss from closed/expired/assigned options
  options_open_premium: number; // credit currently at risk on still-open short positions (net)
  total_realized_pl: number;    // equity_realized_pl + options_realized_pl
  trade_count: number;          // total equity trades (buys + sells) for this ticker
  total_gross_spend: number;    // sum of all buy trades: quantity * avg_fill_price
  csp_collateral: number;       // cash tied up in open CSPs: strike * 100 * quantity
  total_capital_tied_up: number; // equity_total_cost + csp_collateral
  // Populated only when live quotes are available
  unrealized_equity_pl?: number;   // shares * (current_price - avg_cost_basis)
  unrealized_options_pl?: number;  // sum of per-position unrealized across open contracts
  total_pl?: number;               // total_realized_pl + unrealized_equity_pl + unrealized_options_pl
};

export type WatchlistItem = {
  id: number;
  ticker: string;
  created_at: string;
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
  unrealized_pl?: number;            // (mark - entry) * qty * 100, sign-correct per long/short
  assigned_equity_trades?: EquityTrade[]; // heuristically matched equity trades from assignment
};
