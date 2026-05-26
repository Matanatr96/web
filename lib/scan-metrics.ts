// Per-scan API call + rate-limit counter.
//
// `lib/quotes.ts` increments these counters as it makes Tradier calls. The
// CSP scanner snapshots them into the scan result so the admin UI / cron logs
// can show how much of our rate-limit budget the run used and whether we hit
// any 429s. We use a single module-level counter (not AsyncLocalStorage)
// because scans don't overlap in practice — the cron route serializes them
// via `intervalElapsed` and admin preview is single-user.

export type ScanMetrics = {
  api_calls_total: number;
  api_calls_by_endpoint: Record<string, number>;
  rate_limit_hits: number;
  rate_limit_remaining_min: number | null;  // min of X-Ratelimit-Available across run
};

let active: ScanMetrics | null = null;

export function startScanMetrics(): void {
  active = {
    api_calls_total: 0,
    api_calls_by_endpoint: {},
    rate_limit_hits: 0,
    rate_limit_remaining_min: null,
  };
}

export function recordApiCall(endpoint: string, status: number, remaining: number | null): void {
  if (!active) return;
  active.api_calls_total += 1;
  active.api_calls_by_endpoint[endpoint] = (active.api_calls_by_endpoint[endpoint] ?? 0) + 1;
  if (status === 429) {
    active.rate_limit_hits += 1;
    console.warn(`[scan-metrics] 429 on ${endpoint}`);
  }
  if (remaining != null) {
    active.rate_limit_remaining_min =
      active.rate_limit_remaining_min == null
        ? remaining
        : Math.min(active.rate_limit_remaining_min, remaining);
  }
}

export function finishScanMetrics(): ScanMetrics | null {
  const out = active;
  active = null;
  return out;
}

// Lightweight concurrency limiter — runs at most `limit` tasks at a time.
// Inline so we don't add a `p-limit` dependency for a 20-line helper.
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
