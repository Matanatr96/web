"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import sharp from "sharp";
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

type BuiltInput = {
  row: Omit<RestaurantInput, "photos" | "cuisines">;
  cuisines: string[];
};

function buildInput(fd: FormData): BuiltInput {
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

  // Cuisines come from multiple checkbox inputs all named "cuisine".
  const cuisines = Array.from(
    new Set(
      fd.getAll("cuisine")
        .map((v) => String(v).trim())
        .filter((s) => s.length > 0),
    ),
  );
  if (cuisines.length === 0) throw new Error("Pick at least one cuisine.");

  return {
    row: {
      name: requiredStr(fd, "name"),
      city: requiredStr(fd, "city"),
      category,
      overall,
      food,
      value,
      service,
      ambiance,
      vegan_options,
      note: optionalStr(fd, "note"),
      last_visited: optionalStr(fd, "last_visited") ?? new Date().toISOString().slice(0, 10),
      address: optionalStr(fd, "address"),
      lat: num(fd, "lat"),
      lng: num(fd, "lng"),
      place_id: optionalStr(fd, "place_id"),
    },
    cuisines,
  };
}

async function replaceCuisines(restaurantId: number, cuisines: string[]) {
  const supabase = getServiceClient();
  const { error: delErr } = await supabase
    .from("restaurant_cuisines")
    .delete()
    .eq("restaurant_id", restaurantId);
  if (delErr) throw new Error(`Cuisine reset failed: ${delErr.message}`);
  if (cuisines.length === 0) return;
  const rows = cuisines.map((c) => ({ restaurant_id: restaurantId, cuisine_name: c }));
  const { error: insErr } = await supabase.from("restaurant_cuisines").insert(rows);
  if (insErr) throw new Error(`Cuisine insert failed: ${insErr.message}`);
}

async function uploadPhotos(restaurantId: number, files: File[]): Promise<string[]> {
  if (files.length === 0) return [];
  const supabase = getServiceClient();
  const urls: string[] = [];
  for (const file of files) {
    const raw = Buffer.from(await file.arrayBuffer());
    const compressed = await sharp(raw)
      .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const path = `${restaurantId}/${crypto.randomUUID()}.webp`;
    const { error } = await supabase.storage
      .from("restaurant-photos")
      .upload(path, compressed, { contentType: "image/webp", upsert: false });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    const { data } = supabase.storage.from("restaurant-photos").getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

async function deletePhotosFromStorage(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const supabase = getServiceClient();
  const marker = "/restaurant-photos/";
  const paths = urls
    .map((url) => { const idx = url.indexOf(marker); return idx >= 0 ? url.slice(idx + marker.length) : null; })
    .filter((p): p is string => p !== null);
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from("restaurant-photos").remove(paths);
  if (error) throw new Error(`Photo delete failed: ${error.message}`);
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

export async function createRestaurant(fd: FormData): Promise<{ placeId: string | null; note: string | null; name: string }> {
  await assertAdmin();
  const { row, cuisines } = buildInput(fd);
  const supabase = getServiceClient();
  const { data, error } = await supabase.from("restaurants").insert(row).select("id").single();
  if (error) throw new Error(`Insert failed: ${error.message}`);

  await replaceCuisines(data.id, cuisines);

  const files = fd.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 0) {
    const photos = await uploadPhotos(data.id, files);
    await supabase.from("restaurants").update({ photos }).eq("id", data.id);
  }

  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/map");
  revalidatePath("/admin");
  return { placeId: row.place_id ?? null, note: row.note ?? null, name: row.name };
}

export async function updateRestaurant(id: number, fd: FormData): Promise<{ placeId: string | null; note: string | null; name: string }> {
  await assertAdmin();
  const { row, cuisines } = buildInput(fd);
  const supabase = getServiceClient();

  const deletedPhotos: string[] = JSON.parse(optionalStr(fd, "deleted_photos") ?? "[]");
  await deletePhotosFromStorage(deletedPhotos);

  const files = fd.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  const newUrls = await uploadPhotos(id, files);

  const existingPhotos: string[] = JSON.parse(optionalStr(fd, "existing_photos") ?? "[]");
  const photos = [...existingPhotos, ...newUrls];

  const { error } = await supabase.from("restaurants").update({ ...row, photos: photos.length ? photos : null }).eq("id", id);
  if (error) throw new Error(`Update failed: ${error.message}`);
  await replaceCuisines(id, cuisines);
  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/map");
  revalidatePath("/admin");
  revalidatePath(`/restaurant/${id}`);
  return { placeId: row.place_id ?? null, note: row.note ?? null, name: row.name };
}

// _fd is required for compatibility with <form action={...}>, which always
// passes a FormData even when the action only needs the bound id.
export async function deleteRestaurant(id: number, _fd?: FormData) {
  await assertAdmin();
  const supabase = getServiceClient();

  const { data } = await supabase.from("restaurants").select("photos").eq("id", id).single();
  if (data?.photos?.length) await deletePhotosFromStorage(data.photos);

  const { error } = await supabase.from("restaurants").delete().eq("id", id);
  if (error) throw new Error(`Delete failed: ${error.message}`);
  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/map");
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
