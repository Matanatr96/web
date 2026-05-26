// Admin-authed preview: runs both scans and returns the ranked recommendations
// as JSON, with NO email, NO dedup filtering, and NO sent_alerts inserts.
// Used by /admin/scanner to show "what would the scanner pick right now?"
// without consuming the dedup window.

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { scanWatchlistForCsps } from "@/lib/csp-scanner";
import { scanHoldingsForCcs } from "@/lib/cc-scanner";

export async function POST() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const [cspScan, ccScan] = await Promise.all([
      scanWatchlistForCsps(),
      scanHoldingsForCcs(),
    ]);
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      buying_power: cspScan.buying_power,
      csps: cspScan.recommendations,
      ccs: ccScan.recommendations,
      csp_diagnostics: cspScan.diagnostics,
      cc_diagnostics: ccScan.diagnostics,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
