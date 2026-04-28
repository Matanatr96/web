import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isMarketOpen } from "@/lib/quotes";

// All UTC timestamps — NYSE hours are 13:30–20:00 UTC (ignores DST per the implementation).
// Reference week: Mon 2024-06-17 through Sun 2024-06-23.

describe("isMarketOpen", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns false on Saturday", () => {
    vi.setSystemTime(new Date("2024-06-22T15:00:00Z"));
    expect(isMarketOpen()).toBe(false);
  });

  it("returns false on Sunday", () => {
    vi.setSystemTime(new Date("2024-06-23T15:00:00Z"));
    expect(isMarketOpen()).toBe(false);
  });

  it("returns false before 13:30 UTC on a weekday", () => {
    vi.setSystemTime(new Date("2024-06-21T13:29:00Z")); // 9:29 ET — one minute early
    expect(isMarketOpen()).toBe(false);
  });

  it("returns true at exactly 13:30 UTC (market open)", () => {
    vi.setSystemTime(new Date("2024-06-21T13:30:00Z")); // 9:30 ET
    expect(isMarketOpen()).toBe(true);
  });

  it("returns true during core market hours", () => {
    vi.setSystemTime(new Date("2024-06-21T17:00:00Z")); // 13:00 ET midday
    expect(isMarketOpen()).toBe(true);
  });

  it("returns true at 19:59 UTC (one minute before close)", () => {
    vi.setSystemTime(new Date("2024-06-21T19:59:00Z")); // 15:59 ET
    expect(isMarketOpen()).toBe(true);
  });

  it("returns false at exactly 20:00 UTC (market close)", () => {
    vi.setSystemTime(new Date("2024-06-21T20:00:00Z")); // 16:00 ET
    expect(isMarketOpen()).toBe(false);
  });

  it("returns false after 20:00 UTC on a weekday", () => {
    vi.setSystemTime(new Date("2024-06-21T21:00:00Z")); // 17:00 ET post-close
    expect(isMarketOpen()).toBe(false);
  });
});
