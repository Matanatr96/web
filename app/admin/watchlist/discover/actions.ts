"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";

export async function addDiscoveredTicker(ticker: string): Promise<{ error: string | null }> {
  if (!(await isAdmin())) return { error: "Not authorized." };
  const clean = ticker.trim().toUpperCase();
  if (!clean) return { error: "Ticker is required." };

  const supabase = getServiceClient();
  const { error } = await supabase.from("watchlist").insert({ ticker: clean });
  if (error) {
    if (error.code === "23505") return { error: `${clean} is already on your watchlist.` };
    return { error: `Insert failed: ${error.message}` };
  }
  revalidatePath("/admin/watchlist");
  revalidatePath("/admin/watchlist/discover");
  return { error: null };
}
