# Movement-trigger alerts — v2 spec

Parked here while v1 (idle-capital scanner) ships first. Once v1 is firing and
tuned, this is the next layer to add.

## Goal

Alert when watchlist tickers (or held positions without a CC) move in ways that
signal a productive entry for a CSP or CC. Distinct from v1 ("you have $X idle
— here's where to deploy it") in that the trigger here is *price/IV regime
change*, not capital availability.

## Recommended v2 starter rules

Two rules, both gated by anti-signal filters. Keep it small initially.

### Rule A — "Premium-rich, single name"

```
IVR ≥ 50
AND no earnings within 7 calendar days
AND no ex-dividend within 3 days
AND price > 200-day moving average
```

Captures slow-burn IV regimes — the bread-and-butter wheel income setup.

### Rule B — "Panic entry"

```
1-day return ≤ -3%
AND IVR ≥ 30
AND VIX < 35
AND no earnings within 7 days
```

Captures the rare-but-valuable "fat pitch" days where IV expansion creates
unusually rich premium on names you already wanted to own.

## Why these signals (and not others)

- **IV Rank over IV Percentile.** IVR responds to regime changes (what a
  premium seller cares about). IVP overweights base-rate behavior and tends to
  flag stocks that just sit quietly at slightly-elevated IV.
- **1-day drop ≥ 3%** is high signal because it actually moves IVR. Multi-day
  grinding selloffs often *suppress* IV (low realized day-to-day).
- **RSI < 30** is moderate signal — it's a confirming indicator, not a primary
  one. Useful as a tiebreaker.
- **Put/call ratio, unusual options flow** — mostly noise for a delta-0.10–0.20
  retail seller. Skip in v2; revisit if data warrants.
- **52-week-high distance** — weak as a standalone signal. Captures broken
  stocks, not premium-rich opportunities.

## Anti-signals (always suppress)

- **Earnings within 7 days** — IV is high for a *reason* (binary event); not
  the edge you want for a wheel position.
- **Ex-dividend within DTE** — distorts pricing, complicates assignment math.
- **FDA PDUFA / known binary catalyst within DTE** — biotech, M&A vote, court
  ruling.
- **Confirmed downtrend** (price < 200-day MA AND 50-day MA sloping down) —
  wheel works on names you'd own; broken trends compound assignment pain.
- **VIX > 35** — macro panic; single-name IVR signals are misleading when
  correlations go to 1.

## Implementation notes

- Earnings dates: add a daily sync from a free source (e.g. Finnhub free tier
  or scrape Yahoo earnings calendar). Cache in Supabase as `earnings_dates`.
- Ex-div dates: Tradier's quotes endpoint surfaces `ex_dividend_date` already.
- 200-day MA + 50-day MA: derive from existing daily history fetch in
  `quotes.ts` (`fetchPriceHistoryCached`). Already cached 4h.
- IV Rank: compute as `(current_iv - min_iv_52w) / (max_iv_52w - min_iv_52w)`.
  Requires a 252-day IV history table — either backfill from Tradier history
  (if available) or sample forward starting now.
- VIX: fetch `^VIX` quote (Tradier supports it).

## Open questions for v2 kickoff

1. Do we want a third "term-structure backwardation" rule (front-month IV >
   back-month IV)? Higher signal but more complex to compute.
2. Should the panic-entry rule lower its IVR floor (e.g. ≥ 20) given that a
   sharp drop is itself an IV-expansion signal?
3. Should v2 alerts batch into the same email as v1 idle-capital alerts, or
   separate channels? Probably batch — single morning digest.

## Citations

Synthesized from tastytrade "Market Measures" research on IVR thresholds, the
r/thetagang sidebar consensus, and academic literature on the variance risk
premium (Bondarenko 2014 and related). Citations to specific episodes /
papers are pending — re-run research with web search enabled before
implementing.
