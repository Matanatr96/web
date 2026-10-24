import type { Restaurant } from "@/lib/types";
import { isRatedRestaurant } from "@/lib/restaurants-query";

const EARTH_RADIUS_MILES = 3958.7613;
const EARTH_RADIUS_KM = 6371.0088;

export type VibeMode =
  | "best_overall"
  | "vegan_priority"
  | "best_value"
  | "date_night"
  | "havent_been_lately";

export type VibeOption = {
  key: VibeMode;
  label: string;
  shortLabel: string;
  emoji: string;
  description: string;
};

/**
 * Interactive Vibe Boost presets for the iPhone Decide console.
 * Dynamically re-weights the 5 existing rating dimensions (`food`, `value`,
 * `service`, `ambiance`, `vegan_options`) client-side without schema changes.
 */
export const VIBE_OPTIONS: readonly VibeOption[] = [
  {
    key: "best_overall",
    label: "🍽️ Best Overall",
    shortLabel: "Best Overall",
    emoji: "🍽️",
    description: "Canonical weighted overall score (8.0 Food · 0.5 Vegan · 0.2 Vibe · 0.1 Value · 0.1 Service)",
  },
  {
    key: "vegan_priority",
    label: "🌱 Vegan Priority",
    shortLabel: "Vegan Priority",
    emoji: "🌱",
    description: "Requires Vegan ≥ 8.0 and weights 55% Food + 35% Vegan + 10% Value",
  },
  {
    key: "best_value",
    label: "💸 Best Value / Casual",
    shortLabel: "Best Value",
    emoji: "💸",
    description: "Weights 55% Food + 35% Value + 10% Vegan for high-bang-for-buck spots",
  },
  {
    key: "date_night",
    label: "✨ Date Night / Vibe",
    shortLabel: "Date Night",
    emoji: "✨",
    description: "Weights 50% Food + 30% Ambiance + 15% Service + 5% Vegan",
  },
  {
    key: "havent_been_lately",
    label: "🕰️ Haven't Been Lately",
    shortLabel: "Overdue Favorites",
    emoji: "🕰️",
    description: "Proven favorites (Overall ≥ 8.0) boosted by days since last visit",
  },
];

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute great-circle Haversine distance in kilometers between two WGS84
 * coordinates.
 *
 * @param lat1 - Origin latitude in decimal degrees.
 * @param lng1 - Origin longitude in decimal degrees.
 * @param lat2 - Destination latitude in decimal degrees.
 * @param lng2 - Destination longitude in decimal degrees.
 * @returns Great-circle distance in kilometers.
 */
export function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_KM * c;
}

/**
 * Compute great-circle Haversine distance in statute miles between two WGS84
 * coordinates.
 *
 * @param lat1 - Origin latitude in decimal degrees.
 * @param lng1 - Origin longitude in decimal degrees.
 * @param lat2 - Destination latitude in decimal degrees.
 * @param lng2 - Destination longitude in decimal degrees.
 * @returns Great-circle distance in statute miles.
 */
export function distanceMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_MILES * c;
}

/**
 * Detect the nearest known city from cached restaurant coordinates by computing
 * each city's geographic centroid `(meanLat, meanLng)` and finding the closest
 * centroid within `maxDistanceKm` (defaults to 25 km).
 *
 * @param userLat - User's current GPS latitude.
 * @param userLng - User's current GPS longitude.
 * @param restaurants - Cached restaurant catalog rows.
 * @param maxDistanceKm - Maximum centroid distance in km to auto-select a city (defaults to 25).
 * @returns Matched city name or `null` if no city centroid is within `maxDistanceKm`.
 */
export function detectNearestCity(
  userLat: number,
  userLng: number,
  restaurants: readonly Pick<Restaurant, "city" | "lat" | "lng">[],
  maxDistanceKm: number = 25,
): string | null {
  const byCity = new Map<string, { sumLat: number; sumLng: number; count: number }>();

  for (const r of restaurants) {
    const city = r.city?.trim();
    if (!city || r.lat === null || r.lng === null) continue;
    const acc = byCity.get(city) ?? { sumLat: 0, sumLng: 0, count: 0 };
    acc.sumLat += r.lat;
    acc.sumLng += r.lng;
    acc.count += 1;
    byCity.set(city, acc);
  }

  let bestCity: string | null = null;
  let bestDistKm = Infinity;

  for (const [city, acc] of byCity.entries()) {
    if (acc.count === 0) continue;
    const centroidLat = acc.sumLat / acc.count;
    const centroidLng = acc.sumLng / acc.count;
    const dist = distanceKm(userLat, userLng, centroidLat, centroidLng);
    if (dist <= maxDistanceKm && dist < bestDistKm) {
      bestDistKm = dist;
      bestCity = city;
    }
  }

  return bestCity;
}

