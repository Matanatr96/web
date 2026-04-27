import { describe, it, expect } from "vitest";
import { parseOptionSymbol } from "@/lib/tradier";

describe("parseOptionSymbol", () => {
  it("parses a call option", () => {
    const result = parseOptionSymbol("GOOG260522C00360000");
    expect(result).toEqual({
      option_type:     "call",
      strike:          360.00,
      expiration_date: "2026-05-22",
    });
  });

  it("parses a put option", () => {
    const result = parseOptionSymbol("AAPL260101P00150000");
    expect(result).toEqual({
      option_type:     "put",
      strike:          150.00,
      expiration_date: "2026-01-01",
    });
  });

  it("parses a strike with fractional dollars", () => {
    // 00150500 → 150.500 → $150.50
    const result = parseOptionSymbol("AAPL260101C00150500");
    expect(result?.strike).toBeCloseTo(150.50);
  });

  it("handles a short ticker symbol (SPY)", () => {
    const result = parseOptionSymbol("SPY260620C00550000");
    expect(result?.option_type).toBe("call");
    expect(result?.strike).toBe(550.00);
    expect(result?.expiration_date).toBe("2026-06-20");
  });

  it("handles a longer ticker symbol (GOOGL)", () => {
    const result = parseOptionSymbol("GOOGL261219P00180000");
    expect(result?.option_type).toBe("put");
    expect(result?.expiration_date).toBe("2026-12-19");
  });

  it("returns null for an invalid / empty symbol", () => {
    expect(parseOptionSymbol("")).toBeNull();
    expect(parseOptionSymbol("INVALID")).toBeNull();
    expect(parseOptionSymbol("AAPL-260101-C-150")).toBeNull();
  });

  it("parses a very low strike (near zero)", () => {
    const result = parseOptionSymbol("SPCE260101C00001000");
    expect(result?.strike).toBeCloseTo(1.00);
  });
});
