import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Restaurant, RestaurantVisit } from "@web-lib/types";
import type { Diner } from "@web-lib/receipts";
import type { ReceiptRow } from "@web-lib/restaurant-receipts";
import { RESTAURANT_SELECT, mapRestaurantRow } from "@web-lib/restaurants-query";

const CACHE_TTL_DAYS = 30;

export type CuisineRow = {
  id: number;
  name: string;
};

export type MobileReceiptRow = ReceiptRow & {
  restaurant_id: number | null;
  parse_model: string | null;
  parsed_merchant: string | null;
  restaurant: {
    id: number;
    name: string;
    city: string | null;
    food: number | null;
  } | null;
};

export type PlacesSuggestionItem = {
  place_id: string;
  name: string;
  rating: number;
  user_rating_count: number;
  lat: number | null;
  lng: number | null;
  maps_url: string;
};

export type CatalogPayload = {
  restaurants: Restaurant[];
  cuisines: CuisineRow[];
  diners: Diner[];
  recentReceipts: MobileReceiptRow[];
};

export type RestaurantDetailPayload = {
  restaurant: Restaurant;
  visits: RestaurantVisit[];
  receipts: MobileReceiptRow[];
};

const RECEIPT_DETAIL_SELECT =
  "id, restaurant_id, visited_on, subtotal, tax, tip, total, created_at, parse_model, parsed_merchant, restaurant:restaurants(id, name, city, food), items:receipt_items(id, name, price, qty, position, assignments:receipt_item_diners(diner_id, share, diner:diners(name)))";

let _client: SupabaseClient | null = null;

/**
 * Return the singleton anonymous Supabase client for the iPhone app.
 * Uses the public publishable key and relies on existing Row Level Security
 * (`FOR SELECT USING (true)`) for fast direct-to-PostgREST reads.
 *
 * @returns Initialized `SupabaseClient` instance.
 */
export function getMobileSupabase(): SupabaseClient {
  if (_client) return _client;
  const url =
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "https://placeholder.supabase.co";
  const anonKey =
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    "sb_publishable_placeholder";

  _client = createClient(url, anonKey, {
    auth: { persistSession: false },
  });
  return _client;
}

/**
 * Fetch the complete restaurant catalog, canonical cuisines, saved diners,
 * and recent split receipts in parallel directly from Supabase.
 *
 * @param receiptLimit - Max number of recent receipts to load (defaults to 50).
 * @returns Hydrated `CatalogPayload`.
 */