/**
 * Compute the number of days elapsed since `lastVisited` (YYYY-MM-DD) relative
 * to `now`. Returns `null` when `lastVisited` is null or invalid.
 *
 * @param lastVisited - ISO date string (`YYYY-MM-DD`) or null.
 * @param now - Reference date (defaults to current time).
 * @returns Non-negative elapsed days or `null`.
 */
export function daysSinceLastVisited(
  lastVisited: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!lastVisited) return null;
  const parsed = new Date(`${lastVisited.slice(0, 10)}T00:00:00Z`);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (now.getTime() - ms) / 86400000);
}

/**
 * Compute a client-side Vibe Match score for a restaurant using the active
 * `VibeMode` priority weights.
 *
 * - `"best_overall"`: `r.overall`
 * - `"vegan_priority"`: `0.55 * food + 0.35 * vegan_options + 0.10 * value`
 * - `"best_value"`: `0.55 * food + 0.35 * value + 0.10 * vegan_options`
 * - `"date_night"`: `0.50 * food + 0.30 * ambiance + 0.15 * service + 0.05 * vegan_options`
 * - `"havent_been_lately"`: `r.overall` + staleness bonus (up to `+1.00` at 365+ days for `overall >= 8.0`)
 *
 * @param r - Restaurant record containing `overall`, sub-ratings, and `last_visited`.
 * @param vibe - Active `VibeMode`.
 * @param now - Reference date for `"havent_been_lately"` staleness calculation.
 * @returns Rounded 2-decimal match score (or `0` for unrated bookmarks).
 */
export function computeVibeScore(
  r: Pick<
    Restaurant,
    "overall" | "food" | "value" | "service" | "ambiance" | "vegan_options" | "last_visited"
  >,
  vibe: VibeMode,
  now: Date = new Date(),
): number {
  if (!isRatedRestaurant(r)) return 0;

  const fallback = Number(r.overall) || 0;
  const food = Number(r.food ?? fallback);
  const value = Number(r.value ?? fallback);
  const service = Number(r.service ?? fallback);
  const ambiance = Number(r.ambiance ?? fallback);
  const vegan = Number(r.vegan_options ?? fallback);

  switch (vibe) {
    case "best_overall":
      return round2(fallback);
    case "vegan_priority":
      return round2(0.55 * food + 0.35 * vegan + 0.1 * value);
    case "best_value":
      return round2(0.55 * food + 0.35 * value + 0.1 * vegan);
    case "date_night":
      return round2(0.5 * food + 0.3 * ambiance + 0.15 * service + 0.05 * vegan);
    case "havent_been_lately": {
      const days = daysSinceLastVisited(r.last_visited, now);
      const rawBonus = days === null ? 0.5 : Math.min(1.0, days / 365);
      const multiplier = fallback >= 8.0 ? 1.0 : 0.25;
      return round2(fallback + rawBonus * multiplier);
    }
  }
}

/**
 * Generate a concise 1-line explanation of why a restaurant matched the active
 * `VibeMode` and location filter.
 *
 * @param r - Restaurant record.
 * @param vibe - Active `VibeMode`.
 * @param distanceMi - Optional distance in miles from user's GPS coordinate.
 * @param now - Reference date for `"havent_been_lately"`.
 * @returns Human-readable match reason badge text.
 */
export function explainVibeMatch(
  r: Pick<
    Restaurant,
    "overall" | "food" | "value" | "service" | "ambiance" | "vegan_options" | "last_visited" | "city"
  >,
  vibe: VibeMode,
  distanceMi?: number | null,
  now: Date = new Date(),
): string {
  const distPrefix =
    typeof distanceMi === "number" && Number.isFinite(distanceMi)
      ? `${distanceMi.toFixed(1)} mi · `
      : "";

  if (!isRatedRestaurant(r)) {
    return `${distPrefix}Saved in Want to Go · ${r.city}`;
  }

  switch (vibe) {
    case "vegan_priority":
      return `${distPrefix}Vegan ${(r.vegan_options ?? r.overall).toFixed(1)} · Food ${(r.food ?? r.overall).toFixed(1)}`;
    case "best_value":
      return `${distPrefix}Value ${(r.value ?? r.overall).toFixed(1)} · Food ${(r.food ?? r.overall).toFixed(1)}`;
    case "date_night":
      return `${distPrefix}Vibe ${(r.ambiance ?? r.overall).toFixed(1)} · Service ${(r.service ?? r.overall).toFixed(1)}`;
    case "havent_been_lately": {
      const days = daysSinceLastVisited(r.last_visited, now);
      const agoLabel =
        days === null ? "No recent visit date" : `${Math.round(days)}d since last visit`;
      return `${distPrefix}${agoLabel} · Overall ${r.overall.toFixed(2)}`;
    }
    case "best_overall":
    default:
      return `${distPrefix}Overall ${r.overall.toFixed(2)} · Food ${(r.food ?? r.overall).toFixed(1)}`;
  }
}

