import { buildTickerPnL } from "../lib/pnl";
import type { EquityTrade, OptionsPosition } from "../lib/types";

// Minimal factories — tests exercise only the fields buildTickerPnL reads.
function eq(partial: Partial<EquityTrade>): EquityTrade {
  return {
    id: 0, tradier_id: 0, source: "prod",
    symbol: "X", side: "buy", quantity: 0, avg_fill_price: 0,
    status: "filled", order_date: "2026-01-01",
    transaction_date: null, created_at: "", updated_at: "",
    ...partial,
  };
}

function pos(partial: Partial<OptionsPosition>): OptionsPosition {
  return {
    underlying: "X", option_symbol: "X",
    strategy: "covered_call", strike: 0, expiration_date: "2026-01-01",
    quantity: 1, premium_collected: 0, premium_paid: 0, net_premium: 0,
    status: "open", open_date: "2026-01-01", close_date: null,
    ...partial,
  };
}

let failures = 0;
function assertClose(got: number, want: number, label: string) {
  if (Math.abs(got - want) > 1e-6) {
    console.error(`FAIL ${label}: expected ${want}, got ${got}`);
    failures++;
  } else {
    console.log(`PASS ${label}: ${got}`);
  }
}

// --- Scenario 1: weighted avg on two buys + partial sell ---
// Buy 100 @ $150, buy 50 @ $170, sell 30 @ $200.
// 150 shares @ 23500/150 = $156.66…, sell 30 → realized = 30*(200 - 156.66…) = 1300.
{
  const r = buildTickerPnL([
    eq({ symbol: "AAPL", side: "buy",  quantity: 100, avg_fill_price: 150, order_date: "2026-01-01" }),
    eq({ symbol: "AAPL", side: "buy",  quantity: 50,  avg_fill_price: 170, order_date: "2026-01-02" }),
    eq({ symbol: "AAPL", side: "sell", quantity: 30,  avg_fill_price: 200, order_date: "2026-01-03" }),
  ], [])[0];
  assertClose(r.shares_open, 120, "s1 shares");
  assertClose(r.avg_cost_basis, 23500 / 150, "s1 avg_cost");
  assertClose(r.equity_realized_pl, 30 * (200 - 23500 / 150), "s1 realized");
}

// --- Scenario 2: full round-trip across multiple sells ---
// Buy 10 @ 100, sell 5 @ 150, sell 5 @ 200. Realized = 5*50 + 5*100 = 750.
{
  const r = buildTickerPnL([
    eq({ symbol: "TSLA", side: "buy",  quantity: 10, avg_fill_price: 100, order_date: "2026-01-01" }),
    eq({ symbol: "TSLA", side: "sell", quantity: 5,  avg_fill_price: 150, order_date: "2026-01-02" }),
    eq({ symbol: "TSLA", side: "sell", quantity: 5,  avg_fill_price: 200, order_date: "2026-01-03" }),
  ], [])[0];
  assertClose(r.shares_open, 0, "s2 shares");
  assertClose(r.avg_cost_basis, 0, "s2 avg_cost reset");
  assertClose(r.equity_realized_pl, 750, "s2 realized");
}

// --- Scenario 3: re-buy after full close — cost basis starts fresh ---
{
  const r = buildTickerPnL([
    eq({ symbol: "NVDA", side: "buy",  quantity: 10, avg_fill_price: 100, order_date: "2026-01-01" }),
    eq({ symbol: "NVDA", side: "sell", quantity: 10, avg_fill_price: 120, order_date: "2026-01-02" }),
    eq({ symbol: "NVDA", side: "buy",  quantity: 5,  avg_fill_price: 50,  order_date: "2026-01-03" }),
  ], [])[0];
  assertClose(r.shares_open, 5, "s3 shares");
  assertClose(r.avg_cost_basis, 50, "s3 avg_cost fresh");
  assertClose(r.equity_realized_pl, 200, "s3 realized");
}

// --- Scenario 4: options — closed and expired count as realized, open does not ---
{
  const r = buildTickerPnL([], [
    pos({ underlying: "SPY", net_premium: 2.5, quantity: 1, status: "closed"  }),
    pos({ underlying: "SPY", net_premium: 1.0, quantity: 1, status: "open"    }),
    pos({ underlying: "SPY", net_premium: 0.5, quantity: 2, status: "expired" }),
  ])[0];
  assertClose(r.options_realized_pl, 250 + 100, "s4 opt realized (closed+expired)");
  assertClose(r.options_open_premium, 100, "s4 opt open premium");
  assertClose(r.total_realized_pl, 350, "s4 total");
}

