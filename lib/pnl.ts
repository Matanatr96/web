import type { EquityTrade, OptionsPosition, TickerPnL } from "@/lib/types";

// Running-average cost basis. On a buy we roll the average; on a sell we keep
// the average stable and book the delta as realized P/L. This is the correct
// accounting for weighted-average — the old Django site updated cost basis
// symmetrically for buys and sells, which produced nonsensical cost basis
// values after partial closes.
export function buildTickerPnL(
  equityTrades: EquityTrade[],
  optionsPositions: OptionsPosition[],
  prices?: Map<string, number>,
): TickerPnL[] {
  type EquityState = {
    shares: number;
    avgCost: number;
    realized: number;
    tradeCount: number;
    grossSpend: number;
  };
  const equityByTicker = new Map<string, EquityState>();

  const sorted = [...equityTrades].sort(
    (a, b) => new Date(a.order_date).getTime() - new Date(b.order_date).getTime(),
  );

  for (const t of sorted) {
    const s = equityByTicker.get(t.symbol) ?? {
      shares: 0,
      avgCost: 0,
      realized: 0,
      tradeCount: 0,
      grossSpend: 0,
    };

    s.tradeCount += 1;

    if (t.side === "buy") {
      const totalCost = s.shares * s.avgCost + t.quantity * t.avg_fill_price;
      s.shares += t.quantity;
      s.avgCost = s.shares > 0 ? totalCost / s.shares : 0;
      s.grossSpend += t.quantity * t.avg_fill_price;
    } else {
      const qty = Math.min(t.quantity, s.shares);
      s.realized += qty * (t.avg_fill_price - s.avgCost);
      s.shares -= qty;
      if (s.shares === 0) s.avgCost = 0;
    }

    equityByTicker.set(t.symbol, s);
  }

  type OptionsState = {
    realized: number;
    openPremium: number;
    unrealized: number;
    cspCollateral: number;
  };
  const optionsByTicker = new Map<string, OptionsState>();

  for (const p of optionsPositions) {
    const o = optionsByTicker.get(p.underlying) ?? {
      realized: 0,
      openPremium: 0,
      unrealized: 0,
      cspCollateral: 0,
    };
    const dollars = p.net_premium * p.quantity * 100;

    if (p.status === "open") {
      o.openPremium += dollars;

      if (p.strategy === "cash_secured_put") {
        o.cspCollateral += p.strike * 100 * p.quantity;
      }

      if (prices) {
        const mark = prices.get(p.option_symbol);
        if (mark !== undefined) {
          const isLong = p.strategy === "long_call" || p.strategy === "long_put";
          const entry = isLong ? p.premium_paid : p.premium_collected;
          if (entry != null) {
            // Long: profit when mark rises above entry debit
            // Short: profit when mark falls below entry credit
            const pl = isLong
              ? (mark - entry) * p.quantity * 100
              : (entry - mark) * p.quantity * 100;
            p.unrealized_pl = pl;
            o.unrealized += pl;
          }
        }
      }
    } else {
      o.realized += dollars;
    }

    optionsByTicker.set(p.underlying, o);
  }

  const tickers = new Set<string>([...equityByTicker.keys(), ...optionsByTicker.keys()]);

  return Array.from(tickers)
    .sort()
    .map((ticker) => {
      const eq = equityByTicker.get(ticker) ?? {
        shares: 0,
        avgCost: 0,
        realized: 0,
        tradeCount: 0,
        grossSpend: 0,
      };
      const op = optionsByTicker.get(ticker) ?? {
        realized: 0,
        openPremium: 0,
        unrealized: 0,
        cspCollateral: 0,
      };

      const equityTotalCost = eq.shares * eq.avgCost;

      const result: TickerPnL = {
        ticker,
        shares_open: eq.shares,
        avg_cost_basis: eq.avgCost,
        equity_total_cost: equityTotalCost,
        equity_realized_pl: eq.realized,
        options_realized_pl: op.realized,
        options_open_premium: op.openPremium,
        total_realized_pl: eq.realized + op.realized,
        trade_count: eq.tradeCount,
        total_gross_spend: eq.grossSpend,
        csp_collateral: op.cspCollateral,
        total_capital_tied_up: equityTotalCost + op.cspCollateral,
      };

      if (prices) {
        const currentPrice = prices.get(ticker);
        const unrealizedEquity =
          eq.shares > 0 && currentPrice !== undefined
            ? eq.shares * (currentPrice - eq.avgCost)
            : 0;
        result.unrealized_equity_pl = unrealizedEquity;
        result.unrealized_options_pl = op.unrealized;
        result.total_pl = result.total_realized_pl + unrealizedEquity + op.unrealized;
      }

      return result;
    });
}