export type RankByVibeOptions = {
  pool?: "rated" | "want_to_go";
  locationMode?: "city" | "near_me";
  city?: string | null;
  userLocation?: { lat: number; lng: number } | null;
  radiusMiles?: number;
  category?: string | null;
  cuisine?: string | null;
  vibe?: VibeMode;
  maxResults?: number;
  now?: Date;
};

export type RankedRestaurantMatch = {
  restaurant: Restaurant;
  vibeScore: number;
  distanceMi: number | null;
  matchReason: string;
};

/**
 * Filter and rank cached restaurants in `< 1 ms` for the iPhone Decide tab.
 *
 * Supports:
 * - Pool partitioning: `"rated"` (`food !== null`) vs `"want_to_go"` (`food === null`)
 * - Location filtering: GPS `"near_me"` Haversine radius (`1 / 3 / 5 mi`) or explicit `"city"`
 * - Category (`Food | Drink | Dessert`) & Cuisine filtering
 * - Client-side Vibe Boost re-weighting and eligibility checks (`vegan_options >= 8.0` for `"vegan_priority"`, `overall >= 8.0` for `"havent_been_lately"`)
 *
 * @param restaurants - Cached restaurant catalog rows.
 * @param opts - `RankByVibeOptions` filter and scoring configuration.
 * @returns Ranked array of `RankedRestaurantMatch` items.
 */
export function rankRestaurantsByVibe(
  restaurants: readonly Restaurant[],
  opts: RankByVibeOptions = {},
): RankedRestaurantMatch[] {
  const pool = opts.pool ?? "rated";
  const locationMode = opts.locationMode ?? "city";
  const city = opts.city?.trim() ?? "";
  const userLocation = opts.userLocation ?? null;
  const radiusMiles = opts.radiusMiles ?? 3;
  const category = opts.category?.trim() ?? "";
  const cuisine = opts.cuisine?.trim() ?? "";
  const vibe: VibeMode = opts.vibe ?? "best_overall";
  const now = opts.now ?? new Date();

  const matches: RankedRestaurantMatch[] = [];

  for (const r of restaurants) {
    const rated = isRatedRestaurant(r);
    if (pool === "rated" && !rated) continue;
    if (pool === "want_to_go" && rated) continue;

    let distanceMi: number | null = null;
    if (userLocation && r.lat !== null && r.lng !== null) {
      distanceMi = round2(
        distanceMiles(userLocation.lat, userLocation.lng, r.lat, r.lng),
      );
    }

    if (locationMode === "near_me" && userLocation) {
      if (distanceMi === null || distanceMi > radiusMiles) continue;
    } else if (city) {
      if (r.city !== city) continue;
    }

    if (category && r.category !== category) continue;
    if (cuisine && !r.cuisines.includes(cuisine)) continue;

    if (pool === "rated") {
      if (vibe === "vegan_priority" && (r.vegan_options ?? 0) < 8.0) continue;
      if (vibe === "havent_been_lately" && r.overall < 8.0) continue;
    }

    const vibeScore = pool === "rated" ? computeVibeScore(r, vibe, now) : 0;
    const matchReason = explainVibeMatch(r, vibe, distanceMi, now);

    matches.push({
      restaurant: r,
      vibeScore,
      distanceMi,
      matchReason,
    });
  }

  matches.sort((a, b) => {
    if (pool === "rated") {
      if (b.vibeScore !== a.vibeScore) return b.vibeScore - a.vibeScore;
      if (b.restaurant.overall !== a.restaurant.overall) {
        return b.restaurant.overall - a.restaurant.overall;
      }
    }
    if (a.distanceMi !== null && b.distanceMi !== null && a.distanceMi !== b.distanceMi) {
      return a.distanceMi - b.distanceMi;
    }
    return a.restaurant.name.localeCompare(b.restaurant.name);
  });

  if (typeof opts.maxResults === "number" && opts.maxResults > 0) {
    return matches.slice(0, opts.maxResults);
  }

  return matches;
}
