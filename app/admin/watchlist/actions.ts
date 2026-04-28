"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";

async function assertAdmin() {
  if (!(await isAdmin())) throw new Error("Not authorized.");
}

export async function addToWatchlist(_state: unknown, fd: FormData) {
  await assertAdmin();
  const ticker = String(fd.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return { error: "Ticker is required." };

  const supabase = getServiceClient();
  const { error } = await supabase.from("watchlist").insert({ ticker });
  if (error) {
    if (error.code === "23505") return { error: `${ticker} is already on your watchlist.` };
    throw new Error(`Insert failed: ${error.message}`);
  }
  revalidatePath("/admin/watchlist");
  return { error: null };
}

export async function removeFromWatchlist(id: number, _fd?: FormData) {
  await assertAdmin();
  const supabase = getServiceClient();
  const { error } = await supabase.from("watchlist").delete().eq("id", id);
  if (error) throw new Error(`Delete failed: ${error.message}`);
  revalidatePath("/admin/watchlist");
}
