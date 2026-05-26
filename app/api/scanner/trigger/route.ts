// Admin-authed manual trigger: forwards to the idle-scan cron endpoint with
// force=1, bypassing the interval / market-hours / daily-cap gates so the user
// can fire a scan on demand from /admin/scanner.

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";

export async function POST(req: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
  }

  const url = new URL(req.url);
  const target = `${url.origin}/api/cron/idle-scan?force=1`;
  try {
    const resp = await fetch(target, {
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(json, { status: resp.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
