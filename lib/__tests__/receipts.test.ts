import { describe, it, expect } from "vitest";
import { splitReceipt, type WizardItem } from "../receipts";

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
