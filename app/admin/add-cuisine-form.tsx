"use client";

import { useActionState } from "react";
import { addCuisine } from "./actions";

const initial = { error: null };

export default function AddCuisineForm() {
  const [state, formAction, pending] = useActionState(addCuisine, initial);

  return (
    <form action={formAction} className="flex gap-2 items-start">
      <div className="flex flex-col gap-1">
        <input
          name="name"
          required
          placeholder="New cuisine…"
          className="px-3 py-1.5 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-400"
        />
        {state?.error && (
          <p className="text-xs text-red-600">{state.error}</p>
        )}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50"
      >
        Add
      </button>
    </form>
  );
}
