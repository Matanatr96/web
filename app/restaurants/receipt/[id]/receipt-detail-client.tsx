"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { formatReceiptSplitText, type ShareableDinerLineItem } from "@/lib/receipts";
import type { SavedDinerBreakdown } from "@/lib/restaurant-receipts";
import LinkReceiptDialog from "@/components/link-receipt-dialog";

export type SavedReceiptItemView = {
  id: number;
  name: string;
  price: number;
  qty: number;
  dinerNames: string[];
};

/**
 * Interactive client view for a saved receipt split (`/restaurants/receipt/[id]`).
 * Displays expandable per-diner totals, itemized shares, copy/share buttons,
 * and optional admin Google Maps restaurant linking.
 */
export default function ReceiptDetailClient({
  receiptId,
  title,
  date,
  restaurant,
  parsedMerchant,
  perDiner,
  items,
  subtotal,
  tax,
  tip,
  total,
  isAdmin,
  googleMapsApiKey,
}: {
  receiptId: number;
  title: string;
  date: string;
  restaurant: { id: number; name: string; city: string | null } | null;
  parsedMerchant: string | null;
  perDiner: SavedDinerBreakdown[];
  items: SavedReceiptItemView[];
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  isAdmin: boolean;
  googleMapsApiKey?: string;
}) {
  // Expand all diners by default on the shareable detail page so everyone immediately sees their items.
  const [expandedDiners, setExpandedDiners] = useState<Set<number>>(
    () => new Set(perDiner.map((p) => p.diner_id)),
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "link-copied">("idle");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  const dinerItemsMap = useMemo(() => {
    const map = new Map<number, ShareableDinerLineItem[]>();
    for (const p of perDiner) {
      map.set(
        p.diner_id,
        p.items.map((it) => ({
          name: it.qty > 1 ? `${it.name} (${it.qty}×)` : it.name,
          share: it.share,
          splitCount: it.splitCount,
        })),
      );
    }
    return map;
  }, [perDiner]);

  function getShareUrl(): string {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/restaurants/receipt/${receiptId}`;
    }
    return `/restaurants/receipt/${receiptId}`;
  }

  function buildShareText(): string {
    return formatReceiptSplitText({
      title,
      date,
      perDiner,
      dinerItems: dinerItemsMap,
      subtotal,
      tax,
      tip,
      url: getShareUrl(),
    });
  }

  async function handleCopySplit() {
    try {
      await navigator.clipboard.writeText(buildShareText());
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2500);
    } catch {
      // Ignore clipboard failure
    }
  }

  async function handleShareLink() {
    const url = getShareUrl();
    const text = buildShareText();
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `${title} — Receipt Split`,
          text,
          url,
        });
        return;
      } catch {
        // User cancelled or share failed; fall back to copying URL.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("link-copied");
      setTimeout(() => setCopyStatus("idle"), 2500);
    } catch {
      // Ignore clipboard failure
    }
  }

  const canLink = isAdmin && !restaurant && Boolean(googleMapsApiKey);

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-stone-200 dark:border-stone-800 p-5 bg-white dark:bg-stone-900">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-lg font-semibold">Who owes what</h2>
            <p className="text-xs text-stone-500">
              Tap a name to toggle itemized breakdown. Tax and tip are split proportionally.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopySplit}
              className="px-3 py-1.5 text-xs rounded border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 font-medium"
            >
              {copyStatus === "copied" ? "Copied breakdown ✓" : "📋 Copy split for chat"}
            </button>
            <button
              type="button"
              onClick={handleShareLink}
              className="px-3 py-1.5 text-xs rounded bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 font-medium"
            >
              {copyStatus === "link-copied" ? "Copied link ✓" : "🔗 Share link"}
            </button>
          </div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-stone-500">
              <th className="font-normal py-1">Diner</th>
              <th className="font-normal py-1 text-right">Items</th>
              <th className="font-normal py-1 text-right">+Tax</th>
              <th className="font-normal py-1 text-right">+Tip</th>
              <th className="font-normal py-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {perDiner.map((p) => {
              const isOpen = expandedDiners.has(p.diner_id);
              return (
                <Fragment key={p.diner_id}>
                  <tr
                    className="border-t border-stone-200 dark:border-stone-800 cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50"
                    onClick={() =>
                      setExpandedDiners((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.diner_id)) next.delete(p.diner_id);
                        else next.add(p.diner_id);
                        return next;
                      })
                    }
                  >
                    <td className="py-2 font-medium">
                      <span className="inline-block w-3 text-stone-400 tabular-nums">
                        {isOpen ? "▾" : "▸"}
                      </span>{" "}
                      {p.name}
                    </td>
                    <td className="py-2 text-right tabular-nums">${p.items_total.toFixed(2)}</td>
                    <td className="py-2 text-right tabular-nums text-stone-500">${p.tax_share.toFixed(2)}</td>
                    <td className="py-2 text-right tabular-nums text-stone-500">${p.tip_share.toFixed(2)}</td>
                    <td className="py-2 text-right tabular-nums font-semibold">${p.total.toFixed(2)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-stone-50 dark:bg-stone-800/30">
                      <td colSpan={5} className="py-2 px-3">
                        {p.items.length === 0 ? (
                          <p className="text-xs text-stone-500">No items assigned.</p>
                        ) : (
                          <ul className="text-xs space-y-1">
                            {p.items.map((it, i) => (
                              <li key={i} className="flex justify-between gap-3">
                                <span className="text-stone-700 dark:text-stone-300">
                                  {it.name}
                                  {it.qty > 1 && <span className="text-stone-400"> ({it.qty}×)</span>}
                                  <span className="text-stone-500 ml-2">
                                    {it.splitCount === 1
                                      ? "(solo)"
                                      : `(split ${it.splitCount} ways)`}
                                  </span>
                                </span>
                                <span className="tabular-nums text-stone-600 dark:text-stone-400">
                                  ${it.share.toFixed(2)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-stone-300 dark:border-stone-700 text-stone-500">
              <td className="py-2">Total</td>
              <td className="py-2 text-right tabular-nums">${subtotal.toFixed(2)}</td>
              <td className="py-2 text-right tabular-nums">${tax.toFixed(2)}</td>
              <td className="py-2 text-right tabular-nums">${tip.toFixed(2)}</td>
              <td className="py-2 text-right tabular-nums font-semibold text-stone-900 dark:text-stone-100">
                ${total.toFixed(2)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {items.length > 0 && (
        <div className="rounded-md border border-stone-200 dark:border-stone-800 p-5 bg-white dark:bg-stone-900">
          <h2 className="text-sm uppercase tracking-wide text-stone-500 mb-3">
            Receipt Line Items ({items.length})
          </h2>
          <ul className="divide-y divide-stone-100 dark:divide-stone-800 text-sm">
            {items.map((it) => (
              <li key={it.id} className="py-2 flex items-baseline justify-between gap-3">
                <div>
                  <span className="font-medium">{it.name}</span>
                  {it.qty > 1 && (
                    <span className="text-xs text-stone-500 ml-1.5">
                      ({it.qty}×${Number(it.price).toFixed(2)})
                    </span>
                  )}
                  {it.dinerNames.length > 0 && (
                    <span className="text-xs text-stone-500 ml-2">
                      · {it.dinerNames.join(", ")}
                    </span>
                  )}
                </div>
                <span className="tabular-nums text-stone-700 dark:text-stone-300">
                  ${(Number(it.price) * Number(it.qty)).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canLink && (
        <div className="rounded-md border border-stone-200 dark:border-stone-800 p-4 bg-white dark:bg-stone-900 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-stone-500">
            This receipt isn&apos;t linked to a restaurant yet.
          </p>
          <button
            type="button"
            onClick={() => setLinkDialogOpen(true)}
            className="px-3 py-1.5 rounded bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 text-xs font-medium hover:opacity-90"
          >
            📍 Find on Google Maps
          </button>
          <LinkReceiptDialog
            receiptId={receiptId}
            initialName={parsedMerchant ?? undefined}
            apiKey={googleMapsApiKey!}
            open={linkDialogOpen}
            onClose={() => setLinkDialogOpen(false)}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-sm text-stone-500">
        <Link href="/restaurants/receipt" className="hover:underline">
          + Split another receipt
        </Link>
        {restaurant && (
          <Link href={`/restaurant/${restaurant.id}`} className="hover:underline">
            View {restaurant.name} →
          </Link>
        )}
        {isAdmin && (
          <Link href="/admin/receipts" className="hover:underline">
            All receipt history →
          </Link>
        )}
      </div>
    </div>
  );
}
