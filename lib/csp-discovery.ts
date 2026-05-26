// Discovery prefilter for the CSP scanner.
//
// Goal: surface tickers OUTSIDE the user's watchlist that are juicy CSP
// candidates right now, without blowing the Tradier rate-limit budget.
//
// Three-stage funnel:
//   Stage 1 (cheap, ~1 batched call): drop universe entries whose collateral
//           (price * 100) exceeds option BP. Pure quote filter.
//   Stage 2 (cheap-ish, 1 history call per survivor, 4h-cached): compute
//           IV/RV ratio + 20d realized vol via existing fetchHistoricalSignals,
//           rank by IV richness.
//   Stage 3 (expensive — handled by the scanner itself): top N survivors get
//           the full chain fetch + scoring path. Cap defaults to 30.
//
// Watchlist tickers are excluded so we don't double-score them.

import { getWatchlistQuotes, type StockQuote } from "@/lib/quotes";
import { fetchHistoricalSignals } from "@/lib/csp-ranking";
import { runWithConcurrency } from "@/lib/scan-metrics";
import universeRaw from "@/data/discovery_universe.json";

type UniverseEntry = { ticker: string; sector?: string };

const STAGE3_POOL_SIZE_DEFAULT = 30;
const STAGE2_CONCURRENCY = 5;

export type DiscoveryDiagnostics = {
  universe_size: number;
  after_stage1: number;
  after_stage2: number;
  selected: number;
};

export type DiscoveryResult = {
  tickers: string[];
  diagnostics: DiscoveryDiagnostics;
};

function loadUniverse(): UniverseEntry[] {
  return (universeRaw as UniverseEntry[]).filter((e) => !!e.ticker);
}

export async function findDiscoveryCandidates(opts: {
  buyingPower: number;
  excluded: Set<string>;
  poolSize?: number;
}): Promise<DiscoveryResult> {
  const universe = loadUniverse();
  const filtered = universe.filter((e) => !opts.excluded.has(e.ticker.toUpperCase()));
  const symbols = filtered.map((e) => e.ticker);

  const diagnostics: DiscoveryDiagnostics = {
    universe_size: universe.length,
    after_stage1: 0,
    after_stage2: 0,
    selected: 0,
  };

  if (symbols.length === 0 || opts.buyingPower <= 0) {
    return { tickers: [], diagnostics };
  }

  // -------- Stage 1: affordable + has a quote --------
  const quotes = await getWatchlistQuotes(symbols);
  const stage1: string[] = [];
  for (const sym of symbols) {
    const q: StockQuote | undefined = quotes.get(sym);
    if (!q?.last) continue;
    // Need ATM-ish collateral to fit BP. Use price * 100 as a coarse floor —
    // the real per-strike check happens later in the scanner.
    if (q.last * 100 > opts.buyingPower) continue;
    stage1.push(sym);
  }
  diagnostics.after_stage1 = stage1.length;
  if (stage1.length === 0) return { tickers: [], diagnostics };

  // -------- Stage 2: rank by IV richness (RV20 cone percentile) --------
  // fetchHistoricalSignals is 4h-cached, so subsequent scans within the day
  // pay ~0 API cost here. We rank on rv_cone_percentile because that's what
  // the downstream ranker uses for "rich vs cheap" — keeps the prefilter
  // honest with the final scorer.
  const scored = await runWithConcurrency(stage1, STAGE2_CONCURRENCY, async (ticker) => {
    try {
      const hist = await fetchHistoricalSignals(ticker);
      return { ticker, score: hist.rv_cone_percentile ?? 0 };
    } catch {
      return { ticker, score: 0 };
    }
  });

  const survivors = scored.filter((s) => s.score > 0);
  diagnostics.after_stage2 = survivors.length;

  survivors.sort((a, b) => b.score - a.score);
  const pool = (opts.poolSize ?? STAGE3_POOL_SIZE_DEFAULT);
  const selected = survivors.slice(0, pool).map((s) => s.ticker);
  diagnostics.selected = selected.length;

  return { tickers: selected, diagnostics };
}
