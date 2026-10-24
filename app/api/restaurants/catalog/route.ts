import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { RESTAURANT_SELECT, mapRestaurantRow } from "@/lib/restaurants-query";

export const dynamic = "force-dynamic";

const CACHE_TTL_DAYS = 30;

const RECEIPT_DETAIL_SELECT =
  "id, restaurant_id, visited_on, subtotal, tax, tip, total, created_at, parse_model, parsed_merchant, restaurant:restaurants(id, name, city, food), items:receipt_items(id, name, price, qty, position, assignments:receipt_item_diners(diner_id, share, diner:diners(name)))";

/**
 * Public read-only catalog endpoint for the iPhone app when running without
 * local `EXPO_PUBLIC_SUPABASE_URL` environment variables (e.g. Cloudtop Expo Go
 * tunnel or zero-config Mac builds).
 *
 * Supported query parameters:
 * - `?restaurantId=<id>`: Returns `{ restaurant, visits, receipts }` for a single restaurant.
 * - `?cacheKey=<city|cuisine|category>`: Returns `{ results }` from `places_suggestion_cache` if within the 30-day TTL.
 * - `?receiptsOnly=1&limit=<n>`: Returns `{ recentReceipts, diners }`.
 * - Default (`GET /api/restaurants/catalog?limit=<n>`): Returns `{ restaurants, cuisines, diners, recentReceipts }`.
 *
 * @param req - Incoming HTTP GET request.
 * @returns JSON response matching the requested catalog or detail payload.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const supabase = getSupabase();

  const restaurantIdParam = searchParams.get("restaurantId");
  if (restaurantIdParam !== null) {
    const restaurantId = Number(restaurantIdParam);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return NextResponse.json({ error: "Invalid restaurantId" }, { status: 400 });
    }

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
      return NextResponse.json(
        { error: restRes.error?.message ?? `Restaurant #${restaurantId} not found` },
        { status: 404 },
      );
    }
    if (visitsRes.error) {
      return NextResponse.json({ error: visitsRes.error.message }, { status: 500 });
    }
    if (receiptsRes.error) {
      return NextResponse.json({ error: receiptsRes.error.message }, { status: 500 });
    }

    return NextResponse.json({
      restaurant: mapRestaurantRow(restRes.data),
      visits: visitsRes.data ?? [],
      receipts: receiptsRes.data ?? [],
    });
  }

  const cacheKeyParam = searchParams.get("cacheKey");
  if (cacheKeyParam !== null) {
    const normalizedKey = cacheKeyParam.trim().toLowerCase();
    const { data, error } = await supabase
      .from("places_suggestion_cache")
      .select("results, cached_at")
      .eq("cache_key", normalizedKey)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ results: null });
    }
    const ageMs = Date.now() - new Date(data.cached_at).getTime();
    if (ageMs >= CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
      return NextResponse.json({ results: null });
    }
    return NextResponse.json({ results: data.results ?? null });
  }

  const rawLimit = Number(searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

  if (searchParams.get("receiptsOnly") === "1") {
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
      return NextResponse.json({ error: receiptsRes.error.message }, { status: 500 });
    }
    if (dinersRes.error) {
      return NextResponse.json({ error: dinersRes.error.message }, { status: 500 });
    }

    return NextResponse.json({
      recentReceipts: receiptsRes.data ?? [],
      diners: dinersRes.data ?? [],
    });
  }

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
      .limit(limit),
  ]);

  if (restaurantsRes.error) {
    return NextResponse.json({ error: restaurantsRes.error.message }, { status: 500 });
  }
  if (cuisinesRes.error) {
    return NextResponse.json({ error: cuisinesRes.error.message }, { status: 500 });
  }
  if (dinersRes.error) {
    return NextResponse.json({ error: dinersRes.error.message }, { status: 500 });
  }
  if (receiptsRes.error) {
    return NextResponse.json({ error: receiptsRes.error.message }, { status: 500 });
  }

  return NextResponse.json({
    restaurants: (restaurantsRes.data ?? []).map(mapRestaurantRow),
    cuisines: cuisinesRes.data ?? [],
    diners: dinersRes.data ?? [],
    recentReceipts: receiptsRes.data ?? [],
  });
}
