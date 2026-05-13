export type ActionVerb = "ROLL" | "CLOSE" | "WATCH ITM" | "LET EXPIRE" | "HOLD";
export type ActionTone = "green" | "amber" | "red" | "neutral";

export type ActionChip = {
  verb: ActionVerb;
  reason: string;
  tone: ActionTone;
};

export type ActionChipInput = {
  dte: number;
  isItm: boolean | null;
  pctCaptured: number | null; // 0–1 scale
  spot: number | null;
  strike: number;
};

export function deriveAction(input: ActionChipInput, rollTarget?: { strike: number; dte: number } | null): ActionChip {
  const { dte, isItm, pctCaptured, spot, strike } = input;
  const capturedPct = pctCaptured != null ? Math.round(pctCaptured * 100) : null;

  // ITM and running out of time
  if (dte <= 14 && isItm) {
    const depth = spot != null ? Math.abs(spot - strike).toFixed(2) : null;
    return {
      verb: "WATCH ITM",
      reason: depth != null ? `$${depth} in the money` : "in the money",
      tone: "red",
    };
  }

  // Nearly worthless — just let it expire
  if (dte <= 3 && isItm === false) {
    return {
      verb: "LET EXPIRE",
      reason: capturedPct != null ? `${capturedPct}% baked` : "nearly worthless",
      tone: "green",
    };
  }

  // Hit the 50% profit target — consider closing early
  if (capturedPct != null && capturedPct >= 50 && dte > 3) {
    return {
      verb: "CLOSE",
      reason: `${capturedPct}% captured`,
      tone: "green",
    };
  }

  // Near expiry and OTM — time to roll
  if (dte <= 14 && isItm === false) {
    if (rollTarget) {
      return {
        verb: "ROLL",
        reason: `→ $${rollTarget.strike} / ${rollTarget.dte}d`,
        tone: "amber",
      };
    }
    return {
      verb: "ROLL",
      reason: "near expiry",
      tone: "amber",
    };
  }

  // Comfortable hold
  return {
    verb: "HOLD",
    reason: capturedPct != null && capturedPct > 25 ? "coast mode" : "still early",
    tone: "neutral",
  };
}
