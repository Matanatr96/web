import type { OptionsTrade, OptionStrategy } from "@/lib/types";

// One week-bucket in the yield calendar.
export type YieldWeek = {
  // ISO week key like "2025-W03" for stable identity.
  isoKey: string;
  // Monday (UTC) date string YYYY-MM-DD that anchors this week.
  weekStart: string;
  // Sunday (UTC) date string YYYY-MM-DD.
  weekEnd: string;
  // Sum of premium collected for sell-to-open contracts opened in this week.
  premium: number;
  // Number of sell-to-open contracts opened this week (sum of quantity).
  contracts: number;
  // Distinct tickers traded.
  tickers: string[];
  // Strategy -> contract count (qty).
  strategies: Partial<Record<OptionStrategy, number>>;
  // Win-rate inputs: only for sell-to-open contracts opened this week that have
  // since reached a closed/expired/assigned state.
  closedCount: number;
  wins: number; // closed-profitable (closed via buy-to-close) + expired-worthless
  winRate: number | null; // null when closedCount === 0
};

// Build a fixed-length grid for the trailing `weeks` weeks ending with the
// ISO week of `endDate` (UTC). The returned array is chronological.
export function buildYieldCalendar(
  trades: OptionsTrade[],
  options: { weeks?: number; endDate?: Date } = {},
): YieldWeek[] {
  const weeks = options.weeks ?? 52;
  const endDate = options.endDate ?? new Date();

  // Build the grid of week anchors first so empty weeks render correctly.
  const lastMonday = isoWeekMonday(endDate);
  const grid: YieldWeek[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const monday = new Date(lastMonday);
    monday.setUTCDate(lastMonday.getUTCDate() - i * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    grid.push({
      isoKey: isoWeekKey(monday),
      weekStart: ymd(monday),
      weekEnd: ymd(sunday),
      premium: 0,
      contracts: 0,
      tickers: [],
      strategies: {},
      closedCount: 0,
      wins: 0,
      winRate: null,
    });
  }

  const byKey = new Map<string, YieldWeek>(grid.map((w) => [w.isoKey, w]));
  const tickerSets = new Map<string, Set<string>>(
    grid.map((w) => [w.isoKey, new Set<string>()]),
  );
  // Maps option_symbol -> open-week isoKey so buy-to-close costs can be
  // deducted from the week the position was opened rather than closed.
  const openWeekBySymbol = new Map<string, string>();

  for (const t of trades) {
    if (t.side !== "sell_to_open") continue;
    const orderDate = parseOrderDate(t.order_date);
    if (!orderDate) continue;
    const key = isoWeekKey(orderDate);
    const bucket = byKey.get(key);
    if (!bucket) continue; // outside our trailing window

    const qty = Number(t.quantity) || 0;
    const fill = Number(t.avg_fill_price) || 0;
    const premium = fill * qty * 100;
    if (Number.isFinite(premium)) bucket.premium += premium;
    bucket.contracts += qty;

    tickerSets.get(key)!.add(t.underlying);
    bucket.strategies[t.strategy] = (bucket.strategies[t.strategy] ?? 0) + qty;
    openWeekBySymbol.set(t.option_symbol, key);

    // Win-rate: count this sell-to-open contract once it has a terminal status.
    const status = (t.status ?? "").toLowerCase();
    if (isClosedStatus(status)) {
      bucket.closedCount += qty;
      if (isWinStatus(status)) bucket.wins += qty;
    }
  }

  // Subtract buy-to-close costs from the week the position was opened.
  for (const t of trades) {
    if (t.side !== "buy_to_close") continue;
    const openKey = openWeekBySymbol.get(t.option_symbol);
    if (!openKey) continue;
    const bucket = byKey.get(openKey);
    if (!bucket) continue;
    const qty = Number(t.quantity) || 0;
    const fill = Number(t.avg_fill_price) || 0;
    const cost = fill * qty * 100;
    if (Number.isFinite(cost)) bucket.premium -= cost;
  }

  for (const w of grid) {
    w.tickers = Array.from(tickerSets.get(w.isoKey) ?? []).sort();
    w.winRate = w.closedCount > 0 ? w.wins / w.closedCount : null;
  }

  return grid;
}

// Sell-to-open is "won" when it expires worthless or is bought back (closed).
// Brokers report these as "expired" or "filled"/"closed"; we accept any closed
// status other than "assigned" as a win since assignment means it went ITM.
function isClosedStatus(status: string): boolean {
  return (
    status === "expired" ||
    status === "filled" ||
    status === "closed" ||
    status === "assigned"
  );
}

function isWinStatus(status: string): boolean {
  // Anything closed that isn't assignment counts as keeping the premium.
  return status === "expired" || status === "filled" || status === "closed";
}

// --- ISO week helpers (UTC) -------------------------------------------------

// Returns the Monday (UTC) of the ISO week containing `d`.
export function isoWeekMonday(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO: Monday = 1, Sunday = 7
  const dow = date.getUTCDay() || 7;
  if (dow !== 1) date.setUTCDate(date.getUTCDate() - (dow - 1));
  return date;
}

// Returns ISO week key "YYYY-Www" for a date (UTC).
export function isoWeekKey(d: Date): string {
  // Algorithm per https://en.wikipedia.org/wiki/ISO_week_date
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = date.getUTCDay() || 7;
  // Move to Thursday of this week — defines the ISO year.
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function parseOrderDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Compute the Nth percentile of premium across non-zero weeks.
export function premiumPercentile(weeks: YieldWeek[], pct: number): number {
  const values = weeks.map((w) => w.premium).filter((v) => v > 0).sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const idx = Math.min(values.length - 1, Math.floor((pct / 100) * values.length));
  return values[idx];
}

// Human strategy labels matching the rest of the UI.
export const STRATEGY_SHORT: Record<OptionStrategy, string> = {
  covered_call: "CC",
  cash_secured_put: "CSP",
  long_call: "LC",
  long_put: "LP",
};