export async function fetchCatalog(receiptLimit: number = 50): Promise<CatalogPayload> {
  const supabase = getMobileSupabase();

  const [restaurantsRes, cuisinesRes, dinersRes, receiptsRes] = await Promise.all([
    supabase
      .from("restaurants")
      .select(RESTAURANT_SELECT)
      .order("overall", { ascending: false }),
    supabase.from("cuisines").select("id, name").order("name"),
    supabase
      .from("diners")
      .select("id, name, is_self, last_used_at")
      .order("is_self", { ascending: false })
      .order("last_used_at", { ascending: false }),
    supabase
      .from("receipts")
      .select(RECEIPT_DETAIL_SELECT)
      .order("visited_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(receiptLimit),
  ]);

  if (restaurantsRes.error) {
    throw new Error(`Failed to fetch restaurants: ${restaurantsRes.error.message}`);
  }
  if (cuisinesRes.error) {
    throw new Error(`Failed to fetch cuisines: ${cuisinesRes.error.message}`);
  }
  if (dinersRes.error) {
    throw new Error(`Failed to fetch diners: ${dinersRes.error.message}`);
  }
  if (receiptsRes.error) {
    throw new Error(`Failed to fetch receipts: ${receiptsRes.error.message}`);
  }

  return {
    restaurants: (restaurantsRes.data ?? []).map(mapRestaurantRow),
    cuisines: (cuisinesRes.data ?? []) as CuisineRow[],
    diners: (dinersRes.data ?? []) as Diner[],
    recentReceipts: (receiptsRes.data ?? []) as unknown as MobileReceiptRow[],
  };
}

/**
 * Fetch the full dossier for a single restaurant: its row with cuisines,
 * chronological visit history (`restaurant_visits`), and linked itemized
 * receipts (`receipts` + `receipt_items` + `receipt_item_diners`).
 *
 * @param restaurantId - Restaurant primary key.
 * @returns `RestaurantDetailPayload`.
 */
export async function fetchRestaurantDetail(
  restaurantId: number,
): Promise<RestaurantDetailPayload> {
  const supabase = getMobileSupabase();

  const [restRes, visitsRes, receiptsRes] = await Promise.all([
    supabase
      .from("restaurants")
      .select(RESTAURANT_SELECT)
      .eq("id", restaurantId)
      .single(),
    supabase
      .from("restaurant_visits")
      .select(
        "id, restaurant_id, visited_on, comment, food, value, service, ambiance, vegan_options, overall, created_at",
      )
      .eq("restaurant_id", restaurantId)
      .order("visited_on", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("receipts")
      .select(RECEIPT_DETAIL_SELECT)
      .eq("restaurant_id", restaurantId)
      .order("visited_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
  ]);

  if (restRes.error || !restRes.data) {
    throw new Error(restRes.error?.message ?? `Restaurant #${restaurantId} not found`);
  }
  if (visitsRes.error) {
    throw new Error(`Failed to load visits: ${visitsRes.error.message}`);
  }
  if (receiptsRes.error) {
    throw new Error(`Failed to load receipts: ${receiptsRes.error.message}`);
  }

  return {
    restaurant: mapRestaurantRow(restRes.data),
    visits: (visitsRes.data ?? []) as RestaurantVisit[],
    receipts: (receiptsRes.data ?? []) as unknown as MobileReceiptRow[],
  };
}

/**
 * Fetch recent receipts and saved diners directly from Supabase.
 *
 * @param limit - Maximum number of receipts to fetch (defaults to 50).
 * @returns Object containing `recentReceipts` and `diners`.
 */
export async function fetchReceiptsAndDiners(limit: number = 50): Promise<{
  recentReceipts: MobileReceiptRow[];
  diners: Diner[];
}> {
  const supabase = getMobileSupabase();
  const [receiptsRes, dinersRes] = await Promise.all([
    supabase
      .from("receipts")
      .select(RECEIPT_DETAIL_SELECT)
      .order("visited_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("diners")
      .select("id, name, is_self, last_used_at")
      .order("is_self", { ascending: false })
      .order("last_used_at", { ascending: false }),
  ]);

  if (receiptsRes.error) {
    throw new Error(`Failed to fetch receipts: ${receiptsRes.error.message}`);
  }
  if (dinersRes.error) {
    throw new Error(`Failed to fetch diners: ${dinersRes.error.message}`);
  }

  return {
    recentReceipts: (receiptsRes.data ?? []) as unknown as MobileReceiptRow[],
    diners: (dinersRes.data ?? []) as Diner[],
  };
}

/**
 * Check `places_suggestion_cache` directly in Supabase for a cached
 * `(city|cuisine|category)` untried places list within the 30-day TTL.
 *
 * @param cacheKey - Lowercase `${city}|${cuisine}|${category}` key.
 * @returns Cached `PlacesSuggestionItem[]` on a valid hit, or `null` on miss/expiry.
 */
export async function fetchPlacesCache(
  cacheKey: string,
): Promise<PlacesSuggestionItem[] | null> {
  const supabase = getMobileSupabase();
  const normalizedKey = cacheKey.trim().toLowerCase();
  const { data, error } = await supabase
    .from("places_suggestion_cache")
    .select("results, cached_at")
    .eq("cache_key", normalizedKey)
    .maybeSingle();

  if (error || !data) return null;
  const ageMs = Date.now() - new Date(data.cached_at).getTime();
  if (ageMs >= CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
    return null;
  }
  return (data.results as PlacesSuggestionItem[]) ?? null;
}
