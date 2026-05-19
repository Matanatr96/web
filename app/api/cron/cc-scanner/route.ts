// Vercel cron endpoint — runs every 30 min during US market hours, scans
// holdings for covered-call opportunities at delta 0.15–0.30 that fit available
// (unpledged) shares, dedups against sent_alerts (4-hour window per
// (ticker,strike,expiration), 5/day cap, independent from CSP cap), and emails
// the user.

import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { scanHoldingsForCcs, type CcRecommendation } from "@/lib/cc-scanner";
import { sendCcAlertEmail } from "@/lib/email";

const ALERT_TYPE = "covered_call";
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
};

async function fetchRecentAlerts(): Promise<SentAlertRow[]> {
  const supabase = getServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("sent_alerts")
    .select("ticker,strike,expiration,sent_at")
    .eq("alert_type", ALERT_TYPE)
    .gte("sent_at", since);
  if (error) {
    console.error("[cc-scanner] sent_alerts fetch", error);
    return [];
  }
  return (data ?? []) as SentAlertRow[];
}

function dedupKey(ticker: string, strike: number, expiration: string): string {
  return `${ticker}|${strike}|${expiration}`;
}

function filterAndCap(
  recs: CcRecommendation[],
  recent: SentAlertRow[],
): CcRecommendation[] {
  const cutoff = Date.now() - DEDUP_HOURS * 60 * 60 * 1000;
  const recentKeys = new Set(
    recent
      .filter((r) => new Date(r.sent_at).getTime() >= cutoff)
      .filter((r) => r.strike != null && r.expiration != null)
      .map((r) => dedupKey(r.ticker, r.strike!, r.expiration!)),
  );
  return recs.filter(
    (r) => !recentKeys.has(dedupKey(r.ticker, r.strike, r.expiration)),
  );
}

async function logSent(recs: CcRecommendation[]): Promise<void> {
  if (recs.length === 0) return;
  const supabase = getServiceClient();
  const rows = recs.map((r) => ({
    ticker: r.ticker,
    alert_type: ALERT_TYPE,
    strike: r.strike,
    expiration: r.expiration,
    payload: r as unknown as Record<string, unknown>,
  }));
  const { error } = await supabase.from("sent_alerts").insert(rows);
  if (error) console.error("[cc-scanner] sent_alerts insert", error);
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
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const sentTodayCount = recent.filter(
    (r) => new Date(r.sent_at).getTime() >= todayStart.getTime(),
  ).length;
  const distinctSendTimes = new Set(
    recent
      .filter((r) => new Date(r.sent_at).getTime() >= todayStart.getTime())
      .map((r) => r.sent_at.slice(0, 16)),
  );
  if (!force && distinctSendTimes.size >= DAILY_CAP) {
    return NextResponse.json({ skipped: "daily_cap_reached", sent_today: sentTodayCount });
  }

  const scan = await scanHoldingsForCcs();
  if (scan.recommendations.length === 0) {
    return NextResponse.json({ ok: true, recommendations: 0 });
  }

  const fresh = filterAndCap(scan.recommendations, recent);
  if (fresh.length === 0) {
    return NextResponse.json({ ok: true, recommendations: 0, skipped: "all_deduped" });
  }

  const top = fresh.slice(0, 8);

  const to = process.env.ALERT_TO_EMAIL;
  if (!to) {
    return NextResponse.json({ error: "ALERT_TO_EMAIL not set", recommendations: top.length }, { status: 500 });
  }

  const send = await sendCcAlertEmail(to, top);
  if (!send) {
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }

  await logSent(top);

  return NextResponse.json({
    ok: true,
    sent: top.length,
    email_id: send.id,
  });
}
