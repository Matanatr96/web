"use client";

import { useState, useCallback, useEffect, useRef, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import type { Restaurant } from "@/lib/types";
import { computeOverall, CUISINES, RATING_WEIGHTS, fmt } from "@/lib/utils";
import { matchCuisineFromGoogleType } from "@/lib/restaurants-query";
import PlaceAutocomplete, { type PlacePick } from "@/components/place-autocomplete";

type ReviewPromptData = { placeId: string; note: string | null; name: string };

type Props = {
  initial?: Partial<Restaurant>;
  action: (fd: FormData) => Promise<{ placeId: string | null; note: string | null; name: string } | void>;
  submitLabel: string;
  /** Pass existing names to enable duplicate detection (used on "new" page). */
  existingNames?: string[];
  /** Map of place_id → restaurant name for duplicate place detection. */
  existingPlaceIds?: Record<string, string>;
  /** Cuisine options fetched from the DB; falls back to hardcoded CUISINES. */
  cuisines?: string[];
  /** When set, "Place" becomes a Google Places Autocomplete that auto-fills city/coords. */
  googleMapsApiKey?: string;
};

/**
 * Shared form used by "new" and "edit" pages. The parent passes a bound
 * server action so we don't need to care whether this is a create or update.
 */
export default function RestaurantForm({ initial, action, submitLabel, existingNames, existingPlaceIds, cuisines: cuisinesProp, googleMapsApiKey }: Props) {
  const router = useRouter();
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
  const [existingPhotos, setExistingPhotos] = useState<string[]>(initial?.photos ?? []);
  const [deletedPhotos, setDeletedPhotos] = useState<string[]>([]);
  const [newFilePreviews, setNewFilePreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [duplicatePlaceMatch, setDuplicatePlaceMatch] = useState<string | null>(null);
  const [category, setCategory] = useState(initial?.category ?? "Food");
  const [selectedCuisines, setSelectedCuisines] = useState<Set<string>>(
    () => new Set(initial?.cuisines ?? []),
  );
  const [googleTypeSuggestion, setGoogleTypeSuggestion] = useState<string | null>(null);

  const toggleCuisine = useCallback((name: string) => {
    setSelectedCuisines((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
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
    setDuplicatePlaceMatch(
      pick.placeId && existingPlaceIds?.[pick.placeId]
        ? existingPlaceIds[pick.placeId]
        : null
    );
    // Try to auto-select cuisine from the Google Maps primary type.
    if (pick.googleType) setGoogleTypeSuggestion(pick.googleType);
    const best = matchCuisineFromGoogleType(
      pick.googleType,
      pick.googleTypeRaw,
      cuisineList,
    );
    if (best) {
      // Add the auto-detected cuisine without clobbering any user selections.
      setSelectedCuisines((prev) => {
        if (prev.has(best)) return prev;
        const next = new Set(prev);
        next.add(best);
        return next;
      });
    }
  }, [existingPlaceIds, cuisineList]);

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

  const handleFilesChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setNewFilePreviews((prev) => {
      prev.forEach(URL.revokeObjectURL);
      return files.map((f) => URL.createObjectURL(f));
    });
  }, []);

  useEffect(() => () => newFilePreviews.forEach(URL.revokeObjectURL), []);

  const removeExistingPhoto = useCallback((url: string) => {
    setExistingPhotos((prev) => prev.filter((u) => u !== url));
    setDeletedPhotos((prev) => [...prev, url]);
  }, []);

  const weights = RATING_WEIGHTS[category] ?? RATING_WEIGHTS.Food;

  const [isPending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reviewPrompt, setReviewPrompt] = useState<ReviewPromptData | null>(null);

  const handleSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setSubmitError(null);
    if (selectedCuisines.size === 0) {
      setSubmitError("Pick at least one cuisine.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await action(fd);
        if (result?.placeId) {
          setReviewPrompt({ placeId: result.placeId, note: result.note ?? null, name: result.name });
        } else {
          router.push("/admin/restaurants");
        }
      } catch (err) {
        if (isRedirectError(err)) throw err;
        setSubmitError(err instanceof Error ? err.message : "An unexpected error occurred.");
      }
    });
  }, [action, router, selectedCuisines]);

  // Case-insensitive duplicate check
  const duplicateMatch = existingNames?.find(
    (n) => n.toLowerCase() === placeName.trim().toLowerCase()
  );

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {duplicateMatch && (
        <div className="sm:col-span-2 rounded-md border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          A restaurant named <strong>{duplicateMatch}</strong> already exists. Are you sure you want to create another?
        </div>
      )}
      {submitError && (
        <div className="sm:col-span-2 rounded-md border border-red-300 dark:border-red-600 bg-red-50 dark:bg-red-900/30 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          <strong>Error:</strong> {submitError}
        </div>
      )}
      {duplicatePlaceMatch && (
        <div className="sm:col-span-2 rounded-md border border-red-300 dark:border-red-600 bg-red-50 dark:bg-red-900/30 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          This exact place is already saved as <strong>{duplicatePlaceMatch}</strong>. Adding it again will be rejected.
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
      <div className="sm:col-span-2">
        <div className="flex items-baseline justify-between mb-1">
          <label className="block text-sm font-medium">
            Cuisines<span className="text-red-500"> *</span>
          </label>
          <span className="text-xs text-stone-400">
            {selectedCuisines.size} selected
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-3 gap-y-1.5 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 p-3 max-h-56 overflow-y-auto">
          {cuisineList.map((c) => {
            const checked = selectedCuisines.has(c);
            return (
              <label key={c} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  name="cuisine"
                  value={c}
                  checked={checked}
                  onChange={() => toggleCuisine(c)}
                  className="h-4 w-4 rounded border-stone-300 dark:border-stone-700"
                />
                <span className={checked ? "font-medium" : "text-stone-600 dark:text-stone-400"}>{c}</span>
              </label>
            );
          })}
        </div>
        {googleTypeSuggestion && (
          <p className="text-xs text-stone-400 mt-1">
            Google Maps: <span className="font-medium text-stone-500">{googleTypeSuggestion}</span>
          </p>
        )}
      </div>

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
      {/* Photos */}
      <div className="sm:col-span-2">
        <label className="block text-sm font-medium mb-2">Photos</label>
        {existingPhotos.length > 0 && (
          <div className="flex flex-wrap gap-3 mb-3">
            {existingPhotos.map((url) => (
              <div key={url} className="relative group w-24 h-24">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  className="w-24 h-24 object-cover rounded-md border border-stone-200 dark:border-stone-700"
                />
                <button
                  type="button"
                  onClick={() => removeExistingPhoto(url)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove photo"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {newFilePreviews.length > 0 && (
          <div className="flex flex-wrap gap-3 mb-3">
            {newFilePreviews.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={url}
                alt=""
                className="w-24 h-24 object-cover rounded-md border border-stone-300 dark:border-stone-700 opacity-70"
              />
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          name="photos"
          accept="image/*"
          multiple
          onChange={handleFilesChange}
          className="block w-full text-sm text-stone-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-stone-100 dark:file:bg-stone-800 file:text-stone-700 dark:file:text-stone-300 hover:file:bg-stone-200 dark:hover:file:bg-stone-700"
        />
        <input type="hidden" name="existing_photos" value={JSON.stringify(existingPhotos)} />
        <input type="hidden" name="deleted_photos" value={JSON.stringify(deletedPhotos)} />
      </div>

      <div className="sm:col-span-2 flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : submitLabel}
        </button>
        <Link href="/admin" className="text-sm text-stone-500 hover:underline">
          Cancel
        </Link>
      </div>
      {reviewPrompt && (
        <GoogleReviewPrompt
          data={reviewPrompt}
          onDismiss={() => router.push("/admin/restaurants")}
        />
      )}
    </form>
  );
}

function GoogleReviewPrompt({ data, onDismiss }: { data: ReviewPromptData; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const reviewUrl = `https://search.google.com/local/writereview?placeid=${data.placeId}`;

  useEffect(() => {
    if (data.note) {
      navigator.clipboard.writeText(data.note).then(() => setCopied(true)).catch(() => {});
    }
  }, [data.note]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onDismiss}>
      <div
        className="bg-white dark:bg-stone-900 rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 border border-stone-200 dark:border-stone-700"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1">Leave a Google Review?</h2>
        <p className="text-sm text-stone-500 mb-1">
          {data.note
            ? "Your review text has been copied to your clipboard — paste it into Google."
            : `Share your experience at ${data.name} on Google.`}
        </p>
        {copied && (
          <p className="text-xs text-green-600 dark:text-green-400 mb-3">✓ Review copied to clipboard</p>
        )}
        {!copied && data.note && (
          <p className="text-xs text-stone-400 mb-3">Copying to clipboard…</p>
        )}
        <div className="flex flex-col gap-2 mt-4">
          <a
            href={reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 text-center font-medium"
          >
            Leave a Google Review ↗
          </a>
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300"
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
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
