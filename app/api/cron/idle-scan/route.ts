// Combined idle-scan cron endpoint — runs every 30 min during US market hours.
// Runs the CSP and CC scans in parallel, deduplicates each against their own
// sent_alerts rows, and sends ONE combined email when either scan has fresh picks.

import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { scanWatchlistForCsps, type CspRecommendation } from "@/lib/csp-scanner";
import { scanHoldingsForCcs, type CcRecommendation } from "@/lib/cc-scanner";
import { sendCombinedAlertEmail } from "@/lib/email";

const DEDUP_HOURS = 4;
const DAILY_CAP = 5;

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

function filterCsps(recs: CspRecommendation[], recent: SentAlertRow[]): CspRecommendation[] {
  const cutoff = Date.now() - DEDUP_HOURS * 60 * 60 * 1000;
  const seen = new Set(
    recent
      .filter((r) => r.alert_type === "idle_capital" && new Date(r.sent_at).getTime() >= cutoff)
      .filter((r) => r.strike != null && r.expiration != null)
      .map((r) => dedupKey(r.ticker, r.strike!, r.expiration!)),
  );
  return recs.filter((r) => !seen.has(dedupKey(r.ticker, r.strike, r.expiration)));
}

function filterCcs(recs: CcRecommendation[], recent: SentAlertRow[]): CcRecommendation[] {
  const cutoff = Date.now() - DEDUP_HOURS * 60 * 60 * 1000;
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

  if (!force && !isMarketHoursET()) {
    return NextResponse.json({ skipped: "market_closed" });
  }

  const recent = await fetchRecentAlerts();

  // Check daily cap — count distinct send-minute batches across both alert types today.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const distinctSendTimes = new Set(
    recent
      .filter((r) => new Date(r.sent_at).getTime() >= todayStart.getTime())
      .map((r) => r.sent_at.slice(0, 16)),
  );
  if (!force && distinctSendTimes.size >= DAILY_CAP) {
    return NextResponse.json({ skipped: "daily_cap_reached" });
  }

  // Run both scans in parallel.
  const [cspScan, ccScan] = await Promise.all([
    scanWatchlistForCsps(),
    scanHoldingsForCcs(),
  ]);

  const freshCsps = filterCsps(cspScan.recommendations, recent).slice(0, 8);
  const freshCcs = filterCcs(ccScan.recommendations, recent).slice(0, 8);

  if (freshCsps.length === 0 && freshCcs.length === 0) {
    return NextResponse.json({ ok: true, csps: 0, ccs: 0, skipped: "all_deduped" });
  }

  const to = process.env.ALERT_TO_EMAIL;
  if (!to) {
    return NextResponse.json({ error: "ALERT_TO_EMAIL not set" }, { status: 500 });
  }

  const send = await sendCombinedAlertEmail(to, cspScan.buying_power, freshCsps, freshCcs);
  if (!send) {
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }

  await logSent(freshCsps, freshCcs);

  return NextResponse.json({
    ok: true,
    csps: freshCsps.length,
    ccs: freshCcs.length,
    buying_power: cspScan.buying_power,
    email_id: send.id,
  });
}
