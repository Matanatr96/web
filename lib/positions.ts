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

    const open = legs.find((l) => l.side === openSide);
    if (!open) continue;
    const close = legs.find((l) => l.side === closeSide);

    const premiumCollected = isLong ? (close?.avg_fill_price ?? 0) : open.avg_fill_price;
    const premiumPaid      = isLong ? open.avg_fill_price : (close?.avg_fill_price ?? null);
    const netPremium       = premiumCollected - (premiumPaid ?? 0);

    let status: OptionsPosition["status"];
    if (close) {
      status = "closed";
    } else if (new Date(open.expiration_date) < today) {
      status = open.status === "assigned" ? "assigned" : "expired";
    } else {
      status = "open";
    }

    positions.push({
      underlying:        open.underlying,
      option_symbol:     symbol,
      strategy:          open.strategy,
      strike:            open.strike,
      expiration_date:   open.expiration_date,
      quantity:          open.quantity,
      premium_collected: premiumCollected,
      premium_paid:      premiumPaid,
      net_premium:       netPremium,
      status,
      open_date:  open.order_date,
      close_date: close?.order_date ?? null,
    });
  }

  positions.sort(
    (a, b) => new Date(b.open_date).getTime() - new Date(a.open_date).getTime(),
  );

  return positions;
}
