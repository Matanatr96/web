export type ParsedReceiptItem = {
  name: string;
  price: number;
  qty: number;
};

export type ParsedReceipt = {
  merchant: string | null;
  items: ParsedReceiptItem[];
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  confidence: number;
};

export type Diner = {
  id: number;
  name: string;
  is_self: boolean;
  last_used_at: string;
};

export type WizardItem = ParsedReceiptItem & {
  /** Diner ids assigned to this item. Even split among assignees. */
  diner_ids: number[];
};

export type PerDinerTotal = {
  diner_id: number;
  name: string;
  items_total: number;
  tax_share: number;
  tip_share: number;
  total: number;
};

/**
 * Split a receipt across diners. Each item's cost is divided evenly among its
 * assigned diners. Tax and tip are allocated proportional to each diner's item
 * total. Rounding remainder is absorbed by the largest payer so the per-person
 * totals sum exactly to `subtotal + tax + tip`.
 */
export function splitReceipt(
  items: WizardItem[],
  diners: Pick<Diner, "id" | "name">[],
  tax: number,
  tip: number,
): { per_diner: PerDinerTotal[]; subtotal: number } {
  const nameOf = new Map(diners.map((d) => [d.id, d.name]));
  const itemsTotal = new Map<number, number>();
  for (const d of diners) itemsTotal.set(d.id, 0);

  let subtotal = 0;
  for (const it of items) {
    const line = it.price * it.qty;
    subtotal += line;
    if (it.diner_ids.length === 0) continue;
    const share = line / it.diner_ids.length;
    for (const id of it.diner_ids) {
      itemsTotal.set(id, (itemsTotal.get(id) ?? 0) + share);
    }
  }

  // Round subtotal to cents to match parsed values.
  subtotal = round2(subtotal);

  const denom = subtotal > 0 ? subtotal : 1;

  const per_diner: PerDinerTotal[] = diners
    .map((d) => {
      const items_total = round2(itemsTotal.get(d.id) ?? 0);
      const weight = (itemsTotal.get(d.id) ?? 0) / denom;
      const tax_share = round2(tax * weight);
      const tip_share = round2(tip * weight);
      return {
        diner_id: d.id,
        name: nameOf.get(d.id) ?? "",
        items_total,
        tax_share,
        tip_share,
        total: round2(items_total + tax_share + tip_share),
      };
    })
    .filter((p) => p.items_total > 0 || tax > 0 || tip > 0);

  // Absorb rounding drift on the largest payer.
  const target = round2(subtotal + tax + tip);
  const sum = round2(per_diner.reduce((s, p) => s + p.total, 0));
  const drift = round2(target - sum);
  if (drift !== 0 && per_diner.length > 0) {
    const biggest = per_diner.reduce((a, b) => (a.total >= b.total ? a : b));
    biggest.total = round2(biggest.total + drift);
  }

  return { per_diner, subtotal };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
