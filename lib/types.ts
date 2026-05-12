export type Restaurant = {
  id: number;
  name: string;
  city: string;
  category: string;
  cuisines: string[];
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
  photos: string[] | null;
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

// Fantasy football (Sleeper).
export type FantasyLeague = {
  season: number;
  league_id: string;
  name: string | null;
  playoff_week_start: number | null;
  // Sleeper winners_bracket, with roster_ids translated to fantasy_owners.user_id.
  winners_bracket: BracketEntry[] | null;
};

export type BracketEntry = {
  r: number;
  m: number;
  p: number | null;
  t1: string | null;
  t2: string | null;
  w: string | null;
  l: string | null;
  t1_from?: { w?: number; l?: number } | null;
  t2_from?: { w?: number; l?: number } | null;
};

// Notable single-game records derived from FantasyMatchup[].
export type ScoreRecord = {
  season: number;
  week: number;
  owner_id: string;
  display_name: string;
  points: number;
};

export type BlowoutRecord = ScoreRecord & {
  opponent_id: string;
  opponent_name: string;
  differential: number;
};

export type TradedPlayer = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
};

export type TradedPick = {
  season: string;          // pick year
  round: number;
  // user_id of the original owner if known; null otherwise.
  original_owner_id: string | null;
  original_owner_name: string | null;
};

// What a single side received in a trade.
export type TradeSide = {
  players: TradedPlayer[];
  picks: TradedPick[];
  faab: number;            // net FAAB received (negative = sent)
};

// One row in fantasy_trades. Payload is keyed by user_id.
export type FantasyTrade = {
  id: string;
  season: number;
  week: number;
  status: string;
  created_ms: number;
  user_ids: string[];
  payload: Record<string, TradeSide>;
};

export type TradeLeaderboardRow = {
  owner_id: string;
  display_name: string;
  trade_count: number;
};

export type FantasyOwner = {
  user_id: string;
  display_name: string;
  avatar: string | null;
};

export type FantasyMatchup = {
  id: number;
  season: number;
  week: number;
  owner_id: string;
  opponent_id: string | null;
  points: number;
  opponent_points: number;
  result: "W" | "L" | "T";
};

// Per-owner standings row, derived from FantasyMatchup[].
export type FantasyStanding = {
  owner_id: string;
  display_name: string;
  wins: number;
  losses: number;
  ties: number;
  unrealized_wins: number;       // all-play wins across the season
  unrealized_losses: number;
  avg_ppg: number;
  avg_ppga: number;
  avg_diff: number;              // avg_ppg - avg_ppga
  ppg_vs_avg: number;            // avg_ppg - league_avg_ppg
};

export type FantasyWeeklyAverage = {
  week: number;
  // season -> league average points for that week (null if week not played)
  averages: Record<number, number | null>;
};
