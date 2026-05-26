"use client";

import { useState, useTransition } from "react";
import type { CspRecommendation, CspDiagnostics } from "@/lib/csp-scanner";
import type { CcRecommendation, CcDiagnostics } from "@/lib/cc-scanner";
import type { ScanMetrics } from "@/lib/scan-metrics";

type PreviewResponse = {
  ran_at: string;
  buying_power: number;
  csps: CspRecommendation[];
  ccs: CcRecommendation[];
  csp_diagnostics: CspDiagnostics;
  cc_diagnostics: CcDiagnostics;
  csp_metrics: ScanMetrics | null;
};

const OUTCOME_LABELS: Record<string, string> = {
  ok: "picked",
  no_quote: "no quote",
  no_expiration: "no usable expiry",
  no_band_candidate: "no contract in delta band passing liquidity",
  capital_too_low: "capital too low",
  concentration_reject: "concentration over limit",
  below_basis: "all candidates below cost basis",
  error: "error",
};

export default function PreviewPicks() {
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();

  function run() {
    setErr(null);
    startLoad(async () => {
      const resp = await fetch("/api/scanner/preview", { method: "POST" });
      const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      if (!resp.ok) {
        setErr(typeof json.error === "string" ? json.error : `error ${resp.status}`);
        return;
      }
      setData(json as unknown as PreviewResponse);
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Preview picks</h2>
          <p className="text-xs text-stone-500 mt-0.5">
            Runs both scans and shows the raw ranked output. Does not send email
            or affect the dedup window.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
        >
          {loading ? "Scanning…" : data ? "Re-run" : "Preview now"}
        </button>
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}

      {data && (
        <div className="space-y-6">
          <div className="text-xs text-stone-500">
            Ran at {new Date(data.ran_at).toLocaleString()} ·
            {" "}option BP ${data.buying_power.toLocaleString()}
          </div>

          <DiagnosticsPanel
            title={`CSP scan — ${data.csp_diagnostics.watchlist_size} tickers on watchlist`}
            outcomes={data.csp_diagnostics.outcomes as Record<string, number>}
            perTicker={data.csp_diagnostics.per_ticker as Array<{ ticker: string; outcome: string; detail?: string }>}
          />

          <PicksTable
            title={`CSPs (${data.csps.length})`}
            rows={data.csps.map((r) => ({
              ticker: r.ticker,
              contract: `$${r.strike}P ${r.expiration}`,
              premium: r.premium_per_contract,
              ann: r.annualized_yield_pct,
              delta: r.delta,
              dte: r.dte,
              capital: r.collateral,
              capitalLabel: "Collateral",
              score: r.rank_score,
              reason: r.rank_reason,
              source: r.source,
            }))}
          />

          {data.csp_diagnostics.discovery && (
            <DiscoveryStats discovery={data.csp_diagnostics.discovery} />
          )}

          {data.csp_metrics && <MetricsPanel metrics={data.csp_metrics} />}

          <DiagnosticsPanel
            title={`CC scan — ${data.cc_diagnostics.uncovered_tickers} tickers with 100+ uncovered shares`}
            outcomes={data.cc_diagnostics.outcomes as Record<string, number>}
            perTicker={data.cc_diagnostics.per_ticker as Array<{ ticker: string; outcome: string; detail?: string }>}
          />

          <PicksTable
            title={`CCs (${data.ccs.length})`}
            rows={data.ccs.map((r) => ({
              ticker: r.ticker,
              contract: `$${r.strike}C ${r.expiration}`,
              premium: r.premium_per_contract,
              ann: r.annualized_yield_pct,
              delta: r.delta,
              dte: r.dte,
              capital: r.strike * 100,
              capitalLabel: "Shares value",
              score: r.rank_score,
              reason: r.rank_reason,
            }))}
          />
        </div>
      )}
    </div>
  );
}

type Row = {
  ticker: string;
  contract: string;
  premium: number;
  ann: number;
  delta: number;
  dte: number;
  capital: number;
  capitalLabel: string;
  score: number;
  reason: string;
  source?: "watchlist" | "discovered";
};

function scoreColor(score: number): string {
  if (score >= 70) return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (score >= 40) return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300";
}

function DiagnosticsPanel({
  title,
  outcomes,
  perTicker,
}: {
  title: string;
  outcomes: Record<string, number>;
  perTicker: Array<{ ticker: string; outcome: string; detail?: string }>;
}) {
  const summary = Object.entries(outcomes)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${OUTCOME_LABELS[k] ?? k}`)
    .join(" · ");

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-4">
      <div className="text-sm font-medium mb-1">{title}</div>
      <div className="text-xs text-stone-500 mb-3">{summary || "no tickers"}</div>
      {perTicker.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-stone-500 hover:text-stone-700 dark:hover:text-stone-300">
            Per-ticker outcome
          </summary>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-y-1 gap-x-4">
            {perTicker.map((p) => (
              <div key={p.ticker} className="flex items-baseline justify-between gap-2 border-b border-stone-100 dark:border-stone-900 py-0.5">
                <span className="font-medium">{p.ticker}</span>
                <span className="text-stone-500 text-right">
                  {OUTCOME_LABELS[p.outcome] ?? p.outcome}
                  {p.detail && <span className="ml-1 text-stone-400">({p.detail})</span>}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PicksTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div>
      <h3 className="text-sm font-medium mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No picks.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 dark:bg-stone-900 text-stone-600 dark:text-stone-400">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Ticker</th>
                <th className="text-left px-3 py-2 font-medium">Contract</th>
                <th className="text-right px-3 py-2 font-medium">Premium</th>
                <th className="text-right px-3 py-2 font-medium">Ann.</th>
                <th className="text-right px-3 py-2 font-medium">Δ</th>
                <th className="text-right px-3 py-2 font-medium">DTE</th>
                <th className="text-right px-3 py-2 font-medium">{rows[0]?.capitalLabel}</th>
                <th className="text-right px-3 py-2 font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ticker}-${i}`} className="border-t border-stone-200 dark:border-stone-800 align-top">
                  <td className="px-3 py-2 font-medium">
                    {r.ticker}
                    {r.source === "discovered" && (
                      <span className="ml-1.5 inline-block px-1.5 py-0.5 text-[10px] font-medium rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 align-middle">
                        discovered
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {r.contract}
                    <div className="text-xs text-stone-500 italic mt-0.5 max-w-md whitespace-normal">
                      {r.reason}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">${r.premium.toFixed(0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.ann.toFixed(0)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.delta.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.dte}d</td>
                  <td className="px-3 py-2 text-right tabular-nums">${r.capital.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${scoreColor(r.score)}`}>
                      {Math.round(r.score)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DiscoveryStats({
  discovery,
}: {
  discovery: { universe_size: number; after_stage1: number; after_stage2: number; selected: number };
}) {
  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-4">
      <div className="text-sm font-medium mb-1">Discovery funnel</div>
      <div className="text-xs text-stone-500">
        {discovery.universe_size} in universe → {discovery.after_stage1} affordable → {" "}
        {discovery.after_stage2} ranked → {discovery.selected} fed to full scan
      </div>
    </div>
  );
}

function MetricsPanel({
  metrics,
}: {
  metrics: {
    api_calls_total: number;
    api_calls_by_endpoint: Record<string, number>;
    rate_limit_hits: number;
    rate_limit_remaining_min: number | null;
  };
}) {
  const byEndpoint = Object.entries(metrics.api_calls_by_endpoint).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-4">
      <div className="text-sm font-medium mb-1">
        API budget
        {metrics.rate_limit_hits > 0 && (
          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 align-middle">
            {metrics.rate_limit_hits} × 429
          </span>
        )}
      </div>
      <div className="text-xs text-stone-500 mb-2">
        {metrics.api_calls_total} Tradier calls
        {metrics.rate_limit_remaining_min != null && (
          <> · min remaining {metrics.rate_limit_remaining_min}</>
        )}
      </div>
      {byEndpoint.length > 0 && (
        <div className="text-xs text-stone-500 flex flex-wrap gap-x-3 gap-y-1">
          {byEndpoint.map(([k, n]) => (
            <span key={k}>
              <span className="text-stone-400">{k}</span> {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
