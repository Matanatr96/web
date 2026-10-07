// NFL regular season week boundaries. Week 1 always starts on a Thursday.
// Add a new entry each season; weeks run Thu–Wed (7 days each).
const SEASON_STARTS: Record<number, string> = {
  2021: "2021-09-09",
  2022: "2022-09-08",
  2023: "2023-09-07",
  2024: "2024-09-05",
  2025: "2025-09-04",
  2026: "2026-09-10",
};

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Computes the end timestamp (exclusive) for a given NFL regular-season week.
 * Each NFL week spans 7 days (Thursday through Wednesday) starting from the
 * season's kickoff Thursday in `SEASON_STARTS`.
 *
 * @param season - Four-digit NFL season year (e.g., 2026).
 * @param week - 1-indexed regular-season week number (1–18).
 * @returns The `Date` when the specified week ends, or `null` if the season is unknown.
 */
export function nflWeekEnd(season: number, week: number): Date | null {
  const startStr = SEASON_STARTS[season];
  if (!startStr) return null;
  const start = new Date(startStr).getTime();
  return new Date(start + week * MS_PER_WEEK);
}

/**
 * Maps a Unix epoch millisecond timestamp to its corresponding NFL regular-season
 * `(season, week)` tuple (weeks 1–18). Returns `null` for timestamps outside the
 * regular season or for unconfigured seasons.
 *
 * @param timestampMs - Unix timestamp in milliseconds.
 * @returns The matching `{ season, week }` or `null` if outside regular-season bounds.
 */
export function timestampToNflWeek(
  timestampMs: number,
): { season: number; week: number } | null {
  for (const [seasonStr, startStr] of Object.entries(SEASON_STARTS).sort(
    (a, b) => Number(b[0]) - Number(a[0]),
  )) {
    const season = Number(seasonStr);
    const start = new Date(startStr).getTime();
    if (timestampMs < start) continue;
    const week = Math.floor((timestampMs - start) / MS_PER_WEEK) + 1;
    // Regular season is weeks 1–18; ignore offseason messages.
    if (week < 1 || week > 18) return null;
    return { season, week };
  }
  return null;
}
