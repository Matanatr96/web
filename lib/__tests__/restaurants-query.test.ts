import { describe, it, expect } from "vitest";
import { mapRestaurantRow, matchCuisineFromGoogleType } from "@/lib/restaurants-query";

const baseRow = {
  id: 1,
  name: "Test",
  city: "SF",
  category: "Food",
  overall: 8.5,
  food: 8,
  value: 8,
  service: 8,
  ambiance: 8,
  vegan_options: null,
  note: null,
  last_visited: null,
  address: null,
  lat: null,
  lng: null,
  place_id: null,
  photos: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("mapRestaurantRow", () => {
  it("flattens restaurant_cuisines into a sorted cuisines array", () => {
    const r = mapRestaurantRow({
      ...baseRow,
      restaurant_cuisines: [
        { cuisine_name: "Sushi" },
        { cuisine_name: "Japanese" },
      ],
    });
    expect(r.cuisines).toEqual(["Japanese", "Sushi"]);
  });

  it("returns an empty cuisines array when the embed is missing", () => {
    const r = mapRestaurantRow({ ...baseRow });
    expect(r.cuisines).toEqual([]);
  });

  it("returns an empty cuisines array when the embed is null", () => {
    const r = mapRestaurantRow({ ...baseRow, restaurant_cuisines: null });
    expect(r.cuisines).toEqual([]);
  });

  it("returns an empty cuisines array when the embed is an empty list", () => {
    const r = mapRestaurantRow({ ...baseRow, restaurant_cuisines: [] });
    expect(r.cuisines).toEqual([]);
  });

  it("preserves the rest of the restaurant fields verbatim", () => {
    const r = mapRestaurantRow({
      ...baseRow,
      restaurant_cuisines: [{ cuisine_name: "Italian" }],
    });
    expect(r.id).toBe(1);
    expect(r.name).toBe("Test");
    expect(r.city).toBe("SF");
    expect(r.overall).toBe(8.5);
  });

  it("does not leak the raw restaurant_cuisines key onto the output", () => {
    const r = mapRestaurantRow({
      ...baseRow,
      restaurant_cuisines: [{ cuisine_name: "Italian" }],
    });
    expect("restaurant_cuisines" in r).toBe(false);
  });
});

describe("matchCuisineFromGoogleType", () => {
  const cuisines = [
    "American",
    "Italian",
    "Japanese",
    "Korean",
    "Pizza",
    "Sushi",
    "Indian",
  ];

  it("matches the display name suffix against a cuisine (tier 2: cuisine-in-signal)", () => {
    expect(matchCuisineFromGoogleType("Sushi Restaurant", null, cuisines)).toBe(
      "Sushi",
    );
  });

  it("matches the raw enum after underscore→space normalization", () => {
    expect(
      matchCuisineFromGoogleType(undefined, "korean_restaurant", cuisines),
    ).toBe("Korean");
  });

  it("is case insensitive", () => {
    expect(matchCuisineFromGoogleType("ITALIAN RESTAURANT", null, cuisines)).toBe(
      "Italian",
    );
  });

  it("returns null when no signal is provided", () => {
    expect(matchCuisineFromGoogleType(null, null, cuisines)).toBeNull();
    expect(matchCuisineFromGoogleType(undefined, undefined, cuisines)).toBeNull();
    expect(matchCuisineFromGoogleType("", "", cuisines)).toBeNull();
  });

  it("returns null when the signal has no overlap with any cuisine", () => {
    expect(matchCuisineFromGoogleType("Movie Theater", null, cuisines)).toBeNull();
  });

  it("matches the cuisine inside a longer Google label (tier 2)", () => {
    expect(
      matchCuisineFromGoogleType("Korean Barbecue Restaurant", null, cuisines),
    ).toBe("Korean");
  });

  it("falls back to signal-in-cuisine when only the short form is available (tier 1)", () => {
    // Raw "pizza" is fully contained in cuisine "Pizza".
    expect(matchCuisineFromGoogleType(undefined, "pizza", cuisines)).toBe(
      "Pizza",
    );
  });

  it("prefers an exact match (tier 3) over a substring match (tier 2)", () => {
    // "Pizza" is a substring of "Pizza Restaurant", but raw "italian" exactly
    // equals cuisine "Italian" — tier 3 should win.
    expect(
      matchCuisineFromGoogleType("Pizza Restaurant", "italian", cuisines),
    ).toBe("Italian");
  });

  it("prefers an exact match across signals regardless of order", () => {
    // Same expectation as above but with signals swapped — raw still wins.
    expect(
      matchCuisineFromGoogleType("italian", "pizza_restaurant", cuisines),
    ).toBe("Italian");
  });

  it("ignores trailing-suffix decorations that previously needed a strip rule", () => {
    expect(matchCuisineFromGoogleType("Indian Bakery", null, cuisines)).toBe(
      "Indian",
    );
  });

  it("returns the first cuisine when two cuisines tie at the same score", () => {
    // Both "Japanese" and "Sushi" appear in this label; whichever comes
    // first in the list wins — locks behavior so users can re-order the
    // canonical list to influence ties.
    const ordered = ["Japanese", "Sushi"];
    expect(
      matchCuisineFromGoogleType("Japanese Sushi Restaurant", null, ordered),
    ).toBe("Japanese");

    const reversed = ["Sushi", "Japanese"];
    expect(
      matchCuisineFromGoogleType("Japanese Sushi Restaurant", null, reversed),
    ).toBe("Sushi");
  });

  it("returns null for an empty cuisine list", () => {
    expect(matchCuisineFromGoogleType("Sushi Restaurant", null, [])).toBeNull();
  });

  it("applies the manual Coffee Shop → Cafe alias", () => {
    const list = [...cuisines, "Cafe"];
    expect(matchCuisineFromGoogleType("Coffee Shop", null, list)).toBe("Cafe");
    expect(matchCuisineFromGoogleType(null, "coffee_shop", list)).toBe("Cafe");
  });

  it("only applies an alias when the target cuisine is in the list", () => {
    // "Cafe" is absent from this list, so the alias can't fire and we fall
    // through to the regular fuzzy match — which finds nothing here.
    expect(matchCuisineFromGoogleType("Coffee Shop", null, cuisines)).toBeNull();
  });

  it("alias takes precedence over an exact cuisine match from the other signal", () => {
    // Display signal triggers the alias (→ Cafe); raw signal exactly equals
    // "Italian". Alias should still win because it short-circuits before
    // scoring.
    const list = [...cuisines, "Cafe"];
    expect(matchCuisineFromGoogleType("Coffee Shop", "italian", list)).toBe(
      "Cafe",
    );
  });
});

describe("filterAdminRestaurants", () => {
  it("filters by city, cuisine, category, status, and sorts results", async () => {
    const { filterAdminRestaurants } = await import("@/lib/restaurants-query");
    const rows = [
      mapRestaurantRow({
        ...baseRow,
        id: 1,
        name: "Bistro A",
        city: "SF",
        category: "Food",
        overall: 9.2,
        food: 9,
        lat: 37.77,
        lng: -122.41,
        visit_count: 2,
        restaurant_cuisines: [{ cuisine_name: "French" }],
      }),
      mapRestaurantRow({
        ...baseRow,
        id: 2,
        name: "Stub Cafe",
        city: "NYC",
        category: "Drink",
        overall: 0,
        food: null,
        lat: null,
        lng: null,
        visit_count: 1,
        restaurant_cuisines: [],
      }),
      mapRestaurantRow({
        ...baseRow,
        id: 3,
        name: "Sushi Spot",
        city: "SF",
        category: "Food",
        overall: 8.8,
        food: 9,
        lat: 37.78,
        lng: -122.42,
        visit_count: 1,
        restaurant_cuisines: [{ cuisine_name: "Sushi" }],
      }),
    ];

    expect(filterAdminRestaurants(rows, { city: "SF" }).map((r) => r.name)).toEqual([
      "Bistro A",
      "Sushi Spot",
    ]);
    expect(filterAdminRestaurants(rows, { cuisine: "Sushi" }).map((r) => r.name)).toEqual([
      "Sushi Spot",
    ]);
    expect(filterAdminRestaurants(rows, { category: "Drink" }).map((r) => r.name)).toEqual([
      "Stub Cafe",
    ]);
    expect(filterAdminRestaurants(rows, { status: "unrated" }).map((r) => r.name)).toEqual([
      "Stub Cafe",
    ]);
    expect(filterAdminRestaurants(rows, { status: "missing_coords" }).map((r) => r.name)).toEqual([
      "Stub Cafe",
    ]);
    expect(filterAdminRestaurants(rows, { status: "missing_cuisine" }).map((r) => r.name)).toEqual([
      "Stub Cafe",
    ]);
    expect(
      filterAdminRestaurants(rows, { sortKey: "name", sortDir: "asc" }).map((r) => r.name),
    ).toEqual(["Bistro A", "Stub Cafe", "Sushi Spot"]);
  });
});

describe("isRatedRestaurant & partitionRestaurants", () => {
  it("distinguishes rated rows from unrated Want-to-Go bookmarks", async () => {
    const { isRatedRestaurant, partitionRestaurants } = await import(
      "@/lib/restaurants-query"
    );
    const ratedRow = mapRestaurantRow({
      ...baseRow,
      id: 1,
      name: "Rated Spot",
      food: 8.5,
      overall: 8.4,
    });
    const unratedRow = mapRestaurantRow({
      ...baseRow,
      id: 2,
      name: "Want To Go Spot",
      food: null,
      overall: 0,
    });

    expect(isRatedRestaurant(ratedRow)).toBe(true);
    expect(isRatedRestaurant(unratedRow)).toBe(false);

    const partitioned = partitionRestaurants([ratedRow, unratedRow]);
    expect(partitioned.rated.map((r) => r.name)).toEqual(["Rated Spot"]);
    expect(partitioned.wantToGo.map((r) => r.name)).toEqual(["Want To Go Spot"]);
  });
});

describe("pickRandom", () => {
  it("returns all items when count >= items.length", async () => {
    const { pickRandom } = await import("@/lib/restaurants-query");
    expect(pickRandom(["A", "B"], 3, 0)).toEqual(["A", "B"]);
  });

  it("deterministically samples count items and varies with seed", async () => {
    const { pickRandom } = await import("@/lib/restaurants-query");
    const items = ["Italian", "Sushi", "Mexican", "Thai", "Indian", "Korean"];
    const first = pickRandom(items, 3, 0);
    const repeat = pickRandom(items, 3, 0);
    const reshuffled = pickRandom(items, 3, 1);

    expect(first).toHaveLength(3);
    expect(first).toEqual(repeat);
    expect(reshuffled).toHaveLength(3);
    expect(reshuffled).not.toEqual(first);
  });
});

describe("suggestPersonalRestaurants", () => {
  it("excludes unrated bookmarks in rated mode and returns them in want_to_go mode", async () => {
    const { suggestPersonalRestaurants } = await import("@/lib/restaurants-query");
    const rows = [
      mapRestaurantRow({
        ...baseRow,
        id: 1,
        name: "Top Sushi",
        city: "SF",
        category: "Food",
        overall: 9.1,
        food: 9.2,
        restaurant_cuisines: [{ cuisine_name: "Sushi" }],
      }),
      mapRestaurantRow({
        ...baseRow,
        id: 2,
        name: "Good Sushi",
        city: "SF",
        category: "Food",
        overall: 8.3,
        food: 8.4,
        restaurant_cuisines: [{ cuisine_name: "Sushi" }],
      }),
      mapRestaurantRow({
        ...baseRow,
        id: 3,
        name: "Bookmarked Sushi",
        city: "SF",
        category: "Food",
        overall: 0,
        food: null,
        restaurant_cuisines: [{ cuisine_name: "Sushi" }],
      }),
    ];

    const ratedPicks = suggestPersonalRestaurants(rows, {
      city: "SF",
      category: "Food",
      cuisine: "Sushi",
      mode: "rated",
    });
    expect(ratedPicks.map((r) => r.name)).toEqual(["Top Sushi", "Good Sushi"]);

    const wantToGoPicks = suggestPersonalRestaurants(rows, {
      city: "SF",
      category: "Food",
      cuisine: "Sushi",
      mode: "want_to_go",
    });
    expect(wantToGoPicks.map((r) => r.name)).toEqual(["Bookmarked Sushi"]);
  });
});

describe("bayesianScore", () => {
  it("weights rating toward priorMean when reviewCount is small", async () => {
    const { bayesianScore } = await import("@/lib/restaurants-query");
    // When v == m (50), score is exact midpoint between rating (5.0) and priorMean (4.0) -> 4.5
    expect(bayesianScore(5.0, 50, 50, 4.0)).toBeCloseTo(4.5, 5);
    // Higher review count with same rating scores higher when rating > priorMean
    expect(bayesianScore(4.8, 500)).toBeGreaterThan(bayesianScore(4.8, 60));
  });
});

describe("verifyAdminToken", () => {
  it("accepts either the raw ADMIN_PASSWORD or its SHA-256 hex session token", async () => {
    const prev = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD = "test-secret-password";
    try {
      const { verifyAdminToken, getAdminSessionToken } = await import("@/lib/auth");
      const token = getAdminSessionToken();
      expect(token).toBeTruthy();
      expect(verifyAdminToken("test-secret-password")).toBe(true);
      expect(verifyAdminToken(token!)).toBe(true);
      expect(verifyAdminToken("wrong-password")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_PASSWORD;
      else process.env.ADMIN_PASSWORD = prev;
    }
  });
});



