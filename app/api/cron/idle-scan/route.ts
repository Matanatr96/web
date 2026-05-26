// Combined idle-scan cron endpoint.
//
// The GitHub Actions workflow hits this endpoint every 15 min as a heartbeat.
// The actual cadence + caps are read from the `scanner_config` Supabase row,
// which is editable from /admin/scanner. Each invocation logs an entry to
// `scanner_runs` so the UI can show recent activity.

import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { scanWatchlistForCsps, type CspRecommendation } from "@/lib/csp-scanner";
import { scanHoldingsForCcs, type CcRecommendation } from "@/lib/cc-scanner";
import { sendCombinedAlertEmail } from "@/lib/email";
import {
  getScannerConfig,
  getLastSuccessfulRun,
  logScannerRun,
  type ScannerConfig,
} from "@/lib/scanner-config";

function isMarketHoursET(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

type SentAlertRow = {
  ticker: string;
  strike: number | null;
  expiration: string | null;
  sent_at: string;
  alert_type: string;
};

async function fetchRecentAlerts(): Promise<SentAlertRow[]> {
  const supabase = getServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("sent_alerts")
    .select("ticker,strike,expiration,sent_at,alert_type")
    .in("alert_type", ["idle_capital", "covered_call"])
    .gte("sent_at", since);
  if (error) {
    console.error("[idle-scan] sent_alerts fetch", error);
    return [];
  }
  return (data ?? []) as SentAlertRow[];
}

function dedupKey(ticker: string, strike: number, expiration: string): string {
  return `${ticker}|${strike}|${expiration}`;
}

function filterCsps(
  recs: CspRecommendation[],
  recent: SentAlertRow[],
  dedupHours: number,
): CspRecommendation[] {
  const cutoff = Date.now() - dedupHours * 60 * 60 * 1000;
  const seen = new Set(
    recent
      .filter((r) => r.alert_type === "idle_capital" && new Date(r.sent_at).getTime() >= cutoff)
      .filter((r) => r.strike != null && r.expiration != null)
      .map((r) => dedupKey(r.ticker, r.strike!, r.expiration!)),
  );
  return recs.filter((r) => !seen.has(dedupKey(r.ticker, r.strike, r.expiration)));
}

function filterCcs(
  recs: CcRecommendation[],
  recent: SentAlertRow[],
  dedupHours: number,
): CcRecommendation[] {
  const cutoff = Date.now() - dedupHours * 60 * 60 * 1000;
  const seen = new Set(
    recent
      .filter((r) => r.alert_type === "covered_call" && new Date(r.sent_at).getTime() >= cutoff)
      .filter((r) => r.strike != null && r.expiration != null)
      .map((r) => dedupKey(r.ticker, r.strike!, r.expiration!)),
  );
  return recs.filter((r) => !seen.has(dedupKey(r.ticker, r.strike, r.expiration)));
}

async function logSent(
  cspRecs: CspRecommendation[],
  ccRecs: CcRecommendation[],
): Promise<void> {
  if (cspRecs.length === 0 && ccRecs.length === 0) return;
  const supabase = getServiceClient();
  const rows = [
    ...cspRecs.map((r) => ({
      ticker: r.ticker,
      alert_type: "idle_capital",
      strike: r.strike,
      expiration: r.expiration,
      payload: r as unknown as Record<string, unknown>,
    })),
    ...ccRecs.map((r) => ({
      ticker: r.ticker,
      alert_type: "covered_call",
      strike: r.strike,
      expiration: r.expiration,
      payload: r as unknown as Record<string, unknown>,
    })),
  ];
  const { error } = await supabase.from("sent_alerts").insert(rows);
  if (error) console.error("[idle-scan] sent_alerts insert", error);
}

/**
 * Has enough time elapsed since the last successful (or no-pick) scan to run
 * again, given the configured interval? Forced runs bypass this check.
 */
async function intervalElapsed(config: ScannerConfig): Promise<boolean> {
  const last = await getLastSuccessfulRun();
  if (!last) return true;
  const elapsedMs = Date.now() - new Date(last.ran_at).getTime();
  // Allow a small grace window (60s) so a heartbeat that fires slightly early
  // doesn't get skipped on the boundary.
  return elapsedMs + 60_000 >= config.scan_interval_min * 60 * 1000;
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const url = new URL(req.url);
    const querySecret = url.searchParams.get("secret");
    const headerOk = authHeader === `Bearer ${expected}`;
    const queryOk = querySecret === expected;
    if (!headerOk && !queryOk) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const config = await getScannerConfig();

  if (!config.enabled && !force) {
    await logScannerRun({ outcome: "disabled", forced: false });
    return NextResponse.json({ skipped: "disabled" });
  }

  if (!force && !isMarketHoursET()) {
    // Don't spam the log every 15 min outside market hours — only log a single
    // skip per heartbeat call when the scanner is on but the market is closed.
    return NextResponse.json({ skipped: "market_closed" });
  }

  if (!force && !(await intervalElapsed(config))) {
    return NextResponse.json({ skipped: "interval_not_elapsed" });
  }

  const recent = await fetchRecentAlerts();

  // Daily cap: count distinct send-minute batches across both alert types today.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const distinctSendTimes = new Set(
    recent
      .filter((r) => new Date(r.sent_at).getTime() >= todayStart.getTime())
      .map((r) => r.sent_at.slice(0, 16)),
  );
  if (!force && distinctSendTimes.size >= config.daily_email_cap) {
    await logScannerRun({ outcome: "daily_cap", forced: false });
    return NextResponse.json({ skipped: "daily_cap_reached" });
  }

  // Run both scans in parallel.
  const [cspScan, ccScan] = await Promise.all([
    scanWatchlistForCsps(),
    scanHoldingsForCcs(),
  ]);

  const freshCsps = filterCsps(cspScan.recommendations, recent, config.dedup_hours)
    .slice(0, config.max_per_type);
  const freshCcs = filterCcs(ccScan.recommendations, recent, config.dedup_hours)
    .slice(0, config.max_per_type);

  if (freshCsps.length === 0 && freshCcs.length === 0) {
    await logScannerRun({ outcome: "no_picks", forced: force });
    return NextResponse.json({ ok: true, csps: 0, ccs: 0, skipped: "all_deduped" });
  }

  const to = process.env.ALERT_TO_EMAIL;
  if (!to) {
    await logScannerRun({ outcome: "error", forced: force, detail: "ALERT_TO_EMAIL not set" });
    return NextResponse.json({ error: "ALERT_TO_EMAIL not set" }, { status: 500 });
  }

  const send = await sendCombinedAlertEmail(to, cspScan.buying_power, freshCsps, freshCcs);
  if (!send) {
    await logScannerRun({ outcome: "error", forced: force, detail: "send_failed" });
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }

  await logSent(freshCsps, freshCcs);
  await logScannerRun({
    outcome: "sent",
    csps: freshCsps.length,
    ccs: freshCcs.length,
    forced: force,
  });

  return NextResponse.json({
    ok: true,
    csps: freshCsps.length,
    ccs: freshCcs.length,
    buying_power: cspScan.buying_power,
    email_id: send.id,
  });
}
