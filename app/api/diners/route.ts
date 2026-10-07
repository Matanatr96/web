import { NextResponse } from "next/server";
import { getServiceClient, getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Lists all saved diners ordered with the primary user (`is_self`) first,
 * followed by most recently used diners.
 */
export async function GET() {
  const { data, error } = await getSupabase()
    .from("diners")
    .select("id, name, is_self, last_used_at")
    .order("is_self", { ascending: false })
    .order("last_used_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ diners: data ?? [] });
}

/**
 * Creates or updates a diner record. When `id` is provided, renames that
 * specific diner row in place (updating all linked historical receipts);
 * otherwise upserts by `name`.
 */
export async function POST(req: Request) {
  const { id, name } = (await req.json()) as { id?: number; name?: string };
  const trimmed = (name ?? "").trim();
  if (!trimmed) return NextResponse.json({ error: "name required" }, { status: 400 });

  const db = getServiceClient();
  if (typeof id === "number" && Number.isFinite(id)) {
    const { data, error } = await db
      .from("diners")
      .update({ name: trimmed })
      .eq("id", id)
      .select("id, name, is_self, last_used_at")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ diner: data });
  }

  const { data, error } = await db
    .from("diners")
    .upsert({ name: trimmed, last_used_at: new Date().toISOString() }, { onConflict: "name" })
    .select("id, name, is_self, last_used_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ diner: data });
}

/**
 * Deletes an unused, non-self diner row by `id`.
 */
export async function DELETE(req: Request) {
  const { id } = (await req.json()) as { id?: number };
  if (typeof id !== "number" || !Number.isFinite(id)) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const db = getServiceClient();
  const { error } = await db.from("diners").delete().eq("id", id).eq("is_self", false);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: id });
}
