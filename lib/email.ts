import { Resend } from "resend";
import type { CspRecommendation } from "@/lib/csp-scanner";

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

function fmtMoney(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtPct(v: number, digits = 1): string {
  return `${v.toFixed(digits)}%`;
}

function row(rec: CspRecommendation): string {
  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${rec.ticker}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">$${rec.strike}P ${rec.expiration}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmtMoney(rec.premium_per_contract)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#16a34a;font-weight:600">${fmtPct(rec.annualized_yield_pct, 0)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">Δ${rec.delta.toFixed(2)} · ${rec.dte}d</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmtMoney(rec.collateral)}</td>
    </tr>`;
}

export function renderAlertHtml(buyingPower: number, recs: CspRecommendation[]): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;color:#1c1917">
    <h2 style="margin:0 0 4px 0">Idle capital scan</h2>
    <p style="margin:0 0 16px 0;color:#78716c;font-size:14px">
      ${fmtMoney(buyingPower)} option buying power · ${recs.length} CSP${recs.length === 1 ? "" : "s"} in the 0.10–0.20 delta band
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #eee">
      <thead>
        <tr style="background:#fafaf9">
          <th style="padding:8px 12px;text-align:left;font-weight:600">Ticker</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Contract</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Premium</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Ann. yield</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Δ · DTE</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Collateral</th>
        </tr>
      </thead>
      <tbody>
        ${recs.map(row).join("")}
      </tbody>
    </table>
    <p style="margin:16px 0 0 0;color:#a8a29e;font-size:12px">
      Ranked by annualized yield. Liquidity-filtered (spread ≤ 30% of mid). Sent because your buying power exceeded the strike collateral for these contracts.
    </p>
  </div>`;
}

export function renderAlertSubject(recs: CspRecommendation[]): string {
  if (recs.length === 0) return "Idle capital scan";
  const top = recs[0];
  return `Idle capital: ${recs.length} CSP${recs.length === 1 ? "" : "s"} · top ${top.ticker} ${fmtPct(top.annualized_yield_pct, 0)} ann.`;
}

export async function sendAlertEmail(
  to: string,
  buyingPower: number,
  recs: CspRecommendation[],
): Promise<{ id: string } | null> {
  const client = getResend();
  if (!client) {
    console.warn("[email] RESEND_API_KEY not set — skipping send");
    return null;
  }
  const from = process.env.ALERT_FROM_EMAIL || "alerts@onresend.dev";
  const { data, error } = await client.emails.send({
    from,
    to,
    subject: renderAlertSubject(recs),
    html: renderAlertHtml(buyingPower, recs),
  });
  if (error) {
    console.error("[email] resend error", error);
    return null;
  }
  return data ? { id: data.id } : null;
}
