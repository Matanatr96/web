import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ];
  return lines.join("\n");
}

export async function GET(req: NextRequest) {
  try {
    const authed = await isAdmin();
    if (!authed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = req.nextUrl;
    const source = searchParams.get("source") === "sandbox" ? "sandbox" : "prod";
    const table  = searchParams.get("table") === "equity" ? "equity_trades" : "options_trades";

    const db = getServiceClient();
    const { data, error } = await db
      .from(table)
      .select("*")
      .eq("source", source)
      .order("order_date", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const csv = toCsv((data ?? []) as Record<string, unknown>[]);
    const filename = `${table}_${source}_${new Date().toISOString().slice(0, 10)}.csv`;

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("export route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
