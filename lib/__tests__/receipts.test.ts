import { describe, it, expect } from "vitest";
import { formatReceiptSplitText, splitReceipt, type WizardItem } from "../receipts";
import { perDinerTotals, splitSavedReceipt, type ReceiptRow } from "../restaurant-receipts";

const diners = [
  { id: 1, name: "Anush" },
  { id: 2, name: "Bo" },
  { id: 3, name: "Cleo" },
];

describe("splitReceipt", () => {
  it("assigns solo items entirely to one diner", () => {
    const items: WizardItem[] = [
      { name: "Burger", price: 20, qty: 1, diner_ids: [1] },
      { name: "Salad", price: 10, qty: 1, diner_ids: [2] },
    ];
    const { per_diner, subtotal } = splitReceipt(items, diners, 0, 0);
    expect(subtotal).toBe(30);
    const anush = per_diner.find((p) => p.diner_id === 1)!;
    const bo = per_diner.find((p) => p.diner_id === 2)!;
    expect(anush.total).toBe(20);
    expect(bo.total).toBe(10);
    expect(per_diner.find((p) => p.diner_id === 3)).toBeUndefined();
  });

  it("splits items evenly among assigned diners", () => {
    const items: WizardItem[] = [
      { name: "Pizza", price: 30, qty: 1, diner_ids: [1, 2, 3] },
    ];
    const { per_diner } = splitReceipt(items, diners, 0, 0);
    for (const p of per_diner) expect(p.items_total).toBe(10);
  });

  it("allocates tax and tip proportional to item totals", () => {
    const items: WizardItem[] = [
      { name: "Steak", price: 60, qty: 1, diner_ids: [1] },
      { name: "Soup", price: 20, qty: 1, diner_ids: [2] },
    ];
    // subtotal 80, tax 8 (10%), tip 16 (20%)
    const { per_diner } = splitReceipt(items, diners, 8, 16);
    const anush = per_diner.find((p) => p.diner_id === 1)!;
    const bo = per_diner.find((p) => p.diner_id === 2)!;
    expect(anush.tax_share).toBe(6);
    expect(anush.tip_share).toBe(12);
    expect(anush.total).toBe(78);
    expect(bo.tax_share).toBe(2);
    expect(bo.tip_share).toBe(4);
    expect(bo.total).toBe(26);
  });

  it("absorbs rounding drift on the largest payer", () => {
    const items: WizardItem[] = [
      { name: "A", price: 10, qty: 1, diner_ids: [1, 2, 3] },
    ];
    const { per_diner } = splitReceipt(items, diners, 0, 1); // 1c tip, awkward
    const sum = per_diner.reduce((s, p) => s + p.total, 0);
    expect(Math.round(sum * 100) / 100).toBe(11);
  });
});

describe("formatReceiptSplitText", () => {
  it("formats a group-chat summary with per-diner totals, items, and share link", () => {
    const text = formatReceiptSplitText({
      title: "Taco Stand",
      date: "2026-10-07",
      perDiner: [
        { diner_id: 1, name: "Anush", items_total: 15, tax_share: 1.5, tip_share: 3, total: 19.5 },
        { diner_id: 2, name: "Bo", items_total: 10, tax_share: 1, tip_share: 2, total: 13 },
      ],
      dinerItems: new Map([
        [1, [{ name: "Al Pastor", share: 10, splitCount: 1 }, { name: "Chips", share: 5, splitCount: 2 }]],
        [2, [{ name: "Carnitas", share: 5, splitCount: 1 }, { name: "Chips", share: 5, splitCount: 2 }]],
      ]),
      subtotal: 25,
      tax: 2.5,
      tip: 5,
      url: "https://example.com/restaurants/receipt/42",
    });

    expect(text).toContain("🧾 Taco Stand — 2026-10-07");
    expect(text).toContain("• Anush: $19.50 (items $15.00, tax $1.50, tip $3.00)");
    expect(text).toContain("   - Chips (1/2): $5.00");
    expect(text).toContain("Total: $32.50 (subtotal $25.00, tax $2.50, tip $5.00)");
    expect(text).toContain("https://example.com/restaurants/receipt/42");
  });
});

describe("splitSavedReceipt & perDinerTotals", () => {
  it("computes per-diner breakdowns and absorbs cent-rounding drift on saved receipts", () => {
    const receipt: ReceiptRow = {
      id: 99,
      visited_on: "2026-10-07",
      subtotal: 10,
      tax: 0,
      tip: 1,
      total: 11,
      created_at: "2026-10-07T00:00:00Z",
      items: [
        {
          id: 1,
          name: "Shared Nachos",
          price: 10,
          qty: 1,
          assignments: [
            { diner_id: 1, share: 0.3333, diner: { name: "Anush" } },
            { diner_id: 2, share: 0.3333, diner: { name: "Bo" } },
            { diner_id: 3, share: 0.3334, diner: { name: "Cleo" } },
          ],
        },
      ],
    };

    const split = splitSavedReceipt(receipt);
    const sum = Math.round(split.per_diner.reduce((s, p) => s + p.total, 0) * 100) / 100;
    expect(sum).toBe(11);
    expect(perDinerTotals(receipt).reduce((s, d) => s + d.total, 0)).toBeCloseTo(11, 2);
  });
});

