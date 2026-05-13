import { NextResponse } from "next/server";
import { getServiceClient, getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await getSupabase()
    .from("diners")
    .select("id, name, is_self, last_used_at")
    .order("is_self", { ascending: false })
    .order("last_used_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ diners: data ?? [] });
}

export async function POST(req: Request) {
  const { name } = (await req.json()) as { name?: string };
  const trimmed = (name ?? "").trim();
  if (!trimmed) return NextResponse.json({ error: "name required" }, { status: 400 });

  const db = getServiceClient();
  const { data, error } = await db
    .from("diners")
    .upsert({ name: trimmed, last_used_at: new Date().toISOString() }, { onConflict: "name" })
    .select("id, name, is_self, last_used_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ diner: data });
}
