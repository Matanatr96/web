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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
