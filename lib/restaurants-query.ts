import type { Restaurant } from "@/lib/types";

/**
 * Supabase select string for restaurants that embeds the cuisines join table.
 * Use with `.select(RESTAURANT_SELECT)` and then pass each row through
 * `mapRestaurantRow` to flatten cuisines into a `string[]` on the result.
 */
export const RESTAURANT_SELECT = "*, restaurant_cuisines(cuisine_name)";

type RawRow = Omit<Restaurant, "cuisines"> & {
  restaurant_cuisines?: { cuisine_name: string }[] | null;
};

export function mapRestaurantRow(row: unknown): Restaurant {
  const r = row as RawRow;
  const { restaurant_cuisines, ...rest } = r;
  const cuisines = (restaurant_cuisines ?? [])
    .map((rc) => rc.cuisine_name)
    .sort((a, b) => a.localeCompare(b));
  return { ...rest, cuisines };
}

/**
 * Manual overrides for Google Maps place types that don't lexically match a
 * canonical cuisine but should still map to one. Keys are lowercased,
 * underscore-stripped signals (matching how `matchCuisineFromGoogleType`
 * normalizes its inputs); values are canonical cuisine names.
 *
 * Add an entry here when you spot a Google type that the fuzzy matcher
 * misses but obviously belongs under an existing cuisine.
 */
export const GOOGLE_TYPE_CUISINE_ALIASES: Record<string, string> = {
  "coffee shop": "Cafe",
};

/**
 * Fuzzy-match a Google Maps place type against a cuisine list. Tries both the
 * human-readable display name (e.g. "Sushi Restaurant") and the raw enum
 * (e.g. "sushi_restaurant") in this order:
 *   0 — manual alias hit from GOOGLE_TYPE_CUISINE_ALIASES (highest priority)
 *   3 — cuisine exactly equals the signal
 *   2 — cuisine appears inside the signal
 *   1 — signal appears inside the cuisine
 * The best-scoring cuisine wins; ties resolve to the first cuisine encountered.
 * Returns null when no signal produces any overlap.
 */
export function matchCuisineFromGoogleType(
  googleType: string | undefined | null,
  googleTypeRaw: string | undefined | null,
  cuisineList: string[],
): string | null {
  const signals = [
    googleType?.toLowerCase(),
    googleTypeRaw?.toLowerCase().replace(/_/g, " "),
  ].filter((s): s is string => Boolean(s));
  if (signals.length === 0) return null;

  // Manual aliases run first and short-circuit. They only apply when the
  // aliased cuisine is actually in the caller's list.
  for (const signal of signals) {
    const aliased = GOOGLE_TYPE_CUISINE_ALIASES[signal];
    if (aliased && cuisineList.includes(aliased)) return aliased;
  }

  const score = (cuisine: string, signal: string): number => {
    const c = cuisine.toLowerCase();
    if (c === signal) return 3;
    if (signal.includes(c)) return 2;
    if (c.includes(signal)) return 1;
    return 0;
  };

  let best: string | null = null;
  let bestScore = 0;
  for (const cuisine of cuisineList) {
    for (const signal of signals) {
      const s = score(cuisine, signal);
      if (s > bestScore) {
        bestScore = s;
        best = cuisine;
      }
    }
  }
  return best;
}
