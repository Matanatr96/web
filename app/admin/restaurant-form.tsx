"use client";

import Link from "next/link";
import type { Restaurant } from "@/lib/types";

type Props = {
  initial?: Partial<Restaurant>;
  action: (fd: FormData) => Promise<void>;
  submitLabel: string;
};

/**
 * Shared form used by "new" and "edit" pages. The parent passes a bound
 * server action so we don't need to care whether this is a create or update.
 */
export default function RestaurantForm({ initial, action, submitLabel }: Props) {
  return (
    <form action={action} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Place" name="name" required defaultValue={initial?.name} />
      <Field label="City" name="city" required defaultValue={initial?.city} />
      <SelectField
        label="Category"
        name="category"
        required
        defaultValue={initial?.category ?? "Food"}
        options={["Food", "Drink", "Dessert"]}
      />
      <Field
        label="Cuisine"
        name="cuisine"
        required
        defaultValue={initial?.cuisine}
      />
      <NumField
        label="Overall"
        name="overall"
        required
        step="0.01"
        defaultValue={initial?.overall ?? undefined}
      />
      <NumField
        label="Food"
        name="food"
        step="0.1"
        defaultValue={initial?.food ?? undefined}
      />
      <NumField
        label="Value for Money"
        name="value"
        step="0.1"
        defaultValue={initial?.value ?? undefined}
      />
      <NumField
        label="Service"
        name="service"
        step="0.1"
        defaultValue={initial?.service ?? undefined}
      />
      <NumField
        label="Ambiance"
        name="ambiance"
        step="0.1"
        defaultValue={initial?.ambiance ?? undefined}
      />
      <NumField
        label="Vegan Options"
        name="vegan_options"
        step="0.1"
        defaultValue={initial?.vegan_options ?? undefined}
      />
      <div className="sm:col-span-2">
        <label className="block text-sm font-medium mb-1">Note</label>
        <textarea
          name="note"
          rows={5}
          defaultValue={initial?.note ?? ""}
          className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        />
      </div>
      <div className="sm:col-span-2 flex items-center gap-3 pt-2">
        <button
          type="submit"
          className="px-4 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90"
        >
          {submitLabel}
        </button>
        <Link href="/admin" className="text-sm text-stone-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  required,
  defaultValue,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string | null;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </label>
      <input
        type="text"
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
      />
    </div>
  );
}

function NumField({
  label,
  name,
  required,
  step,
  defaultValue,
}: {
  label: string;
  name: string;
  required?: boolean;
  step?: string;
  defaultValue?: number | null;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </label>
      <input
        type="number"
        name={name}
        required={required}
        step={step ?? "0.1"}
        min="0"
        max="10"
        defaultValue={
          defaultValue === null || defaultValue === undefined ? "" : String(defaultValue)
        }
        className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 tabular-nums"
      />
    </div>
  );
}

function SelectField({
  label,
  name,
  required,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string;
  options: string[];
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </label>
      <select
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
