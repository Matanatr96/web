import { getExpirations, getOptionChain, getHv30 } from "./quotes";
import type { OptionsPosition } from "./types";

// Minimum monthly return a credit roll must clear to beat "let it expire and
// redeploy capital." Late-DTE remaining-extrinsic rates can spike to nonsense
// numbers, so we hurdle against an absolute target instead of comparing rates
// directly. 2%/mo ≈ premium-selling baseline for CSP/CC.
export const HURDLE_MONTHLY_RETURN_PCT = 2.0;

export type RollOption = {
  strike: number;
  bid: number;
  ask: number;
  spread_pct: number;
  is_liquid: boolean;
  delta: number | null;
  net_credit: number;         // new_bid - close_cost (negative = net debit)
  monthly_return_pct: number | null;
};

// Spread wider than 30% of mid → treat as illiquid (suppress recommendation).
// Wider spreads mean both leg fills are uncertain and the "credit" you see is
// likely unfillable.
export const LIQUID_SPREAD_PCT_THRESHOLD = 0.30;

export type RollOrHoldRow = {
  position: OptionsPosition;
  dte_remaining: number;
  capital: number;
  current_mark: number | null;
  spot: number | null;
  is_itm: boolean | null;
  remaining_extrinsic: number | null;
  hold_monthly_return_pct: number | null;
  gamma_warning: boolean;
  roll_expiration: string | null;
  roll_dte: number | null;
  same_strike: RollOption | null;
  best_strike: RollOption | null;
  iv_ratio: number | null;
};

// Annualizing remaining extrinsic at low DTE produces nonsense rates
// (30/2 = 15× multiplier) at exactly the moment gamma risk peaks.
// Floor the multiplier at ~5 DTE equivalent so the Hold column stays
// comparable to the Roll column instead of becoming a misleading spike.
const ANN_FACTOR_CAP = 6;
const GAMMA_WARNING_DTE = 5;

function pickNextExpiration(dates: string[], currentExpiry: string): { date: string; dte: number } | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const withDte = dates
    .filter((d) => d > currentExpiry)
    .map((d) => ({
      date: d,
      dte: Math.round((new Date(d + "T00:00:00").getTime() - today.getTime()) / 86_400_000),
    }));

  const window = withDte.filter(({ dte }) => dte >= 21 && dte <= 60);
  if (window.length > 0) {
    window.sort((a, b) => a.dte - b.dte);
    return window[0];
  }

  const fallback = withDte.filter(({ dte }) => dte > 14);
  if (fallback.length === 0) return null;
  fallback.sort((a, b) => a.dte - b.dte);
  return fallback[0];
}

function buildRollOption(
  bid: number,
  ask: number,
  delta: number | null,
  strike: number,
  close_cost: number,
  capital: number,
  roll_dte: number,
): RollOption {
  const net_credit = bid - close_cost;
  const monthly_return_pct =
    capital > 0 && roll_dte > 0 ? (net_credit / capital) * (30 / roll_dte) * 100 : null;
  const mid = (bid + ask) / 2;
  const spread_pct = mid > 0 ? (ask - bid) / mid : 1;
  const is_liquid = spread_pct < LIQUID_SPREAD_PCT_THRESHOLD;
  return { strike, bid, ask, spread_pct, is_liquid, delta, net_credit, monthly_return_pct };
}

