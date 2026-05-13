import type { RestaurantVisit } from "@/lib/types";
import { computeOverall } from "@/lib/utils";

/** Half-life for visit weighting, in days. A visit this old counts ~50% as
 *  much as a visit today; doubling the age halves it again. */
export const VISIT_HALF_LIFE_DAYS = 180;

type RatingKey = "food" | "value" | "service" | "ambiance" | "vegan_options";
const RATING_KEYS: RatingKey[] = ["food", "value", "service", "ambiance", "vegan_options"];

export type AggregatedRatings = {
  food: number | null;
  value: number | null;
  service: number | null;
  ambiance: number | null;
  vegan_options: number | null;
  overall: number | null;
};

/**
 * Recency-weighted mean of per-visit ratings. Visits get an exponential decay
 * weight `e^(-λ · days_ago)` where λ = ln(2) / half_life. Each dimension is
 * averaged independently — null values on a given visit are skipped (they
 * don't contribute to that dimension's denominator).
 *
 * Returns nulls for any dimension where no visit supplied a value.
 */
export function weightedMeanRatings(
  visits: Pick<RestaurantVisit, "visited_on" | RatingKey>[],
  category: string,
  halfLifeDays: number = VISIT_HALF_LIFE_DAYS,
  now: Date = new Date(),
): AggregatedRatings {
  const lambda = Math.log(2) / halfLifeDays;
  const sums: Record<RatingKey, number> = { food: 0, value: 0, service: 0, ambiance: 0, vegan_options: 0 };
  const weights: Record<RatingKey, number> = { food: 0, value: 0, service: 0, ambiance: 0, vegan_options: 0 };

  for (const v of visits) {
    const days = Math.max(
      0,
      (now.getTime() - new Date(v.visited_on + "T00:00:00").getTime()) / 86400000,
    );
    const w = Math.exp(-lambda * days);
    for (const k of RATING_KEYS) {
      const val = v[k];
      if (val !== null && val !== undefined) {
        sums[k] += w * Number(val);
        weights[k] += w;
      }
    }
  }

  const out: AggregatedRatings = {
    food: weights.food > 0 ? round2(sums.food / weights.food) : null,
    value: weights.value > 0 ? round2(sums.value / weights.value) : null,
    service: weights.service > 0 ? round2(sums.service / weights.service) : null,
    ambiance: weights.ambiance > 0 ? round2(sums.ambiance / weights.ambiance) : null,
    vegan_options: weights.vegan_options > 0 ? round2(sums.vegan_options / weights.vegan_options) : null,
    overall: null,
  };
  out.overall = computeOverall(category, {
    food: out.food,
    value: out.value,
    service: out.service,
    ambiance: out.ambiance,
    vegan_options: out.vegan_options,
  });
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
