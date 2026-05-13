import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

type SaveBody = {
  restaurant_id: number | null;
  visited_on: string | null;
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  parse_model: string | null;
  items: {
    name: string;
    price: number;
    qty: number;
    diner_ids: number[];
  }[];
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json({ error: "items required" }, { status: 400 });
    }
    const db = getServiceClient();
    const admin = await isAdmin();

    const { data: receipt, error: rErr } = await db
      .from("receipts")
      .insert({
        restaurant_id: admin ? body.restaurant_id : null,
        visited_on: body.visited_on,
        subtotal: body.subtotal,
        tax: body.tax,
        tip: body.tip,
        total: body.total,
        parse_model: body.parse_model,
      })
      .select("id")
      .single();
    if (rErr) throw rErr;

    const itemRows = body.items.map((it, idx) => ({
      receipt_id: receipt.id,
      name: it.name,
      price: it.price,
      qty: it.qty,
      position: idx,
    }));
    const { data: insertedItems, error: iErr } = await db
      .from("receipt_items")
      .insert(itemRows)
      .select("id, position");
    if (iErr) throw iErr;

    const posToId = new Map(insertedItems.map((r) => [r.position, r.id]));
    const assignments: { item_id: number; diner_id: number; share: number }[] = [];
    body.items.forEach((it, idx) => {
      const itemId = posToId.get(idx);
      if (!itemId || it.diner_ids.length === 0) return;
      const share = 1 / it.diner_ids.length;
      for (const did of it.diner_ids) {
        assignments.push({ item_id: itemId, diner_id: did, share });
      }
    });
    if (assignments.length > 0) {
      const { error: aErr } = await db.from("receipt_item_diners").insert(assignments);
      if (aErr) throw aErr;
    }

    // Bump last_used_at for diners present on this receipt.
    const usedDinerIds = Array.from(new Set(body.items.flatMap((it) => it.diner_ids)));
    if (usedDinerIds.length > 0) {
      await db
        .from("diners")
        .update({ last_used_at: new Date().toISOString() })
        .in("id", usedDinerIds);
    }

    return NextResponse.json({ id: receipt.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("receipts save error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
