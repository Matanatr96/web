// NFL regular season week boundaries. Week 1 always starts on a Thursday.
// Add a new entry each season; weeks run Thu–Wed (7 days each).
const SEASON_STARTS: Record<number, string> = {
  2021: "2021-09-09",
  2022: "2022-09-08",
  2023: "2023-09-07",
  2024: "2024-09-05",
  2025: "2025-09-04",
};

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

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
