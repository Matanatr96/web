"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import PlaceAutocomplete, { type PlacePick } from "@/components/place-autocomplete";

type Props = {
  receiptId: number;
  initialName?: string;
  apiKey: string;
  open: boolean;
  onClose: () => void;
};

/**
 * Modal that lets the admin pick a Google Place to link an existing receipt
 * to. On confirm, hits /api/receipts/link which upserts the restaurant row
 * (if needed) and sets receipts.restaurant_id. If a new restaurant was
 * created, the admin is sent to /admin/[id]/edit to rate it.
 */
export default function LinkReceiptDialog({ receiptId, initialName, apiKey, open, onClose }: Props) {
  const router = useRouter();
  const [pick, setPick] = useState<PlacePick | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit() {
    if (!pick) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/receipts/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipt_id: receiptId, place: pick }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error ?? "link failed");
      // If new (or unrated) restaurant, send admin to the edit page to rate.
      if (json.is_new || !json.is_rated) {
        router.push(`/admin/${json.restaurant_id}/edit`);
      } else {
        router.refresh();
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-stone-900 rounded-xl shadow-2xl p-6 max-w-md w-full border border-stone-200 dark:border-stone-700"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1">Link receipt to a restaurant</h2>
        <p className="text-sm text-stone-500 mb-4">
          Search Google Maps. {initialName ? <>Parser saw <strong>{initialName}</strong> on the receipt.</> : "Pick the spot you visited."}
        </p>
        <PlaceAutocomplete
          apiKey={apiKey}
          initialName={initialName}
          inputName="receipt_link_place"
          onPick={setPick}
        />
        {pick && (
          <div className="mt-3 text-xs text-stone-500">
            <div className="font-medium text-stone-700 dark:text-stone-300">{pick.name}</div>
            <div>{pick.address}</div>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="flex flex-col gap-2 mt-5">
          <button
            type="button"
            onClick={submit}
            disabled={!pick || submitting}
            className="px-4 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50 font-medium"
          >
            {submitting ? "Linking…" : "Link & rate"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
