import { Resend } from "resend";
import type { CspRecommendation } from "@/lib/csp-scanner";
import type { CcRecommendation } from "@/lib/cc-scanner";

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

function row(rec: CspRecommendation, rank: number): string {
  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:none;color:#a8a29e;font-weight:600;width:24px">#${rank}</td>
      <td style="padding:8px 12px;border-bottom:none;font-weight:600">${rec.ticker}</td>
      <td style="padding:8px 12px;border-bottom:none">$${rec.strike}P ${rec.expiration}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right">${fmtMoney(rec.premium_per_contract)}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right;color:#16a34a;font-weight:600">${fmtPct(rec.annualized_yield_pct, 0)}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right">Δ${rec.delta.toFixed(2)} · ${rec.dte}d</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right">${fmtMoney(rec.collateral)}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right;font-weight:600">${rec.rank_score.toFixed(0)}</td>
    </tr>
    <tr>
      <td colspan="8" style="padding:0 12px 10px 44px;border-bottom:1px solid #eee;color:#78716c;font-size:12px;font-style:italic">${rec.rank_reason || "—"}</td>
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
          <th style="padding:8px 12px;text-align:left;font-weight:600">#</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Ticker</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Contract</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Premium</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Ann. yield</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Δ · DTE</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Collateral</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Score</th>
        </tr>
      </thead>
      <tbody>
        ${recs.map((r, i) => row(r, i + 1)).join("")}
      </tbody>
    </table>
    <p style="margin:16px 0 0 0;color:#a8a29e;font-size:12px">
      Ranked by composite score: yield, IV-vs-realized-vol gap, ATR-normalized cushion, put-OI dominance at strike, proximity to a technical level, and RV cone position. Modifiers: term-structure backwardation, ticker concentration vs option BP, and overlap with shares already held. Reason under each row shows the top drivers and any active caveats. Names already ≥${"25"}% of BP or with no bid-side depth are filtered out before ranking.
    </p>
  </div>`;
}

export function renderAlertSubject(recs: CspRecommendation[]): string {
  if (recs.length === 0) return "Idle capital scan";
  const top = recs[0];
  return `Idle capital: ${recs.length} CSP${recs.length === 1 ? "" : "s"} · top ${top.ticker} score ${top.rank_score.toFixed(0)} (${fmtPct(top.annualized_yield_pct, 0)} ann.)`;
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

// --- Combined idle scan email ---

export function renderCombinedAlertHtml(
  buyingPower: number,
  cspRecs: CspRecommendation[],
  ccRecs: CcRecommendation[],
): string {
  const cspSection =
    cspRecs.length > 0
      ? `
    <h3 style="margin:0 0 6px 0;font-size:15px;color:#1c1917">Cash at work — CSPs</h3>
    <p style="margin:0 0 10px 0;color:#78716c;font-size:13px">
      ${fmtMoney(buyingPower)} option buying power · ${cspRecs.length} contract${cspRecs.length === 1 ? "" : "s"} in the 0.10–0.20 delta band
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #eee;margin-bottom:24px">
      <thead>
        <tr style="background:#fafaf9">
          <th style="padding:8px 12px;text-align:left;font-weight:600">#</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Ticker</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Contract</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Premium</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Ann. yield</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Δ · DTE</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Collateral</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Score</th>
        </tr>
      </thead>
      <tbody>${cspRecs.map((r, i) => row(r, i + 1)).join("")}</tbody>
    </table>`
      : `<p style="color:#a8a29e;font-size:13px;margin:0 0 24px 0">No CSP candidates this scan.</p>`;

  const ccSection =
    ccRecs.length > 0
      ? `
    <h3 style="margin:0 0 6px 0;font-size:15px;color:#1c1917">Shares at work — CCs</h3>
    <p style="margin:0 0 10px 0;color:#78716c;font-size:13px">
      ${ccRecs.length} contract${ccRecs.length === 1 ? "" : "s"} in the 0.15–0.30 delta band on shares you already own
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #eee;margin-bottom:24px">
      <thead>
        <tr style="background:#fafaf9">
          <th style="padding:8px 12px;text-align:left;font-weight:600">#</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Ticker</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Contract</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Premium</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Ann. yield</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Δ · DTE</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Shares value</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Score</th>
        </tr>
      </thead>
      <tbody>${ccRecs.map((r, i) => ccRow(r, i + 1)).join("")}</tbody>
    </table>`
      : `<p style="color:#a8a29e;font-size:13px;margin:0 0 24px 0">No CC candidates this scan.</p>`;

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;color:#1c1917">
    <h2 style="margin:0 0 20px 0">Idle scan</h2>
    ${cspSection}
    ${ccSection}
    <p style="margin:0;color:#a8a29e;font-size:12px">
      CSPs ranked by: yield, IV/RV gap, ATR cushion, put-OI skew, technical levels, RV cone. CCs ranked by: yield, IV/RV gap, ATR OTM cushion, call-OI skew, resistance proximity, RV cone. Modifiers applied to both. Names already ≥25% of BP or with no bid depth are filtered before ranking.
    </p>
  </div>`;
}

