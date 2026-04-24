"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin, logIn, logOut } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import type { RestaurantInput } from "@/lib/types";
import { computeOverall } from "@/lib/utils";

/** Parse a FormData value as a decimal number, or null if empty. */
function num(fd: FormData, key: string): number | null {
  const v = fd.get(key);
  if (v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Parse a FormData value as a required, trimmed string. Throws if empty. */
function requiredStr(fd: FormData, key: string): string {
  const v = fd.get(key);
  if (v === null) throw new Error(`Missing field: ${key}`);
  const s = String(v).trim();
  if (!s) throw new Error(`Field ${key} is required.`);
  return s;
}

function optionalStr(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  if (v === null) return null;
  const s = String(v).trim();
  return s || null;
}

async function assertAdmin() {
  if (!(await isAdmin())) {
    throw new Error("Not authorized.");
  }
}

function buildInput(fd: FormData): RestaurantInput {
  const category = requiredStr(fd, "category");
  const food = num(fd, "food");
  const value = num(fd, "value");
  const service = num(fd, "service");
  const ambiance = num(fd, "ambiance");
  const vegan_options = num(fd, "vegan_options");

  // Use the form value first (from the hidden field), fall back to server-side compute
  let overall = num(fd, "overall");
  if (overall === null) {
    overall = computeOverall(category, { food, value, service, ambiance, vegan_options });
  }
  if (overall === null) throw new Error("Overall could not be computed — fill in all sub-ratings.");

  return {
    name: requiredStr(fd, "name"),
    city: requiredStr(fd, "city"),
    category,
    cuisine: requiredStr(fd, "cuisine"),
    overall,
    food,
    value,
    service,
    ambiance,
    vegan_options,
    note: optionalStr(fd, "note"),
    last_visited: optionalStr(fd, "last_visited") ?? new Date().toISOString().slice(0, 10),
  };
}

export async function loginAction(_state: unknown, fd: FormData) {
  const password = String(fd.get("password") ?? "");
  const ok = await logIn(password);
  if (!ok) {
    return { error: "Incorrect password." };
  }
  redirect("/admin");
}

export async function logoutAction() {
  await logOut();
  redirect("/admin/login");
}

export async function createRestaurant(fd: FormData) {
  await assertAdmin();
  const input = buildInput(fd);
  const supabase = getServiceClient();
  const { error } = await supabase.from("restaurants").insert(input);
  if (error) throw new Error(`Insert failed: ${error.message}`);
  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/admin");
  redirect("/admin");
}

export async function updateRestaurant(id: number, fd: FormData) {
  await assertAdmin();
  const input = buildInput(fd);
  const supabase = getServiceClient();
  const { error } = await supabase.from("restaurants").update(input).eq("id", id);
  if (error) throw new Error(`Update failed: ${error.message}`);
  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/admin");
  revalidatePath(`/restaurant/${id}`);
  redirect("/admin");
}

// _fd is required for compatibility with <form action={...}>, which always
// passes a FormData even when the action only needs the bound id.
export async function deleteRestaurant(id: number, _fd?: FormData) {
  await assertAdmin();
  const supabase = getServiceClient();
  const { error } = await supabase.from("restaurants").delete().eq("id", id);
  if (error) throw new Error(`Delete failed: ${error.message}`);
  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/admin");
}

export async function addCuisine(_state: unknown, fd: FormData) {
  await assertAdmin();
  const name = requiredStr(fd, "name");
  const supabase = getServiceClient();
  const { error } = await supabase.from("cuisines").insert({ name });
  if (error) {
    if (error.code === "23505") return { error: `"${name}" already exists.` };
    throw new Error(`Insert failed: ${error.message}`);
  }
  revalidatePath("/admin");
  return { error: null };
}

export async function updateCuisine(_state: unknown, fd: FormData) {
  await assertAdmin();
  const id = Number(fd.get("id"));
  const name = requiredStr(fd, "name");
  const supabase = getServiceClient();
  const { error } = await supabase.from("cuisines").update({ name }).eq("id", id);
  if (error) {
    if (error.code === "23505") return { error: `"${name}" already exists.` };
    throw new Error(`Update failed: ${error.message}`);
  }
  revalidatePath("/admin");
  return { error: null };
}

export async function deleteCuisine(id: number, _fd?: FormData) {
  await assertAdmin();
  const supabase = getServiceClient();
  const { error } = await supabase.from("cuisines").delete().eq("id", id);
  if (error) throw new Error(`Delete failed: ${error.message}`);
  revalidatePath("/admin");
}
