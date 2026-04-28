"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import type { Restaurant } from "@/lib/types";
import { computeOverall, CUISINES, RATING_WEIGHTS, fmt } from "@/lib/utils";
import PlaceAutocomplete, { type PlacePick } from "@/components/place-autocomplete";

type Props = {
  initial?: Partial<Restaurant>;
  action: (fd: FormData) => Promise<void>;
  submitLabel: string;
  /** Pass existing names to enable duplicate detection (used on "new" page). */
  existingNames?: string[];
  /** Cuisine options fetched from the DB; falls back to hardcoded CUISINES. */
  cuisines?: string[];
  /** When set, "Place" becomes a Google Places Autocomplete that auto-fills city/coords. */
  googleMapsApiKey?: string;
};

/**
 * Shared form used by "new" and "edit" pages. The parent passes a bound
 * server action so we don't need to care whether this is a create or update.
 */
export default function RestaurantForm({ initial, action, submitLabel, existingNames, cuisines: cuisinesProp, googleMapsApiKey }: Props) {
  const cuisineList = cuisinesProp ?? CUISINES;
  const [placeName, setPlaceName] = useState(initial?.name ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [geo, setGeo] = useState<{
    address: string;
    lat: number | null;
    lng: number | null;
    placeId: string;
  }>({
    address: initial?.address ?? "",
    lat: initial?.lat ?? null,
    lng: initial?.lng ?? null,
    placeId: initial?.place_id ?? "",
  });
  const [category, setCategory] = useState(initial?.category ?? "Food");
  const [food, setFood] = useState<number | null>(initial?.food ?? null);
  const [value, setValue] = useState<number | null>(initial?.value ?? null);
  const [service, setService] = useState<number | null>(initial?.service ?? null);
  const [ambiance, setAmbiance] = useState<number | null>(initial?.ambiance ?? null);
  const [veganOptions, setVeganOptions] = useState<number | null>(initial?.vegan_options ?? null);

  const handlePick = useCallback((pick: PlacePick) => {
    setPlaceName(pick.name);
    if (pick.city) setCity(pick.city);
    setGeo({
      address: pick.address,
      lat: pick.lat,
      lng: pick.lng,
      placeId: pick.placeId,
    });
  }, []);

  const computed = computeOverall(category, {
    food, value, service, ambiance, vegan_options: veganOptions,
  });

  const handleNum = useCallback(
    (setter: (v: number | null) => void) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const s = e.target.value.trim();
        setter(s === "" ? null : Number(s));
      },
    []
  );

  const weights = RATING_WEIGHTS[category] ?? RATING_WEIGHTS.Food;

  // Case-insensitive duplicate check
  const duplicateMatch = existingNames?.find(
    (n) => n.toLowerCase() === placeName.trim().toLowerCase()
  );

  return (
    <form action={action} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {duplicateMatch && (
        <div className="sm:col-span-2 rounded-md border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          A restaurant named <strong>{duplicateMatch}</strong> already exists. Are you sure you want to create another?
        </div>
      )}
      <div>
        <label className="block text-sm font-medium mb-1">
          Place<span className="text-red-500"> *</span>
          {googleMapsApiKey && (
            <span className="text-xs text-stone-400 ml-1.5">Google Places</span>
          )}
        </label>
        {googleMapsApiKey ? (
          <PlaceAutocomplete
            apiKey={googleMapsApiKey}
            initialName={initial?.name}
            inputName="name"
            required
            onPick={handlePick}
            onTextChange={setPlaceName}
          />
        ) : (
          <input
            type="text"
            name="name"
            required
            defaultValue={initial?.name ?? ""}
            onChange={(e) => setPlaceName(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
          />
        )}
        {geo.address && (
          <p className="text-xs text-stone-500 mt-1 truncate" title={geo.address}>
            📍 {geo.address}
          </p>
        )}
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          City<span className="text-red-500"> *</span>
        </label>
        <input
          type="text"
          name="city"
          required
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        />
      </div>
      <input type="hidden" name="address" value={geo.address} />
      <input type="hidden" name="lat" value={geo.lat ?? ""} />
      <input type="hidden" name="lng" value={geo.lng ?? ""} />
      <input type="hidden" name="place_id" value={geo.placeId} />
      <SelectField
        label="Category"
        name="category"
        required
        defaultValue={category}
        options={["Food", "Drink", "Dessert"]}
        onChange={(e) => setCategory(e.target.value)}
      />
      <SelectField
        label="Cuisine"
        name="cuisine"
        required
        defaultValue={initial?.cuisine ?? cuisineList[0]}
        options={cuisineList}
      />

      {/* Sub-ratings with weight labels */}
      <NumField
        label="Food"
        name="food"
        step="0.1"
        weight={weights.food}
        defaultValue={initial?.food ?? undefined}
        onChange={handleNum(setFood)}
      />
      <NumField
        label="Value for Money"
        name="value"
        step="0.1"
        weight={weights.value}
        defaultValue={initial?.value ?? undefined}
        onChange={handleNum(setValue)}
      />
      <NumField
        label="Service"
        name="service"
        step="0.1"
        weight={weights.service}
        defaultValue={initial?.service ?? undefined}
        onChange={handleNum(setService)}
      />
      <NumField
        label="Ambiance"
        name="ambiance"
        step="0.1"
        weight={weights.ambiance}
        defaultValue={initial?.ambiance ?? undefined}
        onChange={handleNum(setAmbiance)}
      />
      <NumField
        label="Vegan Options"
        name="vegan_options"
        step="0.1"
        weight={weights.vegan_options}
        defaultValue={initial?.vegan_options ?? undefined}
        onChange={handleNum(setVeganOptions)}
      />

      {/* Computed overall — shown live, sent as a hidden field */}
      <div className="sm:col-span-2 rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/50 px-4 py-3 flex items-center justify-between">
        <div>
          <span className="text-sm font-medium">Overall</span>
          <span className="text-xs text-stone-500 ml-2">
            (auto-computed from weights)
          </span>
        </div>
        <span className="text-lg font-semibold tabular-nums">
          {computed !== null ? fmt(computed, 2) : "—"}
        </span>
        <input type="hidden" name="overall" value={computed !== null ? computed.toFixed(2) : ""} />
      </div>

      <DateField
        label="Last Visited"
        name="last_visited"
        defaultValue={initial?.last_visited ?? new Date().toISOString().slice(0, 10)}
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
  onChange,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string | null;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
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
        onChange={onChange}
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
  weight,
  defaultValue,
  onChange,
}: {
  label: string;
  name: string;
  required?: boolean;
  step?: string;
  weight?: number;
  defaultValue?: number | null;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
        {weight !== undefined && (
          <span className="text-xs text-stone-400 ml-1.5">w={weight}</span>
        )}
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
        onChange={onChange}
        className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 tabular-nums"
      />
    </div>
  );
}

function DateField({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <input
        type="date"
        name={name}
        defaultValue={defaultValue ?? ""}
        className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
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
  onChange,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string;
  options: string[];
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
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
        onChange={onChange}
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
