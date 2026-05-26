// Admin-authed CRUD for the singleton scanner_config row + a POST endpoint
// to manually trigger a scan (calls the cron endpoint internally with force=1).

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  getScannerConfig,
  updateScannerConfig,
  validateConfigPatch,
  type ScannerConfigPatch,
} from "@/lib/scanner-config";

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const config = await getScannerConfig();
  return NextResponse.json(config);
}

export async function PATCH(req: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ScannerConfigPatch;
  try {
    body = (await req.json()) as ScannerConfigPatch;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const allowed: ScannerConfigPatch = {};
  if (typeof body.enabled === "boolean") allowed.enabled = body.enabled;
  if (typeof body.scan_interval_min === "number") allowed.scan_interval_min = body.scan_interval_min;
  if (typeof body.dedup_hours === "number") allowed.dedup_hours = body.dedup_hours;
  if (typeof body.daily_email_cap === "number") allowed.daily_email_cap = body.daily_email_cap;
  if (typeof body.max_per_type === "number") allowed.max_per_type = body.max_per_type;

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "no recognized fields" }, { status: 400 });
  }

  const validationErr = validateConfigPatch(allowed);
  if (validationErr) {
    return NextResponse.json({ error: validationErr }, { status: 400 });
  }

  try {
    const updated = await updateScannerConfig(allowed);
    return NextResponse.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
