import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  slugify,
  fmt,
  ratingColorClass,
  lastVisitedColorClass,
  computeOverall,
  RATING_WEIGHTS,
} from "@/lib/utils";

describe("slugify", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugify("San Francisco")).toBe("san-francisco");
  });

  it("trims leading and trailing whitespace", () => {
    expect(slugify("  hello world  ")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(slugify("New York!")).toBe("new-york");
  });

  it("collapses multiple non-alphanumeric chars into one hyphen", () => {
    expect(slugify("foo & bar")).toBe("foo-bar");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("handles already-slugified input", () => {
    expect(slugify("new-york")).toBe("new-york");
  });

  it("returns empty string for all-special input", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("fmt", () => {
  it("returns — for null", () => {
    expect(fmt(null)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(fmt(undefined)).toBe("—");
  });

  it("formats a number to 1 decimal by default", () => {
    expect(fmt(8)).toBe("8.0");
  });

  it("respects a custom digits argument", () => {
    expect(fmt(8.567, 2)).toBe("8.57");
  });

  it("formats zero", () => {
    expect(fmt(0)).toBe("0.0");
  });

  it("formats negative numbers", () => {
    expect(fmt(-3.5)).toBe("-3.5");
  });
});

describe("ratingColorClass", () => {
  it("returns stone-400 for null", () => {
    expect(ratingColorClass(null)).toBe("text-stone-400");
  });

  it("returns stone-400 for undefined", () => {
    expect(ratingColorClass(undefined)).toBe("text-stone-400");
  });

  it("returns emerald-600 font-semibold for 9+", () => {
    expect(ratingColorClass(9)).toBe("text-emerald-600 font-semibold");
    expect(ratingColorClass(10)).toBe("text-emerald-600 font-semibold");
  });

  it("returns emerald-500 for 8–8.9", () => {
    expect(ratingColorClass(8)).toBe("text-emerald-500");
    expect(ratingColorClass(8.9)).toBe("text-emerald-500");
  });

  it("returns lime-600 for 7–7.9", () => {
    expect(ratingColorClass(7)).toBe("text-lime-600");
    expect(ratingColorClass(7.5)).toBe("text-lime-600");
  });

  it("returns amber-600 for 6–6.9", () => {
    expect(ratingColorClass(6)).toBe("text-amber-600");
  });

  it("returns orange-600 for 5–5.9", () => {
    expect(ratingColorClass(5)).toBe("text-orange-600");
  });

  it("returns red-600 for below 5", () => {
    expect(ratingColorClass(4.9)).toBe("text-red-600");
    expect(ratingColorClass(0)).toBe("text-red-600");
  });
});

describe("lastVisitedColorClass", () => {
  const NOW = new Date("2025-06-01").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns stone-400 for null", () => {
    expect(lastVisitedColorClass(null)).toBe("text-stone-400");
  });

  it("returns stone-400 for undefined", () => {
    expect(lastVisitedColorClass(undefined)).toBe("text-stone-400");
  });

  it("returns emerald-600 for a visit less than 1 year ago", () => {
    expect(lastVisitedColorClass("2025-01-01")).toBe("text-emerald-600");
  });

  it("returns amber-600 for a visit 1–3 years ago", () => {
    expect(lastVisitedColorClass("2023-06-01")).toBe("text-amber-600");
  });

  it("returns red-600 for a visit more than 3 years ago", () => {
    expect(lastVisitedColorClass("2020-01-01")).toBe("text-red-600");
  });
});

describe("computeOverall", () => {
  const fullScores = { food: 9, value: 8, service: 7, ambiance: 8, vegan_options: 6 };

  it("returns null for an unknown category", () => {
    expect(computeOverall("Unknown", fullScores)).toBeNull();
  });

  it("returns null when any score is null", () => {
    expect(computeOverall("Food", { ...fullScores, food: null })).toBeNull();
    expect(computeOverall("Food", { ...fullScores, value: null })).toBeNull();
    expect(computeOverall("Food", { ...fullScores, vegan_options: null })).toBeNull();
  });

  it("computes a weighted average for Food", () => {
    const w = RATING_WEIGHTS["Food"];
    const totalWeight = w.food + w.value + w.service + w.ambiance + w.vegan_options;
    const expected =
      Math.round(
        ((fullScores.food * w.food +
          fullScores.value * w.value +
          fullScores.service * w.service +
          fullScores.ambiance * w.ambiance +
          fullScores.vegan_options * w.vegan_options) /
          totalWeight) *
          100,
      ) / 100;
    expect(computeOverall("Food", fullScores)).toBe(expected);
  });

  it("gives same result for Drink and Dessert (same weights)", () => {
    const food = computeOverall("Food", fullScores);
    const drink = computeOverall("Drink", fullScores);
    const dessert = computeOverall("Dessert", fullScores);
    expect(drink).toBe(food);
    expect(dessert).toBe(food);
  });

  it("produces a result in the 0–10 range for boundary scores", () => {
    const result = computeOverall("Food", {
      food: 10,
      value: 10,
      service: 10,
      ambiance: 10,
      vegan_options: 10,
    });
    expect(result).toBe(10);
  });

  it("computes correct overall for all-zero scores", () => {
    const result = computeOverall("Food", {
      food: 0,
      value: 0,
      service: 0,
      ambiance: 0,
      vegan_options: 0,
    });
    expect(result).toBe(0);
  });
});
