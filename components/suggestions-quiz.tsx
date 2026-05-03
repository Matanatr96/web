"use client";

import { useMemo, useState } from "react";
import type { Restaurant } from "@/lib/types";

type Step = "city" | "cuisine" | "category" | "results";

const CATEGORIES = ["Food", "Drink", "Dessert"] as const;
type Category = (typeof CATEGORIES)[number];

const MAX_OPTIONS = 3;
const MAX_RESULTS = 4;

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
  const [cityShuffle, setCityShuffle] = useState(0);
  const [cuisineShuffle, setCuisineShuffle] = useState(0);

  const allCities = useMemo(() => {
    return Array.from(new Set(restaurants.map((r) => r.city))).sort();
  }, [restaurants]);

  const cityOptions = useMemo(
    () => pickRandom(allCities, MAX_OPTIONS, cityShuffle),
    [allCities, cityShuffle]
  );

  const cuisinesInCity = useMemo(() => {
    if (!city) return [];
    return Array.from(
      new Set(restaurants.filter((r) => r.city === city).map((r) => r.cuisine))
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
        .filter((r) => r.city === city && r.cuisine === cuisine)
        .map((r) => r.category)
    );
    return CATEGORIES.filter((c) => set.has(c));
  }, [restaurants, city, cuisine]);

  const results = useMemo(() => {
    if (!city || !cuisine || !category) return [];
    return restaurants
      .filter(
        (r) => r.city === city && r.cuisine === cuisine && r.category === category
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

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-6">
      <Stepper current={step} />

      {step === "city" && (
        <Question
          title="Where are you?"
          subtitle={
            allCities.length > MAX_OPTIONS
              ? "Pick a city, or reshuffle for different options."
              : "Pick a city."
          }
          options={cityOptions}
          onPick={(c) => {
            setCity(c);
            setCuisineShuffle(0);
            setStep("cuisine");
          }}
          onReshuffle={
            allCities.length > MAX_OPTIONS
              ? () => setCityShuffle((s) => s + 1)
              : undefined
          }
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

function Stepper({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "city", label: "City" },
    { key: "cuisine", label: "Cuisine" },
    { key: "category", label: "Type" },
    { key: "results", label: "Picks" },
  ];
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <div className="flex items-center gap-2 text-xs text-stone-500 mb-6">
      {steps.map((s, i) => (
        <span key={s.key} className="flex items-center gap-2">
          <span
            className={
              i <= idx
                ? "font-semibold text-stone-900 dark:text-stone-100"
                : ""
            }
          >
            {s.label}
          </span>
          {i < steps.length - 1 && <span>›</span>}
        </span>
      ))}
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
  if (restaurants.length === 0) {
    return <NoMatch onBack={onBack} onReset={onReset} />;
  }

  return (
    <div>
      <h2 className="text-xl font-semibold">
        {category} · {cuisine} · {city}
      </h2>
      <p className="text-sm text-stone-500 mt-1">
        {restaurants.length} {restaurants.length === 1 ? "pick" : "picks"} for you.
      </p>

      <ul className="mt-5 space-y-3">
        {restaurants.map((r) => (
          <li
            key={r.id}
            className="rounded-lg border border-stone-200 dark:border-stone-800 p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="font-semibold">{r.name}</div>
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
