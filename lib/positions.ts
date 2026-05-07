import type { OptionsTrade, OptionsPosition } from "@/lib/types";

export function buildPositions(trades: OptionsTrade[]): OptionsPosition[] {
  const bySymbol = new Map<string, OptionsTrade[]>();
  for (const t of trades) {
    const bucket = bySymbol.get(t.option_symbol) ?? [];
    bucket.push(t);
    bySymbol.set(t.option_symbol, bucket);
  }

  const today = new Date();
  const positions: OptionsPosition[] = [];

  for (const [symbol, legs] of bySymbol) {
    const isLong = legs.some((l) => l.side === "buy_to_open");
    const openSide  = isLong ? "buy_to_open"  : "sell_to_open";
    const closeSide = isLong ? "sell_to_close" : "buy_to_close";

    const opens = legs.filter((l) => l.side === openSide);
    if (opens.length === 0) continue;
    opens.sort((a, b) => a.order_date.localeCompare(b.order_date));

    const totalQty = opens.reduce((sum, l) => sum + l.quantity, 0);
    const weightedAvgFill =
      opens.reduce((sum, l) => sum + l.avg_fill_price * l.quantity, 0) / totalQty;

    const close = legs.find((l) => l.side === closeSide);
    const firstOpen = opens[0];

    const premiumCollected = isLong ? (close?.avg_fill_price ?? 0) : weightedAvgFill;
    const premiumPaid      = isLong ? weightedAvgFill : (close?.avg_fill_price ?? null);
    const netPremium       = premiumCollected - (premiumPaid ?? 0);

    let status: OptionsPosition["status"];
    if (close) {
      status = "closed";
    } else if (new Date(firstOpen.expiration_date) < today) {
      status = opens.some((l) => l.status === "assigned") ? "assigned" : "expired";
    } else {
      status = "open";
    }

    positions.push({
      underlying:        firstOpen.underlying,
      option_symbol:     symbol,
      strategy:          firstOpen.strategy,
      strike:            firstOpen.strike,
      expiration_date:   firstOpen.expiration_date,
      quantity:          totalQty,
      premium_collected: premiumCollected,
      premium_paid:      premiumPaid,
      net_premium:       netPremium,
      status,
      open_date:  firstOpen.order_date,
      close_date: close?.order_date ?? null,
    });
  }

  positions.sort(
    (a, b) => new Date(b.open_date).getTime() - new Date(a.open_date).getTime(),
  );

  return positions;
}