export async function buildRollOrHoldRows(
  positions: OptionsPosition[],
  capitalByTicker: Map<string, number>,
  liveMarks: Map<string, number>,
  liveAsks: Map<string, number>,
): Promise<RollOrHoldRow[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const nearExpiry = positions.filter((p) => {
    if (p.status !== "open") return false;
    const exp = new Date(p.expiration_date + "T00:00:00");
    const dte = Math.round((exp.getTime() - today.getTime()) / 86_400_000);
    return dte >= 0 && dte <= 14;
  });

  if (nearExpiry.length === 0) return [];

  return Promise.all(
    nearExpiry.map(async (pos): Promise<RollOrHoldRow> => {
      const exp = new Date(pos.expiration_date + "T00:00:00");
      const dte_remaining = Math.max(0, Math.round((exp.getTime() - today.getTime()) / 86_400_000));

      // CSP capital is always the strike (cash collateral) — independent of
      // whether you own shares. CC capital is the cost basis of the underlying
      // shares; if we don't know that, we can't compute hold/roll returns.
      const capital =
        pos.strategy === "cash_secured_put"
          ? pos.strike
          : capitalByTicker.get(pos.underlying) || null;

      const current_mark = liveMarks.get(pos.option_symbol) ?? null;
      const spot = liveMarks.get(pos.underlying) ?? null;

      const is_itm =
        spot == null
          ? null
          : pos.strategy === "cash_secured_put"
            ? spot < pos.strike
            : spot > pos.strike;

      const intrinsic =
        spot == null
          ? null
          : pos.strategy === "cash_secured_put"
            ? Math.max(0, pos.strike - spot)
            : Math.max(0, spot - pos.strike);

      const remaining_extrinsic =
        current_mark != null && intrinsic != null
          ? Math.max(0, current_mark - intrinsic)
          : null;

      const effectiveCapital = capital ?? 0;
      const ann_factor =
        dte_remaining > 0 ? Math.min(30 / dte_remaining, ANN_FACTOR_CAP) : 0;
      const hold_monthly_return_pct =
        remaining_extrinsic != null && dte_remaining > 0 && effectiveCapital > 0
          ? (remaining_extrinsic / effectiveCapital) * ann_factor * 100
          : null;
      const gamma_warning = dte_remaining <= GAMMA_WARNING_DTE;

      const base: Omit<RollOrHoldRow, "roll_expiration" | "roll_dte" | "same_strike" | "best_strike"> = {
        position: pos,
        dte_remaining,
        capital: effectiveCapital,
        current_mark,
        spot,
        is_itm,
        remaining_extrinsic,
        hold_monthly_return_pct,
        gamma_warning,
        iv_ratio: null,
      };

      if (!capital) {
        return { ...base, roll_expiration: null, roll_dte: null, same_strike: null, best_strike: null };
      }

      try {
        const expirations = await getExpirations(pos.underlying);
        const next = pickNextExpiration(expirations, pos.expiration_date);

        if (!next) {
          return { ...base, roll_expiration: null, roll_dte: null, same_strike: null, best_strike: null };
        }

        const chain = await getOptionChain(pos.underlying, next.date);
        const type = pos.strategy === "cash_secured_put" ? "put" : "call";
        const side = chain.filter((o) => o.option_type === type && o.bid > 0);

        // Buy-to-close fills at the ask, not mid. Fall back to a mid+10%
        // haircut when the market is closed and ask isn't quoted; final
        // fallback of 0 only kicks in when we have neither quote.
        const close_ask = liveAsks.get(pos.option_symbol) ?? null;
        const close_cost =
          close_ask ?? (current_mark != null ? current_mark * 1.1 : 0);

        // Same-strike roll
        const sameOpt = side.find((o) => o.strike === pos.strike);
        const same_strike: RollOption | null = sameOpt
          ? buildRollOption(sameOpt.bid, sameOpt.ask, sameOpt.delta, sameOpt.strike, close_cost, capital, next.dte)
          : null;

        // Best-delta roll (Δ-25 target)
        const deltaTarget = type === "put" ? -0.25 : 0.25;
        const withDelta = side.filter((o) => o.delta != null);
        let bestOpt = withDelta.length > 0
          ? withDelta.reduce((a, b) =>
              Math.abs((a.delta ?? 0) - deltaTarget) <= Math.abs((b.delta ?? 0) - deltaTarget) ? a : b,
            )
          : null;

        // If best delta lands on the same strike, try to find a distinct one
        if (bestOpt?.strike === pos.strike) {
          const others = withDelta.filter((o) => o.strike !== pos.strike);
          if (others.length > 0) {
            const alt = others.reduce((a, b) =>
              Math.abs((a.delta ?? 0) - deltaTarget) <= Math.abs((b.delta ?? 0) - deltaTarget) ? a : b,
            );
            bestOpt = alt;
          } else {
            bestOpt = null;
          }
        }

        const best_strike: RollOption | null = bestOpt
          ? buildRollOption(bestOpt.bid, bestOpt.ask, bestOpt.delta, bestOpt.strike, close_cost, capital, next.dte)
          : null;

        // IV regime: compare ATM mid_iv on the roll expiration to HV30 of the
        // underlying. >1 = options are "rich" (good for sellers), <1 = cheap.
        let iv_ratio: number | null = null;
        if (spot != null) {
          const atm = side.reduce<{ o: typeof side[number]; d: number } | null>((acc, o) => {
            if (o.mid_iv == null) return acc;
            const d = Math.abs(o.strike - spot);
            return acc == null || d < acc.d ? { o, d } : acc;
          }, null);
          const atmIv = atm?.o.mid_iv ?? null;
          if (atmIv != null && atmIv > 0) {
            const hv30 = await getHv30(pos.underlying);
            if (hv30 != null && hv30 > 0) {
              iv_ratio = (atmIv * 100) / hv30;
            }
          }
        }

        return { ...base, iv_ratio, roll_expiration: next.date, roll_dte: next.dte, same_strike, best_strike };
      } catch {
        return { ...base, roll_expiration: null, roll_dte: null, same_strike: null, best_strike: null };
      }
    }),
  );
}
