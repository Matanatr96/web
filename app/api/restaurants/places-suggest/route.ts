import { NextResponse } from "next/server";
import { getServiceClient, getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_DAYS = 30;
const MIN_RATING = 4.0;
const MIN_REVIEW_COUNT = 50;
const BAYESIAN_PRIOR_WEIGHT = 50;
const BAYESIAN_PRIOR_MEAN = 4.0;
const MAX_RESULTS = 10;
const LOCATION_BIAS_RADIUS_M = 5000;

export type PlacesSuggestion = {
  place_id: string;
  name: string;
  rating: number;
  user_rating_count: number;
  lat: number | null;
  lng: number | null;
  maps_url: string;
};

type PlacesV1Place = {
  id: string;
  displayName?: { text: string };
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  servesVegetarianFood?: boolean;
  location?: { latitude: number; longitude: number };
  googleMapsUri?: string;
};

function bayesianScore(rating: number, reviewCount: number): number {
  const v = reviewCount;
  const m = BAYESIAN_PRIOR_WEIGHT;
  return (v / (v + m)) * rating + (m / (v + m)) * BAYESIAN_PRIOR_MEAN;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const city = typeof body?.city === "string" ? body.city.trim() : "";
  const cuisine = typeof body?.cuisine === "string" ? body.cuisine.trim() : "";
  const category = typeof body?.category === "string" ? body.category.trim() : "";

  if (!city || !cuisine || !category) {
    return NextResponse.json({ error: "Missing city, cuisine, or category" }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Places API not configured" }, { status: 500 });
  }

  const cacheKey = `${city}|${cuisine}|${category}`.toLowerCase();
  const service = getServiceClient();

  const { data: cached } = await service
    .from("places_suggestion_cache")
    .select("results, cached_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (cached) {
    const ageMs = Date.now() - new Date(cached.cached_at).getTime();
    if (ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
      return NextResponse.json({ results: cached.results as PlacesSuggestion[], cached: true });
    }
  }

  // Compute city centroid from existing rated restaurants for location bias.
  const { data: cityRows } = await getSupabase()
    .from("restaurants")
    .select("lat, lng, place_id")
    .eq("city", city);

  const coords = (cityRows ?? []).filter(
    (r): r is { lat: number; lng: number; place_id: string | null } =>
      r.lat !== null && r.lng !== null,
  );
  const existingPlaceIds = new Set(
    (cityRows ?? []).map((r) => r.place_id).filter((p): p is string => Boolean(p)),
  );

  const centroid = coords.length
    ? {
        latitude: coords.reduce((s, r) => s + r.lat, 0) / coords.length,
        longitude: coords.reduce((s, r) => s + r.lng, 0) / coords.length,
      }
    : null;

  const query = `vegan ${cuisine} ${category} in ${city}`;

  type TextSearchRequest = {
    textQuery: string;
    pageSize: number;
    locationBias?: {
      circle: { center: { latitude: number; longitude: number }; radius: number };
    };
  };

  const requestBody: TextSearchRequest = {
    textQuery: query,
    pageSize: 20,
  };
  if (centroid) {
    requestBody.locationBias = {
      circle: { center: centroid, radius: LOCATION_BIAS_RADIUS_M },
    };
  }

  const fields = [
    "places.id",
    "places.displayName",
    "places.rating",
    "places.userRatingCount",
    "places.businessStatus",
    "places.servesVegetarianFood",
    "places.location",
    "places.googleMapsUri",
  ].join(",");

  const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fields,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return NextResponse.json(
      { error: `Places API error: ${resp.status} ${text}` },
      { status: 502 },
    );
  }

  const payload = (await resp.json()) as { places?: PlacesV1Place[] };
  const places = payload.places ?? [];

  const filtered: PlacesSuggestion[] = places
    .filter(
      (p) =>
        typeof p.rating === "number" &&
        p.rating >= MIN_RATING &&
        typeof p.userRatingCount === "number" &&
        p.userRatingCount >= MIN_REVIEW_COUNT &&
        p.businessStatus === "OPERATIONAL" &&
        p.servesVegetarianFood === true &&
        !existingPlaceIds.has(p.id),
    )
    .map((p) => ({
      place_id: p.id,
      name: p.displayName?.text ?? "(unnamed)",
      rating: p.rating as number,
      user_rating_count: p.userRatingCount as number,
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      maps_url:
        p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    }))
    .sort(
      (a, b) =>
        bayesianScore(b.rating, b.user_rating_count) -
        bayesianScore(a.rating, a.user_rating_count),
    )
    .slice(0, MAX_RESULTS);

  await service
    .from("places_suggestion_cache")
    .upsert({ cache_key: cacheKey, results: filtered, cached_at: new Date().toISOString() });

  return NextResponse.json({ results: filtered, cached: false });
}
