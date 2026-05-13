"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { logVisit } from "@/app/admin/actions";

type Props = {
  restaurantId: number;
  restaurantName: string;
  currentRatings: {
    food: number | null;
    value: number | null;
    service: number | null;
    ambiance: number | null;
    vegan_options: number | null;
  };
};

export default function LogVisitButton({ restaurantId, restaurantName, currentRatings }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm hover:underline"
      >
        + Log visit
      </button>
      {open && (
        <LogVisitModal
          restaurantId={restaurantId}
          restaurantName={restaurantName}
          currentRatings={currentRatings}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function LogVisitModal({
  restaurantId,
  restaurantName,
  currentRatings,
  onClose,
}: Props & { onClose: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const today = new Date().toISOString().slice(0, 10);

  function onSubmit(fd: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        await logVisit(restaurantId, fd);
        router.refresh();
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to log visit.");
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-stone-900 rounded-xl shadow-2xl p-6 max-w-md w-full border border-stone-200 dark:border-stone-700 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1">Log a visit</h2>
        <p className="text-sm text-stone-500 mb-4">{restaurantName}</p>

        <form action={onSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Date</label>
            <input
              type="date"
              name="visited_on"
              defaultValue={today}
              max={today}
              className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 tabular-nums"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Comment <span className="text-stone-400 font-normal">(optional)</span></label>
            <textarea
              name="comment"
              rows={3}
              placeholder="How was it this time?"
              className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
            />
          </div>

          <div>
            <p className="text-sm font-medium mb-2">Ratings <span className="text-stone-400 font-normal">(optional — leave blank to skip)</span></p>
            <div className="grid grid-cols-2 gap-2">
              <RatingInput name="food" label="Food" defaultValue={currentRatings.food} />
              <RatingInput name="value" label="Value" defaultValue={currentRatings.value} />
              <RatingInput name="service" label="Service" defaultValue={currentRatings.service} />
              <RatingInput name="ambiance" label="Ambiance" defaultValue={currentRatings.ambiance} />
              <RatingInput name="vegan_options" label="Vegan" defaultValue={currentRatings.vegan_options} />
            </div>
            <p className="text-xs text-stone-500 mt-2">
              Pre-filled with the current weighted averages. Adjust them to reflect this visit — recent visits count more.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-300 dark:border-red-600 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-800 dark:text-red-200">
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800"
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50 font-medium"
            >
              {isPending ? "Saving…" : "Log visit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RatingInput({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: number | null;
}) {
  return (
    <div>
      <label className="block text-xs text-stone-500 mb-1">{label}</label>
      <input
        type="number"
        name={name}
        step="0.1"
        min="0"
        max="10"
        defaultValue={defaultValue ?? ""}
        className="w-full px-2 py-1.5 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 tabular-nums"
      />
    </div>
  );
}