export function renderCombinedAlertSubject(
  cspRecs: CspRecommendation[],
  ccRecs: CcRecommendation[],
): string {
  const parts: string[] = [];
  if (cspRecs.length > 0) {
    const top = cspRecs[0];
    parts.push(`${cspRecs.length} CSP${cspRecs.length === 1 ? "" : "s"} · top ${top.ticker} ${top.rank_score.toFixed(0)} (${fmtPct(top.annualized_yield_pct, 0)} ann.)`);
  }
  if (ccRecs.length > 0) {
    const top = ccRecs[0];
    parts.push(`${ccRecs.length} CC${ccRecs.length === 1 ? "" : "s"} · top ${top.ticker} ${top.rank_score.toFixed(0)} (${fmtPct(top.annualized_yield_pct, 0)} ann.)`);
  }
  return parts.length > 0 ? `Idle scan: ${parts.join(" — ")}` : "Idle scan";
}

export async function sendCombinedAlertEmail(
  to: string,
  buyingPower: number,
  cspRecs: CspRecommendation[],
  ccRecs: CcRecommendation[],
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
    subject: renderCombinedAlertSubject(cspRecs, ccRecs),
    html: renderCombinedAlertHtml(buyingPower, cspRecs, ccRecs),
  });
  if (error) {
    console.error("[email] resend error", error);
    return null;
  }
  return data ? { id: data.id } : null;
}

// --- Covered-call email ---

function ccRow(rec: CcRecommendation, rank: number): string {
  const sharesValue = rec.underlying_price * 100;
  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:none;color:#a8a29e;font-weight:600;width:24px">#${rank}</td>
      <td style="padding:8px 12px;border-bottom:none;font-weight:600">${rec.ticker}</td>
      <td style="padding:8px 12px;border-bottom:none">$${rec.strike}C ${rec.expiration}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right">${fmtMoney(rec.premium_per_contract)}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right;color:#16a34a;font-weight:600">${fmtPct(rec.annualized_yield_pct, 0)}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right">Δ${rec.delta.toFixed(2)} · ${rec.dte}d</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right">${fmtMoney(sharesValue)}</td>
      <td style="padding:8px 12px;border-bottom:none;text-align:right;font-weight:600">${rec.rank_score.toFixed(0)}</td>
    </tr>
    <tr>
      <td colspan="8" style="padding:0 12px 10px 44px;border-bottom:1px solid #eee;color:#78716c;font-size:12px;font-style:italic">${rec.rank_reason || "—"}</td>
    </tr>`;
}

export function renderCcAlertHtml(recs: CcRecommendation[]): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;color:#1c1917">
    <h2 style="margin:0 0 4px 0">Idle shares scan</h2>
    <p style="margin:0 0 16px 0;color:#78716c;font-size:14px">
      ${recs.length} covered call${recs.length === 1 ? "" : "s"} in the 0.15–0.30 delta band on shares you already own
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #eee">
      <thead>
        <tr style="background:#fafaf9">
          <th style="padding:8px 12px;text-align:left;font-weight:600">#</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Ticker</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600">Contract</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Premium</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Ann. yield</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Δ · DTE</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Shares value</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600">Score</th>
        </tr>
      </thead>
      <tbody>
        ${recs.map((r, i) => ccRow(r, i + 1)).join("")}
      </tbody>
    </table>
    <p style="margin:16px 0 0 0;color:#a8a29e;font-size:12px">
      Ranked by composite score: yield, IV-vs-realized-vol gap, ATR-normalized OTM cushion, call-OI dominance at strike, proximity to a resistance level, and RV cone position. Modifiers: term-structure backwardation, strike near cost basis, and ex-dividend date inside DTE. Strikes below cost basis and contracts with no bid-side depth are filtered out before ranking.
    </p>
  </div>`;
}

export function renderCcAlertSubject(recs: CcRecommendation[]): string {
  if (recs.length === 0) return "Idle shares scan";
  const top = recs[0];
  return `Idle shares: ${recs.length} CC${recs.length === 1 ? "" : "s"} · top ${top.ticker} score ${top.rank_score.toFixed(0)} (${fmtPct(top.annualized_yield_pct, 0)} ann.)`;
}

export async function sendCcAlertEmail(
  to: string,
  recs: CcRecommendation[],
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
    subject: renderCcAlertSubject(recs),
    html: renderCcAlertHtml(recs),
  });
  if (error) {
    console.error("[email] resend error", error);
    return null;
  }
  return data ? { id: data.id } : null;
}
