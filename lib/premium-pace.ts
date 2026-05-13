import type { TickerPnL } from "@/lib/types";

export type PremiumPaceData = {
  yourReturnPct: number;       // annualized, decimal (0.15 = 15%)
  spyReturnPct: number;        // annualized, decimal
  deltaPct: number;            // yourReturnPct - spyReturnPct
  totalGain: number;           // absolute dollars
  totalCapital: number;        // capital tied up
  daysElapsed: number;
  startDate: string;           // ISO date of first trade
};

export function computePremiumPace(
  pnl: TickerPnL[],
  spyHistory: { date: string; close: number }[],
  startDate: string,
): PremiumPaceData | null {
  if (pnl.length === 0 || spyHistory.length < 2) return null;

  const totalGain = pnl.reduce(
    (s, t) => s + t.options_realized_pl + t.options_open_premium + t.equity_realized_pl,
    0,
  );
  const totalCapital = pnl.reduce((s, t) => s + t.total_capital_tied_up, 0);

  if (totalCapital <= 0) return null;

  const start = new Date(startDate + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysElapsed = Math.max(
    1,
    (today.getTime() - start.getTime()) / 86_400_000,
  );

  const rawYourReturn = totalGain / totalCapital;
  const annualizedYour = rawYourReturn * (365 / daysElapsed);

  const spyStart = spyHistory[0].close;
  const spyEnd = spyHistory[spyHistory.length - 1].close;
  const rawSpyReturn = (spyEnd - spyStart) / spyStart;
  const annualizedSpy = rawSpyReturn * (365 / daysElapsed);

  return {
    yourReturnPct: annualizedYour,
    spyReturnPct: annualizedSpy,
    deltaPct: annualizedYour - annualizedSpy,
    totalGain,
    totalCapital,
    daysElapsed,
    startDate,
  };
}
