import { NextRequest, NextResponse } from "next/server";
import { fetchOrders, fetchEquityOrders } from "@/lib/tradier";
import { getServiceClient } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";

async function getLatestOrderDate(
  table: "options_trades" | "equity_trades",
): Promise<Date | null> {
  const db = getServiceClient();
  const { data } = await db
    .from(table)
    .select("order_date")
    .eq("source", "prod")
    .order("order_date", { ascending: false })
    .limit(1)
    .single();
  return data ? new Date(data.order_date) : null;
}

export async function POST(req: NextRequest) {
  try {
    const authed = await isAdmin();
    if (!authed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { full = false } = await req.json().catch(() => ({}));
    const db = getServiceClient();

    // Fetch from Tradier and get our latest known dates in parallel.
    // In `full` mode, skip the watermark and upsert every order Tradier returns —
    // the (tradier_id, source) unique constraint dedupes existing rows.
    const [optionsOrders, equityOrders, latestOptions, latestEquity] = await Promise.all([
      fetchOrders(),
      fetchEquityOrders(),
      full ? Promise.resolve(null) : getLatestOrderDate("options_trades"),
      full ? Promise.resolve(null) : getLatestOrderDate("equity_trades"),
    ]);

    const newOptions = latestOptions
      ? optionsOrders.filter((o) => new Date(o.order_date) > latestOptions)
      : optionsOrders;

    const newEquity = latestEquity
      ? equityOrders.filter((o) => new Date(o.order_date) > latestEquity)
      : equityOrders;

    const errors: string[] = [];

    if (newOptions.length > 0) {
      const { error } = await db.from("options_trades").upsert(
        newOptions.map((o) => ({
          tradier_id:       o.tradier_id,
          source:           o.source,
          underlying:       o.underlying,
          option_symbol:    o.option_symbol,
          option_type:      o.option_type,
          strategy:         o.strategy,
          side:             o.side,
          strike:           o.strike,
          expiration_date:  o.expiration_date,
          quantity:         o.quantity,
          avg_fill_price:   o.avg_fill_price,
          status:           o.status,
          order_date:       o.order_date,
          transaction_date: o.transaction_date,
        })),
        { onConflict: "tradier_id,source" },
      );
      if (error) {
        console.error("options_trades upsert error:", error);
        errors.push(`options upsert: ${error.message}`);
      }
    }

    if (newEquity.length > 0) {
      const { error } = await db.from("equity_trades").upsert(
        newEquity.map((o) => ({
          tradier_id:       o.tradier_id,
          source:           o.source,
          symbol:           o.symbol,
          side:             o.side,
          quantity:         o.quantity,
          avg_fill_price:   o.avg_fill_price,
          status:           o.status,
          order_date:       o.order_date,
          transaction_date: o.transaction_date,
        })),
        { onConflict: "tradier_id,source" },
      );
      if (error) {
        console.error("equity_trades upsert error:", error);
        errors.push(`equity upsert: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join("; ") }, { status: 500 });
    }

    return NextResponse.json({
      synced_options: newOptions.length,
      synced_equity:  newEquity.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("sync route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
