export type ReceiptRow = {
  id: number;
  visited_on: string | null;
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  created_at: string;
  items: {
    id: number;
    name: string;
    price: number;
    qty: number;
    assignments: {
      diner_id: number;
      share: number;
      diner: { name: string } | null;
    }[];
  }[];
};

/**
 * Compute the total a specific diner paid on one receipt — their item shares
 * plus a tax/tip allocation proportional to their item total.
 */
export function shareForName(receipt: ReceiptRow, name: string): number {
  let mine = 0;
  let everyone = 0;
  for (const it of receipt.items) {
    const line = it.price * it.qty;
    everyone += line;
    for (const a of it.assignments) {
      const share = line * Number(a.share);
      if (a.diner?.name === name) mine += share;
    }
  }
  if (everyone <= 0) return 0;
  const taxTip = (Number(receipt.tax) + Number(receipt.tip)) * (mine / everyone);
  return round2(mine + taxTip);
}

export function computeSelfAverage(
  receipts: ReceiptRow[],
  name: string,
): { count: number; avg: number; total: number } | null {
  if (receipts.length === 0) return null;
  let total = 0;
  let count = 0;
  for (const r of receipts) {
    const s = shareForName(r, name);
    if (s > 0) {
      total += s;
      count += 1;
    }
  }
  if (count === 0) return null;
  return { count, total: round2(total), avg: round2(total / count) };
}

export type SavedDinerBreakdown = {
  diner_id: number;
  name: string;
  items_total: number;
  tax_share: number;
  tip_share: number;
  total: number;
  items: {
    name: string;
    qty: number;
    share: number;
    splitCount: number;
  }[];
};

/**
 * Compute full itemized breakdowns (items, proportional tax, proportional tip,
 * and cent-reconciled total) for every diner on a saved receipt.
 *
 * Absorbs cent-rounding drift on the largest payer so the per-diner totals sum
 * to `subtotal + tax + tip`, matching `splitReceipt` in `lib/receipts.ts`.
 */
export function splitSavedReceipt(receipt: ReceiptRow): {
  per_diner: SavedDinerBreakdown[];
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
} {
  const tax = round2(Number(receipt.tax) || 0);
  const tip = round2(Number(receipt.tip) || 0);
  const byDiner = new Map<
    number,
    {
      diner_id: number;
      name: string;
      rawItemsTotal: number;
      items: { name: string; qty: number; share: number; splitCount: number }[];
    }
  >();

  let assignedSubtotal = 0;
  for (const it of receipt.items) {
    const line = Number(it.price) * Number(it.qty);
    const validAssignments = it.assignments.filter((a) => a.diner?.name);
    const splitCount = validAssignments.length || 1;
    for (const a of validAssignments) {
      const name = a.diner!.name;
      const shareAmt = line * Number(a.share);
      assignedSubtotal += shareAmt;
      const existing = byDiner.get(a.diner_id) ?? {
        diner_id: a.diner_id,
        name,
        rawItemsTotal: 0,
        items: [],
      };
      existing.rawItemsTotal += shareAmt;
      existing.items.push({
        name: it.name,
        qty: Number(it.qty),
        share: round2(shareAmt),
        splitCount,
      });
      byDiner.set(a.diner_id, existing);
    }
  }

  const subtotal = round2(assignedSubtotal > 0 ? assignedSubtotal : Number(receipt.subtotal) || 0);
  const denom = assignedSubtotal > 0 ? assignedSubtotal : 1;

  const per_diner: SavedDinerBreakdown[] = Array.from(byDiner.values()).map((d) => {
    const items_total = round2(d.rawItemsTotal);
    const weight = d.rawItemsTotal / denom;
    const tax_share = round2(tax * weight);
    const tip_share = round2(tip * weight);
    return {
      diner_id: d.diner_id,
      name: d.name,
      items_total,
      tax_share,
      tip_share,
      total: round2(items_total + tax_share + tip_share),
      items: d.items,
    };
  });

  const target = round2(subtotal + tax + tip);
  const sum = round2(per_diner.reduce((s, p) => s + p.total, 0));
  const drift = round2(target - sum);
  if (drift !== 0 && per_diner.length > 0) {
    const biggest = per_diner.reduce((a, b) => (a.total >= b.total ? a : b));
    biggest.total = round2(biggest.total + drift);
  }

  per_diner.sort((a, b) => b.total - a.total);
  return { per_diner, subtotal, tax, tip, total: target };
}

/**
 * Compute totals for every diner that appears on a receipt. Returns one entry
 * per diner, sorted by amount descending.
 */
export function perDinerTotals(receipt: ReceiptRow): { name: string; total: number }[] {
  return splitSavedReceipt(receipt).per_diner.map((p) => ({
    name: p.name,
    total: p.total,
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

