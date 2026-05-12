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
