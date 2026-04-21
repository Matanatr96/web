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
