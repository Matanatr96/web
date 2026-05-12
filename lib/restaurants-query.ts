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
 * Fuzzy-match a Google Maps place type against a cuisine list. Tries both the
 * human-readable display name (e.g. "Sushi Restaurant") and the raw enum
 * (e.g. "sushi_restaurant"), and tiers matches by quality:
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
