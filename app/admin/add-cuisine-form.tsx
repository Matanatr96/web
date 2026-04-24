"use client";

import { useActionState, useState } from "react";
import { addCuisine, updateCuisine, deleteCuisine } from "./actions";

const emptyState = { error: null };

type Cuisine = { id: number; name: string };

function EditRow({ cuisine, onCancel }: { cuisine: Cuisine; onCancel: () => void }) {
  const [state, formAction, pending] = useActionState(updateCuisine, emptyState);

  return (
    <form action={formAction} className="flex gap-2 items-start">
      <input type="hidden" name="id" value={cuisine.id} />
      <div className="flex flex-col gap-1">
        <input
          name="name"
          required
          defaultValue={cuisine.name}
          className="px-2 py-1 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-400"
        />
        {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="px-2 py-1 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="px-2 py-1 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800"
      >
        Cancel
      </button>
    </form>
  );
}

function CuisineRow({ cuisine }: { cuisine: Cuisine }) {
  const [editing, setEditing] = useState(false);
  const deleteAction = deleteCuisine.bind(null, cuisine.id);

  if (editing) {
    return <EditRow cuisine={cuisine} onCancel={() => setEditing(false)} />;
  }

  return (
    <div className="flex items-center gap-2 group">
      <span className="text-sm">{cuisine.name}</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        Edit
      </button>
      <form action={deleteAction}>
        <button
          type="submit"
          onClick={(e) => {
            if (!confirm(`Delete "${cuisine.name}"? Restaurants using this cuisine won't be affected.`)) {
              e.preventDefault();
            }
          }}
          className="text-xs text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Delete
        </button>
      </form>
    </div>
  );
}

function AddForm() {
  const [state, formAction, pending] = useActionState(addCuisine, emptyState);

  return (
    <form action={formAction} className="flex gap-2 items-start mt-4">
      <div className="flex flex-col gap-1">
        <input
          name="name"
          required
          placeholder="New cuisine…"
          className="px-3 py-1.5 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-400"
        />
        {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
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

export default function CuisineManager({ cuisines }: { cuisines: Cuisine[] }) {
  return (
    <div>
      <div className="flex flex-col gap-2">
        {cuisines.map((c) => (
          <CuisineRow key={c.id} cuisine={c} />
        ))}
      </div>
      <AddForm />
    </div>
  );
}
