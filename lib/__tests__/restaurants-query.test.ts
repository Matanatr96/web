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
