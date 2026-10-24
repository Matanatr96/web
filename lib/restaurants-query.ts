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
  "tea house": "Cafe",
  "greek restaurant": "Mediterranean",
  "pakistani restaurant": "Indian",
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

export type AdminStatusFilter = "" | "unrated" | "rated" | "missing_coords" | "missing_cuisine";
export type AdminSortKey = "name" | "city" | "cuisines" | "category" | "overall" | "last_visited";
export type SortDir = "asc" | "desc";

export type AdminRestaurantFilterParams = {
  query?: string;
  city?: string;
  cuisine?: string;
  category?: string;
  status?: AdminStatusFilter;
  sortKey?: AdminSortKey;
  sortDir?: SortDir;
};

/**
 * Filter and sort restaurants for the `/admin/restaurants` management table.
 *
 * @param restaurants - Full list of restaurant records.
 * @param params - Search query, city/cuisine/category/status filters, and sort column/direction.
 * @returns Filtered and sorted array of restaurants.
 */
export function filterAdminRestaurants(
  restaurants: Restaurant[],
  params: AdminRestaurantFilterParams,
): Restaurant[] {
  const q = (params.query ?? "").trim().toLowerCase();
  const city = params.city ?? "";
  const cuisine = params.cuisine ?? "";
  const category = params.category ?? "";
  const status = params.status ?? "";
  const sortKey = params.sortKey ?? "overall";
  const sortDir = params.sortDir ?? "desc";

  const list = restaurants.filter((r) => {
    if (q) {
      const haystack = [r.name, r.city, r.category, ...r.cuisines]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (city && r.city !== city) return false;
    if (cuisine && !r.cuisines.includes(cuisine)) return false;
    if (category && r.category !== category) return false;
    if (status === "unrated" && r.food !== null) return false;
    if (status === "rated" && r.food === null) return false;
    if (status === "missing_coords" && r.lat !== null && r.lng !== null) return false;
    if (status === "missing_cuisine" && r.cuisines.length > 0) return false;
    return true;
  });

  const dir = sortDir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    const av = sortKey === "cuisines" ? (a.cuisines[0] ?? "") : a[sortKey];
    const bv = sortKey === "cuisines" ? (b.cuisines[0] ?? "") : b[sortKey];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });

  return list;
}

/**
 * Determine whether a restaurant has been rated (as opposed to an unrated
 * "Want to Go" bookmark stub where `food` is null and `overall` is 0).
 *
 * @param r - Restaurant record (or object containing the `food` rating field).
 * @returns True when `food` is non-null, false for unrated bookmarks.
 */
export function isRatedRestaurant(r: Pick<Restaurant, "food">): boolean {
  return r.food !== null && r.food !== undefined;
}

/**
 * Partition a restaurant list into rated favorites (`food !== null`) and
 * unrated "Want to Go" bookmarks (`food === null`).
 *
 * @param restaurants - Full list of restaurant records.
 * @returns Object containing `rated` and `wantToGo` arrays preserving input order.
 */
export function partitionRestaurants(restaurants: Restaurant[]): {
  rated: Restaurant[];
  wantToGo: Restaurant[];
} {
  const rated: Restaurant[] = [];
  const wantToGo: Restaurant[] = [];
  for (const r of restaurants) {
    if (isRatedRestaurant(r)) {
      rated.push(r);
    } else {
      wantToGo.push(r);
    }
  }
  return { rated, wantToGo };
}

/**
 * Deterministically sample up to `count` items from `items` using a numeric
 * `seed` so UI reshuffle actions produce a repeatable pseudo-random subset.
 *
 * @param items - Source array of items to sample from.
 * @param count - Maximum number of items to return.
 * @param seed - Non-negative integer shuffle seed.
 * @returns Sampled array of at most `count` items.
 */
export function pickRandom<T>(items: T[], count: number, seed: number): T[] {
  if (items.length <= count) return [...items];
  const indexed = items.map((item, i) => ({
    item,
    key: Math.sin((i + 1) * (seed + 1) * 9301) * 233280,
  }));
  indexed.sort((a, b) => a.key - b.key);
  return indexed.slice(0, count).map((x) => x.item);
}

export type SuggestPersonalOptions = {
  city?: string;
  category?: string;
  cuisine?: string;
  mode?: "rated" | "want_to_go";
  maxResults?: number;
};

/**
 * Filter and rank personal restaurants for the Suggestions / Decide flow.
 * Explicitly separates rated favorites (`r.food !== null`) from unrated
 * "Want to Go" bookmarks (`r.food === null`) so unrated 0.00 rows never leak
 * into rated picks.
 *
 * @param restaurants - Full list of restaurant records.
 * @param opts - Optional city, category, cuisine, mode ("rated" | "want_to_go"), and maxResults cap.
 * @returns Ranked matching restaurants sorted by `overall` descending (then name ascending).
 */
export function suggestPersonalRestaurants(
  restaurants: Restaurant[],
  opts: SuggestPersonalOptions = {},
): Restaurant[] {
  const mode = opts.mode ?? "rated";
  const city = opts.city?.trim() ?? "";
  const category = opts.category?.trim() ?? "";
  const cuisine = opts.cuisine?.trim() ?? "";

  const filtered = restaurants.filter((r) => {
    if (mode === "rated" && !isRatedRestaurant(r)) return false;
    if (mode === "want_to_go" && isRatedRestaurant(r)) return false;
    if (city && r.city !== city) return false;
    if (category && r.category !== category) return false;
    if (cuisine && !r.cuisines.includes(cuisine)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (b.overall !== a.overall) return b.overall - a.overall;
    return a.name.localeCompare(b.name);
  });

  if (typeof opts.maxResults === "number" && opts.maxResults > 0) {
    return filtered.slice(0, opts.maxResults);
  }
  return filtered;
}

/**
 * Compute a Bayesian-weighted average rating to rank Google Places discovery
 * results by balancing star rating against review volume.
 *
 * @param rating - Observed average rating (e.g. 0.0 to 5.0).
 * @param reviewCount - Total number of user reviews `v`.
 * @param priorWeight - Prior pseudo-count weight `m` (defaults to 50).
 * @param priorMean - Prior mean rating `C` (defaults to 4.0).
 * @returns Bayesian-adjusted score.
 */
export function bayesianScore(
  rating: number,
  reviewCount: number,
  priorWeight: number = 50,
  priorMean: number = 4.0,
): number {
  const v = reviewCount;
  const m = priorWeight;
  if (v + m <= 0) return 0;
  return (v / (v + m)) * rating + (m / (v + m)) * priorMean;
}


