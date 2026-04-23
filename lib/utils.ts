/**
 * URL-safe slug from a string. Used for city/cuisine URL segments.
 * "San Francisco" -> "san-francisco"
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Format a rating for display. Returns "—" for null/undefined.
 */
export function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(digits);
}

/**
 * Tailwind color class based on a 0-10 rating.
 * Used to color-code cells in the ratings table.
 */
export function ratingColorClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return "text-stone-400";
  if (n >= 9) return "text-emerald-600 font-semibold";
  if (n >= 8) return "text-emerald-500";
  if (n >= 7) return "text-lime-600";
  if (n >= 6) return "text-amber-600";
  if (n >= 5) return "text-orange-600";
  return "text-red-600";
}

/**
 * Tailwind color class based on how recently a restaurant was visited.
 * Accepts an ISO date string (YYYY-MM-DD) or null.
 */
export function lastVisitedColorClass(lastVisited: string | null | undefined): string {
  if (!lastVisited) return "text-stone-400";
  const ageMs = Date.now() - new Date(lastVisited + "T00:00:00").getTime();
  const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears < 1) return "text-emerald-600";
  if (ageYears < 3) return "text-amber-600";
  return "text-red-600";
}

/**
 * Rating weights per category. Each key maps to the weight used when
 * computing the overall score. The overall is a weighted average:
 *   overall = sum(score_i * weight_i) / sum(weight_i)
 *
 * All categories currently share the same weights — edit individual
 * entries here to differentiate them later.
 */
export const RATING_WEIGHTS: Record<string, {
  food: number;
  value: number;
  service: number;
  ambiance: number;
  vegan_options: number;
}> = {
  Food: { food: 8, value: 0.1, service: 0.1, ambiance: 0.2, vegan_options: 0.5 },
  Drink: { food: 8, value: 0.1, service: 0.1, ambiance: 0.2, vegan_options: 0.5 },
  Dessert: { food: 8, value: 0.1, service: 0.1, ambiance: 0.2, vegan_options: 0.5 },
};

/**
 * Compute the weighted overall rating from sub-ratings and a category.
 * Returns null if any required sub-rating is missing.
 */
export function computeOverall(
  category: string,
  scores: {
    food: number | null;
    value: number | null;
    service: number | null;
    ambiance: number | null;
    vegan_options: number | null;
  }
): number | null {
  const weights = RATING_WEIGHTS[category];
  if (!weights) return null;

  const { food, value, service, ambiance, vegan_options } = scores;
  if (
    food === null || value === null || service === null ||
    ambiance === null || vegan_options === null
  ) {
    return null;
  }

  const totalWeight =
    weights.food + weights.value + weights.service +
    weights.ambiance + weights.vegan_options;

  const weighted =
    food * weights.food +
    value * weights.value +
    service * weights.service +
    ambiance * weights.ambiance +
    vegan_options * weights.vegan_options;

  return Math.round((weighted / totalWeight) * 100) / 100;
}

/**
 * Predefined cuisine options for the picker.
 * Derived from existing data — add new entries as needed.
 */
export const CUISINES = [
  "American",
  "Arabic",
  "Asian",
  "Bagel",
  "Bakery",
  "Bangladeshi",
  "Bowl",
  "Breakfast",
  "Brunch",
  "Burger",
  "Burmese",
  "Cafe",
  "Chinese",
  "Donut",
  "Ice Cream",
  "Indian",
  "Indian Street",
  "Israeli",
  "Italian",
  "Japanese",
  "Korean",
  "Latin",
  "Malaysian",
  "Mediterranean",
  "Mexican",
  "Nepalese",
  "Pho",
  "Pizza",
  "Sandwich",
  "Sushi",
  "Szechuan",
  "Taco",
  "Taiwanese",
  "Thai",
  "Tulum",
  "Venezuelan",
  "Vietnamese",
  "Wings",
];
