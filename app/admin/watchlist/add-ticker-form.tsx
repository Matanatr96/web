"use client";

import { useActionState } from "react";
import { addToWatchlist } from "./actions";

const emptyState = { error: null };

export default function AddTickerForm() {
  const [state, formAction, pending] = useActionState(addToWatchlist, emptyState);

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          name="ticker"
          required
          placeholder="e.g. AAPL"
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-transparent focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-500 uppercase placeholder:normal-case w-32"
        />
        <button
          type="submit"
          disabled={pending}
          className="px-3 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {state?.error && (
        <p className="text-xs text-red-600">{state.error}</p>
      )}
    </form>
  );
}