// --- Scenario 5: equity + options combined per ticker ---
// The key regression guard: avg_cost_basis must stay stable on a sell.
// The old Django site's `(cb*num + price*qty)/(num+qty)` formula with qty<0
// would produce a nonsense cost basis here.
{
  const r = buildTickerPnL([
    eq({ symbol: "MSFT", side: "buy",  quantity: 100, avg_fill_price: 300, order_date: "2026-01-01" }),
    eq({ symbol: "MSFT", side: "sell", quantity: 50,  avg_fill_price: 350, order_date: "2026-01-02" }),
  ], [
    pos({ underlying: "MSFT", net_premium: 3.0, quantity: 1, status: "closed" }),
  ])[0];
  assertClose(r.equity_realized_pl, 2500, "s5 equity realized");
  assertClose(r.options_realized_pl, 300,  "s5 options realized");
  assertClose(r.total_realized_pl, 2800,   "s5 total");
  assertClose(r.shares_open, 50,           "s5 shares");
  assertClose(r.avg_cost_basis, 300,       "s5 avg_cost stable on sell");
}

// --- Scenario 6: fully-closed ticker keeps its realized P/L visible ---
// Verifies the "reset" only zeros current-shares cost basis; realized P/L
// survives and the ticker still appears in the per-ticker list.
{
  const result = buildTickerPnL([
    eq({ symbol: "GME", side: "buy",  quantity: 10, avg_fill_price: 100, order_date: "2026-01-01" }),
    eq({ symbol: "GME", side: "sell", quantity: 10, avg_fill_price: 80,  order_date: "2026-01-02" }),
  ], []);
  const gme = result.find((r) => r.ticker === "GME");
  if (!gme) {
    console.error("FAIL s6 GME missing from result");
    failures++;
  } else {
    assertClose(gme.shares_open, 0,           "s6 shares closed out");
    assertClose(gme.avg_cost_basis, 0,        "s6 avg_cost zeroed (no shares to value)");
    assertClose(gme.equity_realized_pl, -200, "s6 realized loss preserved after close");
    assertClose(gme.total_realized_pl, -200,  "s6 total realized survives full close");
  }
}

// --- Scenario 7: open short put, mark below entry → profit ──────────────────
// Sold 1 CSP for $3.00 credit; current mark is $1.00.
// Unrealized = (3.00 - 1.00) * 1 * 100 = +$200
{
  const p = pos({
    underlying: "AAPL",
    option_symbol: "AAPL250117P00150000",
    strategy: "cash_secured_put",
    premium_collected: 3.00,
    premium_paid: null,
    net_premium: 3.00,
    status: "open",
  });
  const prices = new Map([["AAPL250117P00150000", 1.00]]);
  const r = buildTickerPnL([], [p], prices)[0];
  assertClose(r.unrealized_options_pl ?? -999, 200, "s7 short put profit unrealized");
  assertClose(p.unrealized_pl ?? -999,          200, "s7 position.unrealized_pl annotated");
}

// --- Scenario 8: open long call, mark above entry → profit ───────────────────
// Bought 1 call for $5.00 debit; current mark is $8.00.
// Unrealized = (8.00 - 5.00) * 1 * 100 = +$300
{
  const p = pos({
    underlying: "TSLA",
    option_symbol: "TSLA250117C00250000",
    strategy: "long_call",
    premium_collected: 0,
    premium_paid: 5.00,
    net_premium: -5.00,
    status: "open",
  });
  const prices = new Map([["TSLA250117C00250000", 8.00]]);
  const r = buildTickerPnL([], [p], prices)[0];
  assertClose(r.unrealized_options_pl ?? -999, 300, "s8 long call profit unrealized");
  assertClose(p.unrealized_pl ?? -999,          300, "s8 position.unrealized_pl annotated");
}

// --- Scenario 9: equity with live price, unrealized equity P/L ───────────────
// 10 shares bought at $300; current price $350.
// Unrealized equity = 10 * (350 - 300) = +$500
{
  const prices = new Map([["MSFT", 350]]);
  const r = buildTickerPnL([
    eq({ symbol: "MSFT", side: "buy", quantity: 10, avg_fill_price: 300, order_date: "2026-01-01" }),
  ], [], prices)[0];
  assertClose(r.unrealized_equity_pl ?? -999, 500, "s9 equity unrealized P/L");
  assertClose(r.total_pl ?? -999, r.total_realized_pl + 500, "s9 total_pl includes unrealized");
}

// --- Scenario 10: no quotes → unrealized fields are undefined ────────────────
{
  const p = pos({ underlying: "AAPL", status: "open" });
  const r = buildTickerPnL([], [p])[0];
  if (r.unrealized_options_pl !== undefined) {
    console.error("FAIL s10: unrealized_options_pl should be undefined without quotes");
    failures++;
  } else {
    console.log("PASS s10 unrealized absent when no quotes");
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll scenarios passed.");
