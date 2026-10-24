import { describe, it, expect } from "vitest";
import type { Restaurant } from "@/lib/types";
import {
  VIBE_OPTIONS,
  computeVibeScore,
  daysSinceLastVisited,
  detectNearestCity,
  distanceKm,
  distanceMiles,
  explainVibeMatch,
  rankRestaurantsByVibe,
} from "../../mobile/src/lib/vibe-scoring";

function makeRestaurant(overrides: Partial<Restaurant> = {}): Restaurant {
  return {
    id: 1,
    name: "Default Spot",
    city: "San Francisco",
    category: "Food",
    cuisines: ["Indian"],
    overall: 8.8,
    food: 9.0,
    value: 8.0,
    service: 8.0,
    ambiance: 8.0,
    vegan_options: 8.5,
    note: "Great chana masala",
    last_visited: "2026-08-01",
    address: "123 Valencia St",
    lat: 37.768,
    lng: -122.4216,
    place_id: "place_1",
    photos: null,
    visit_count: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("distanceMiles & distanceKm", () => {
  it("returns 0 for identical coordinates", () => {
    expect(distanceMiles(37.7749, -122.4194, 37.7749, -122.4194)).toBe(0);
    expect(distanceKm(37.7749, -122.4194, 37.7749, -122.4194)).toBe(0);
  });

  it("computes accurate great-circle distance between SF Ferry Building and Mission Dolores (~2.7 mi)", () => {
    const miles = distanceMiles(37.7955, -122.3937, 37.7596, -122.4269);
    const km = distanceKm(37.7955, -122.3937, 37.7596, -122.4269);
    expect(miles).toBeGreaterThan(2.9);
    expect(miles).toBeLessThan(3.3);
    expect(km).toBeCloseTo(miles * 1.609344, 1);
  });
});

describe("detectNearestCity", () => {
  const catalog = [
    makeRestaurant({ id: 1, city: "San Francisco", lat: 37.7749, lng: -122.4194 }),
    makeRestaurant({ id: 2, city: "San Francisco", lat: 37.7599, lng: -122.4148 }),
    makeRestaurant({ id: 3, city: "New York", lat: 40.7128, lng: -74.006 }),
    makeRestaurant({ id: 4, city: "Unpinned City", lat: null, lng: null }),
  ];

  it("returns the nearest city centroid within maxDistanceKm", () => {
    expect(detectNearestCity(37.78, -122.41, catalog)).toBe("San Francisco");
    expect(detectNearestCity(40.72, -74.0, catalog)).toBe("New York");
  });

  it("returns null when the user is farther than maxDistanceKm from all centroids", () => {
    // Los Angeles coordinates (~550 km from SF)
    expect(detectNearestCity(34.0522, -118.2437, catalog, 25)).toBeNull();
  });

  it("ignores rows without coordinates", () => {
    expect(
      detectNearestCity(37.7749, -122.4194, [
        makeRestaurant({ city: "NoCoords", lat: null, lng: null }),
      ]),
    ).toBeNull();
  });
});

describe("daysSinceLastVisited & computeVibeScore", () => {
  const now = new Date("2026-10-23T00:00:00Z");

  it("exposes all 5 Vibe Boost options", () => {
    expect(VIBE_OPTIONS.map((v) => v.key)).toEqual([
      "best_overall",
      "vegan_priority",
      "best_value",
      "date_night",
      "havent_been_lately",
    ]);
  });

  it("computes elapsed days accurately and returns null for missing dates", () => {
    expect(daysSinceLastVisited("2026-10-13", now)).toBe(10);
    expect(daysSinceLastVisited(null, now)).toBeNull();
  });

  it("returns 0 for unrated Want-to-Go bookmarks across all vibe modes", () => {
    const unrated = makeRestaurant({ overall: 0, food: null });
    expect(computeVibeScore(unrated, "best_overall", now)).toBe(0);
    expect(computeVibeScore(unrated, "vegan_priority", now)).toBe(0);
  });

  it("re-weights sub-ratings according to the selected VibeMode", () => {
    const spot = makeRestaurant({
      overall: 8.5,
      food: 9.0,
      vegan_options: 10.0,
      value: 7.0,
      ambiance: 6.0,
      service: 6.0,
      last_visited: "2025-10-23", // 365 days ago
    });

    expect(computeVibeScore(spot, "best_overall", now)).toBe(8.5);
    // vegan_priority: 0.55*9.0 + 0.35*10.0 + 0.10*7.0 = 4.95 + 3.50 + 0.70 = 9.15
    expect(computeVibeScore(spot, "vegan_priority", now)).toBe(9.15);
    // best_value: 0.55*9.0 + 0.35*7.0 + 0.10*10.0 = 4.95 + 2.45 + 1.00 = 8.40
    expect(computeVibeScore(spot, "best_value", now)).toBe(8.4);
    // date_night: 0.50*9.0 + 0.30*6.0 + 0.15*6.0 + 0.05*10.0 = 4.50 + 1.80 + 0.90 + 0.50 = 7.70
    expect(computeVibeScore(spot, "date_night", now)).toBe(7.7);
    // havent_been_lately: 8.5 + 1.0 (365d staleness bonus for overall >= 8.0) = 9.50
    expect(computeVibeScore(spot, "havent_been_lately", now)).toBe(9.5);
  });
});

describe("rankRestaurantsByVibe & explainVibeMatch", () => {
  const now = new Date("2026-10-23T00:00:00Z");

  const rVeganGem = makeRestaurant({
    id: 1,
    name: "Vegan Gem",
    city: "San Francisco",
    category: "Food",
    cuisines: ["Thai"],
    overall: 8.6,
    food: 8.6,
    vegan_options: 9.8,
    value: 9.2,
    ambiance: 7.0,
    service: 7.5,
    last_visited: "2026-10-15",
    lat: 37.775,
    lng: -122.419,
  });

  const rDateNight = makeRestaurant({
    id: 2,
    name: "Candlelight Bistro",
    city: "San Francisco",
    category: "Food",
    cuisines: ["Thai"],
    overall: 8.7,
    food: 8.8,
    vegan_options: 7.5, // below 8.0 vegan_priority threshold
    value: 6.5,
    ambiance: 9.8,
    service: 9.5,
    last_visited: "2025-09-01", // >1 year ago
    lat: 37.776,
    lng: -122.418,
  });

  const rWantToGo = makeRestaurant({
    id: 3,
    name: "Bookmark Thai",
    city: "San Francisco",
    category: "Food",
    cuisines: ["Thai"],
    overall: 0,
    food: null,
    value: null,
    service: null,
    ambiance: null,
    vegan_options: null,
    last_visited: null,
    lat: 37.774,
    lng: -122.42,
  });

  const rFarAway = makeRestaurant({
    id: 4,
    name: "Oakland Thai",
    city: "Oakland",
    category: "Food",
    cuisines: ["Thai"],
    overall: 9.4,
    food: 9.5,
    vegan_options: 9.0,
    value: 9.0,
    ambiance: 8.5,
    service: 8.5,
    lat: 37.8044,
    lng: -122.2712, // ~8.3 miles from SF civic center
  });

  const list = [rVeganGem, rDateNight, rWantToGo, rFarAway];

  it("separates rated favorites from unrated Want-to-Go bookmarks", () => {
    const rated = rankRestaurantsByVibe(list, {
      pool: "rated",
      city: "San Francisco",
      now,
    });
    expect(rated.map((m) => m.restaurant.name)).toEqual([
      "Candlelight Bistro",
      "Vegan Gem",
    ]);

    const bookmarks = rankRestaurantsByVibe(list, {
      pool: "want_to_go",
      city: "San Francisco",
      now,
    });
    expect(bookmarks.map((m) => m.restaurant.name)).toEqual(["Bookmark Thai"]);
    expect(bookmarks[0].matchReason).toContain("Saved in Want to Go");
  });

  it("filters vegan_priority to vegan_options >= 8.0 and ranks by vegan boost", () => {
    const veganPicks = rankRestaurantsByVibe(list, {
      pool: "rated",
      city: "San Francisco",
      vibe: "vegan_priority",
      now,
    });
    expect(veganPicks.map((m) => m.restaurant.name)).toEqual(["Vegan Gem"]);
    expect(veganPicks[0].matchReason).toContain("Vegan 9.8");
  });

  it("ranks date_night and havent_been_lately accurately", () => {
    const datePicks = rankRestaurantsByVibe(list, {
      pool: "rated",
      city: "San Francisco",
      vibe: "date_night",
      now,
    });
    expect(datePicks[0].restaurant.name).toBe("Candlelight Bistro");
    expect(datePicks[0].matchReason).toContain("Vibe 9.8");

    const overduePicks = rankRestaurantsByVibe(list, {
      pool: "rated",
      city: "San Francisco",
      vibe: "havent_been_lately",
      now,
    });
    expect(overduePicks[0].restaurant.name).toBe("Candlelight Bistro");
  });

  it("filters by GPS near_me radius in miles across city boundaries", () => {
    const userLoc = { lat: 37.7749, lng: -122.4194 };
    const within1Mi = rankRestaurantsByVibe(list, {
      pool: "rated",
      locationMode: "near_me",
      userLocation: userLoc,
      radiusMiles: 1,
      now,
    });
    expect(within1Mi.map((m) => m.restaurant.name)).toEqual([
      "Candlelight Bistro",
      "Vegan Gem",
    ]);

    const within10Mi = rankRestaurantsByVibe(list, {
      pool: "rated",
      locationMode: "near_me",
      userLocation: userLoc,
      radiusMiles: 10,
      now,
    });
    expect(within10Mi.map((m) => m.restaurant.name)).toEqual([
      "Oakland Thai",
      "Candlelight Bistro",
      "Vegan Gem",
    ]);
    expect(explainVibeMatch(rVeganGem, "best_overall", 0.4, now)).toContain("0.4 mi ·");
  });
});
