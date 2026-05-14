"use client";

import { useMemo, useState } from "react";
import type { Restaurant } from "@/lib/types";

type Step = "city" | "cuisine" | "category" | "results";

const CATEGORIES = ["Food", "Drink", "Dessert"] as const;
type Category = (typeof CATEGORIES)[number];

const MAX_OPTIONS = 3;
const MAX_RESULTS = 4;

type PlacesSuggestion = {
  place_id: string;
  name: string;
  rating: number;
  user_rating_count: number;
  lat: number | null;
  lng: number | null;
  maps_url: string;
};

function pickRandom<T>(items: T[], count: number, seed: number): T[] {
  if (items.length <= count) return [...items];
  // Deterministic-ish shuffle keyed by seed so reshuffle re-renders give a new pick.
  const indexed = items.map((item, i) => ({
    item,
    key: Math.sin((i + 1) * (seed + 1) * 9301) * 233280,
  }));
  indexed.sort((a, b) => a.key - b.key);
  return indexed.slice(0, count).map((x) => x.item);
}

export default function SuggestionsQuiz({ restaurants }: { restaurants: Restaurant[] }) {
  const [step, setStep] = useState<Step>("city");
  const [city, setCity] = useState<string | null>(null);
  const [cuisine, setCuisine] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [cuisineShuffle, setCuisineShuffle] = useState(0);

  const allCities = useMemo(() => {
    return Array.from(new Set(restaurants.map((r) => r.city))).sort();
  }, [restaurants]);

  const cuisinesInCity = useMemo(() => {
    if (!city) return [];
    return Array.from(
      new Set(
        restaurants.filter((r) => r.city === city).flatMap((r) => r.cuisines),
      ),
    ).sort();
  }, [restaurants, city]);

  const cuisineOptions = useMemo(
    () => pickRandom(cuisinesInCity, MAX_OPTIONS, cuisineShuffle),
    [cuisinesInCity, cuisineShuffle]
  );

  const categoriesAvailable = useMemo(() => {
    if (!city || !cuisine) return [];
    const set = new Set(
      restaurants
        .filter((r) => r.city === city && r.cuisines.includes(cuisine))
        .map((r) => r.category),
    );
    return CATEGORIES.filter((c) => set.has(c));
  }, [restaurants, city, cuisine]);

  const results = useMemo(() => {
    if (!city || !cuisine || !category) return [];
    return restaurants
      .filter(
        (r) =>
          r.city === city &&
          r.cuisines.includes(cuisine) &&
          r.category === category,
      )
      .sort((a, b) => b.overall - a.overall)
      .slice(0, MAX_RESULTS);
  }, [restaurants, city, cuisine, category]);

  function reset() {
    setStep("city");
    setCity(null);
    setCuisine(null);
    setCategory(null);
  }

  function back() {
    if (step === "cuisine") {
      setCuisine(null);
      setStep("city");
    } else if (step === "category") {
      setCategory(null);
      setStep("cuisine");
    } else if (step === "results") {
      setStep("category");
    }
  }

  function jumpTo(target: Step) {
    if (target === "city") {
      setCuisine(null);
      setCategory(null);
      setStep("city");
    } else if (target === "cuisine" && city) {
      setCategory(null);
      setStep("cuisine");
    } else if (target === "category" && city && cuisine) {
      setStep("category");
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-6">
      <Stepper
        current={step}
        completed={{
          city: city !== null,
          cuisine: cuisine !== null,
          category: category !== null,
        }}
        onJump={jumpTo}
      />

      {step === "city" && (
        <CityPicker
          cities={allCities}
          onPick={(c) => {
            setCity(c);
            setCuisineShuffle(0);
            setStep("cuisine");
          }}
        />
      )}

      {step === "cuisine" && (
        <Question
          title="What cuisine are you feeling?"
          subtitle={
            cuisinesInCity.length > MAX_OPTIONS
              ? `Cuisines I've rated in ${city}.`
              : `All cuisines I've rated in ${city}.`
          }
          options={cuisineOptions}
          onPick={(c) => {
            setCuisine(c);
            setStep("category");
          }}
          onReshuffle={
            cuisinesInCity.length > MAX_OPTIONS
              ? () => setCuisineShuffle((s) => s + 1)
              : undefined
          }
          onBack={back}
        />
      )}

      {step === "category" && (
        <>
          {categoriesAvailable.length === 0 ? (
            <NoMatch onBack={back} onReset={reset} />
          ) : (
            <Question
              title="Food, drink, or dessert?"
              options={categoriesAvailable}
              onPick={(c) => {
                setCategory(c as Category);
                setStep("results");
              }}
              onBack={back}
            />
          )}
        </>
      )}

      {step === "results" && (
        <Results
          restaurants={results}
          city={city!}
          cuisine={cuisine!}
          category={category!}
          onBack={back}
          onReset={reset}
        />
      )}
    </div>
  );
}

function Results({
  restaurants,
  city,
  cuisine,
  category,
  onBack,
  onReset,
}: {
  restaurants: Restaurant[];
  city: string;
  cuisine: string;
  category: Category;
  onBack: () => void;
  onReset: () => void;
}) {
  const [includeUntried, setIncludeUntried] = useState(false);
  const [untried, setUntried] = useState<PlacesSuggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onToggle(next: boolean) {
    setIncludeUntried(next);
    if (next && untried === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/restaurants/places-suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ city, cuisine, category }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const data = (await res.json()) as { results: PlacesSuggestion[] };
        setUntried(data.results);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load suggestions");
      } finally {
        setLoading(false);
      }
    }
  }

  if (restaurants.length === 0 && !includeUntried) {
    return <NoMatch onBack={onBack} onReset={onReset} />;
  }

  return (
    <div>
      <h2 className="text-xl font-semibold">
        {category} · {cuisine} · {city}
      </h2>
      <p className="text-sm text-stone-500 mt-1">
        {restaurants.length} {restaurants.length === 1 ? "pick" : "picks"} from
        your ratings.
      </p>

      <label className="mt-4 flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={includeUntried}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4"
        />
        <span>Include places you haven&apos;t tried (vegan-friendly)</span>
      </label>

      {restaurants.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-stone-500">
            My picks
          </h3>
          <ul className="mt-3 space-y-3">
            {restaurants.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-stone-200 dark:border-stone-800 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="font-semibold">
                    {r.place_id || (r.lat && r.lng) ? (
                      <a
                        href={
                          r.place_id
                            ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}`
                            : `https://www.google.com/maps?q=${r.lat},${r.lng}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {r.name}
                      </a>
                    ) : (
                      r.name
                    )}
                  </div>
                  <div className="text-sm font-mono tabular-nums">
                    {Number(r.overall).toFixed(2)}
                  </div>
                </div>
                {r.note && (
                  <p className="text-sm text-stone-600 dark:text-stone-400 mt-2">
                    {r.note}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {includeUntried && (
        <>
          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-stone-500">
            New to try
          </h3>
          {loading && (
            <p className="mt-3 text-sm text-stone-500">Searching Google Places…</p>
          )}
          {error && (
            <p className="mt-3 text-sm text-red-600">{error}</p>
          )}
          {!loading && !error && untried && untried.length === 0 && (
            <p className="mt-3 text-sm text-stone-500">
              No untried vegan-friendly places matched. Try a different combo.
            </p>
          )}
          {!loading && !error && untried && untried.length > 0 && (
            <ul className="mt-3 space-y-3">
              {untried.map((p) => (
                <li
                  key={p.place_id}
                  className="rounded-lg border-2 border-dashed border-stone-300 dark:border-stone-700 p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold">
                        <a
                          href={p.maps_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {p.name}
                        </a>
                      </div>
                      <div className="mt-1 inline-block rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5">
                        Untried · Vegan-friendly
                      </div>
                    </div>
                    <div className="text-sm font-mono tabular-nums text-right">
                      <div>{p.rating.toFixed(1)} ★</div>
                      <div className="text-xs text-stone-500">
                        {p.user_rating_count.toLocaleString()} reviews
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="flex gap-3 mt-6 text-sm">
        <button onClick={onBack} className="text-stone-500 hover:underline">
          ← Back
        </button>
        <button onClick={onReset} className="text-stone-500 hover:underline">
          Start over
        </button>
      </div>
    </div>
  );
}

function CityPicker({
  cities,
  onPick,
}: {
  cities: string[];
  onPick: (city: string) => void;
}) {
  const [selected, setSelected] = useState("");
  return (
    <div>
      <h2 className="text-xl font-semibold">Where are you?</h2>
      <p className="text-sm text-stone-500 mt-1">Pick a city to start.</p>

      <div className="mt-5 flex flex-col sm:flex-row gap-3">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="flex-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 px-3 py-2.5"
        >
          <option value="">Select a city…</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          disabled={!selected}
          onClick={() => onPick(selected)}
          className="rounded-lg bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 px-5 py-2.5 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function Stepper({
  current,
  completed,
  onJump,
}: {
  current: Step;
  completed: { city: boolean; cuisine: boolean; category: boolean };
  onJump: (step: Step) => void;
}) {
  const steps: { key: Step; label: string }[] = [
    { key: "city", label: "City" },
    { key: "cuisine", label: "Cuisine" },
    { key: "category", label: "Type" },
    { key: "results", label: "Picks" },
  ];
  const idx = steps.findIndex((s) => s.key === current);

  function canJump(key: Step): boolean {
    if (key === current) return false;
    if (key === "results") return false;
    if (key === "city") return true;
    if (key === "cuisine") return completed.city;
    if (key === "category") return completed.city && completed.cuisine;
    return false;
  }

  return (
    <div className="flex items-center gap-2 text-xs text-stone-500 mb-6">
      {steps.map((s, i) => {
        const active = i <= idx;
        const jumpable = canJump(s.key);
        const labelClass = active
          ? "font-semibold text-stone-900 dark:text-stone-100"
          : "";
        return (
          <span key={s.key} className="flex items-center gap-2">
            {jumpable ? (
              <button
                onClick={() => onJump(s.key)}
                className={`${labelClass} hover:underline`}
              >
                {s.label}
              </button>
            ) : (
              <span className={labelClass}>{s.label}</span>
            )}
            {i < steps.length - 1 && <span>›</span>}
          </span>
        );
      })}
    </div>
  );
}

function Question({
  title,
  subtitle,
  options,
  onPick,
  onReshuffle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  options: string[];
  onPick: (value: string) => void;
  onReshuffle?: () => void;
  onBack?: () => void;
}) {
  return (
    <div>
      <h2 className="text-xl font-semibold">{title}</h2>
      {subtitle && <p className="text-sm text-stone-500 mt-1">{subtitle}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onPick(opt)}
            className="rounded-lg border border-stone-200 dark:border-stone-800 px-4 py-6 text-center font-medium hover:bg-stone-50 dark:hover:bg-stone-900 transition"
          >
            {opt}
          </button>
        ))}
      </div>

      <div className="flex gap-3 mt-6 text-sm">
        {onBack && (
          <button onClick={onBack} className="text-stone-500 hover:underline">
            ← Back
          </button>
        )}
        {onReshuffle && (
          <button
            onClick={onReshuffle}
            className="text-stone-500 hover:underline"
          >
            ↻ Reshuffle
          </button>
        )}
      </div>
    </div>
  );
}

function NoMatch({ onBack, onReset }: { onBack: () => void; onReset: () => void }) {
  return (
    <div>
      <h2 className="text-xl font-semibold">No matches</h2>
      <p className="text-sm text-stone-500 mt-1">
        I haven&apos;t rated anything in that combination. Try different choices.
      </p>
      <div className="flex gap-3 mt-5 text-sm">
        <button onClick={onBack} className="text-stone-500 hover:underline">
          ← Back
        </button>
        <button onClick={onReset} className="text-stone-500 hover:underline">
          Start over
        </button>
      </div>
    </div>
  );
}

