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

/**
 * Round a numeric value to 2 decimal places (cents).
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type ShareableDinerLineItem = {
  name: string;
  share: number;
  splitCount: number;
};

/**
 * Format a receipt split into a human-readable text summary suitable for
 * pasting into group chats (Signal, iMessage, WhatsApp).
 *
 * @param params - Receipt title/date, per-diner totals, optional per-diner line items, tax, tip, and share URL.
 * @returns Multi-line formatted summary string.
 */
export function formatReceiptSplitText(params: {
  title?: string | null;
  date?: string | null;
  perDiner: PerDinerTotal[];
  dinerItems?: Map<number, ShareableDinerLineItem[]>;
  subtotal: number;
  tax: number;
  tip: number;
  url?: string | null;
}): string {
  const { title, date, perDiner, dinerItems, subtotal, tax, tip, url } = params;
  const total = round2(subtotal + tax + tip);
  const headerParts = [title?.trim() || "Receipt Split", date?.trim() || null].filter(Boolean);
  const lines: string[] = [`🧾 ${headerParts.join(" — ")}`];

  for (const p of perDiner) {
    lines.push(`• ${p.name}: $${p.total.toFixed(2)} (items $${p.items_total.toFixed(2)}, tax $${p.tax_share.toFixed(2)}, tip $${p.tip_share.toFixed(2)})`);
    const items = dinerItems?.get(p.diner_id) ?? [];
    for (const it of items) {
      const splitNote = it.splitCount > 1 ? ` (1/${it.splitCount})` : "";
      lines.push(`   - ${it.name}${splitNote}: $${it.share.toFixed(2)}`);
    }
  }

  lines.push(`Total: $${total.toFixed(2)} (subtotal $${round2(subtotal).toFixed(2)}, tax $${round2(tax).toFixed(2)}, tip $${round2(tip).toFixed(2)})`);
  if (url) {
    lines.push(url);
  }
  return lines.join("\n");
}

