"use client";

import { useActionState, useState, useRef, useEffect } from "react";
import { addCuisine, updateCuisine, deleteCuisine } from "./actions";

const emptyState = { error: null };

type Cuisine = { id: number; name: string };

function CuisineChip({ cuisine }: { cuisine: Cuisine }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(updateCuisine, emptyState);
  const inputRef = useRef<HTMLInputElement>(null);
  const deleteAction = deleteCuisine.bind(null, cuisine.id);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <form action={formAction} className="flex flex-col gap-1">
        <input type="hidden" name="id" value={cuisine.id} />
        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-stone-400 dark:border-stone-500 bg-white dark:bg-stone-900">
          <input
            ref={inputRef}
            name="name"
            required
            defaultValue={cuisine.name}
            onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            className="text-xs w-24 bg-transparent focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending}
            title="Save"
            className="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-50"
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            title="Cancel"
            className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          >
            ✕
          </button>
        </div>
        {state?.error && <p className="text-xs text-red-600 pl-2">{state.error}</p>}
      </form>
    );
  }

  return (
    <div className="group flex items-center gap-1 px-2 py-0.5 rounded-full border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:border-stone-400 dark:hover:border-stone-500 transition-colors">
      <span className="text-xs">{cuisine.name}</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit"
        className="hidden group-hover:inline text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 text-xs leading-none"
      >
        ✎
      </button>
      <form action={deleteAction} className="hidden group-hover:inline">
        <button
          type="submit"
          title="Delete"
          onClick={(e) => {
            if (!confirm(`Delete "${cuisine.name}"?`)) e.preventDefault();
          }}
          className="text-stone-400 hover:text-red-500 text-xs leading-none"
        >
          ✕
        </button>
      </form>
    </div>
  );
}

function AddForm() {
  const [state, formAction, pending] = useActionState(addCuisine, emptyState);

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <div className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-stone-300 dark:border-stone-600 w-fit">
        <input
          name="name"
          required
          placeholder="Add cuisine…"
          className="text-xs w-28 bg-transparent focus:outline-none placeholder:text-stone-400"
        />
        <button
          type="submit"
          disabled={pending}
          title="Add"
          className="text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-50 text-xs"
        >
          +
        </button>
      </div>
      {state?.error && <p className="text-xs text-red-600 pl-2">{state.error}</p>}
    </form>
  );
}

export default function CuisineManager({ cuisines }: { cuisines: Cuisine[] }) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      {cuisines.map((c) => (
        <CuisineChip key={c.id} cuisine={c} />
      ))}
      <AddForm />
    </div>
  );
}
