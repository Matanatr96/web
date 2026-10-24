"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import sharp from "sharp";
import { isAdmin, logIn, logOut } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import type { RestaurantInput } from "@/lib/types";
import { computeOverall } from "@/lib/utils";
import { weightedMeanRatings } from "@/lib/restaurant-visits";

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
  const unratedFlag = optionalStr(fd, "unrated") === "true";
  const rawFood = num(fd, "food");
  const rawValue = num(fd, "value");
  const rawService = num(fd, "service");
  const rawAmbiance = num(fd, "ambiance");
  const rawVegan = num(fd, "vegan_options");

  const allSubRatingsEmpty =
    rawFood === null &&
    rawValue === null &&
    rawService === null &&
    rawAmbiance === null &&
    rawVegan === null;

  const isUnrated = unratedFlag || allSubRatingsEmpty;

  const food = isUnrated ? null : rawFood;
  const value = isUnrated ? null : rawValue;
  const service = isUnrated ? null : rawService;
  const ambiance = isUnrated ? null : rawAmbiance;
  const vegan_options = isUnrated ? null : rawVegan;

  let overall: number | null;
  if (isUnrated) {
    overall = 0;
  } else {
    // Use the form value first (from the hidden field), fall back to server-side compute
    overall = num(fd, "overall");
    if (overall === null) {
      overall = computeOverall(category, { food, value, service, ambiance, vegan_options });
    }
    if (overall === null) throw new Error("Overall could not be computed — fill in all sub-ratings.");
  }

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
      last_visited: isUnrated
        ? null
        : (optionalStr(fd, "last_visited") ?? new Date().toISOString().slice(0, 10)),
      address: optionalStr(fd, "address"),
      lat: num(fd, "lat"),
      lng: num(fd, "lng"),
      place_id: optionalStr(fd, "place_id"),
    },
    cuisines,
  };
}

/**
 * Replace all cuisine associations for `restaurantId` in `restaurant_cuisines`.
 *
 * @param restaurantId - Target restaurant primary key.
 * @param cuisines - List of canonical cuisine names to associate.
 */
export async function replaceCuisines(restaurantId: number, cuisines: string[]): Promise<void> {
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

/**
 * Compress raw image buffers to WebP (`<= 1800x1800`, quality 82) and upload
 * them to the public `restaurant-photos` Supabase Storage bucket.
 *
 * @param restaurantId - Target restaurant primary key used as storage prefix.
 * @param buffers - Raw image buffers to compress and upload.
 * @returns Array of public Supabase Storage URLs for the uploaded photos.
 */
export async function uploadPhotoBuffers(
  restaurantId: number,
  buffers: Buffer[],
): Promise<string[]> {
  if (buffers.length === 0) return [];
  const supabase = getServiceClient();
  const urls: string[] = [];
  for (const raw of buffers) {
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

async function uploadPhotos(restaurantId: number, files: File[]): Promise<string[]> {
  if (files.length === 0) return [];
  const buffers: Buffer[] = [];
  for (const file of files) {
    buffers.push(Buffer.from(await file.arrayBuffer()));
  }
  return uploadPhotoBuffers(restaurantId, buffers);
}

/**
 * Remove photo objects from the `restaurant-photos` Supabase Storage bucket
 * given their public URLs.
 *
 * @param urls - Public storage URLs to delete.
 */
export async function deletePhotosFromStorage(urls: string[]): Promise<void> {
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

export async function createRestaurant(fd: FormData): Promise<{ id: number; placeId: string | null; note: string | null; name: string }> {
  await assertAdmin();
  const { row, cuisines } = buildInput(fd);
  const supabase = getServiceClient();
  const { data, error } = await supabase.from("restaurants").insert(row).select("id").single();
  if (error) throw new Error(`Insert failed: ${error.message}`);

  await replaceCuisines(data.id, cuisines);

  if (row.food !== null) {
    const visitedOn = row.last_visited ?? new Date().toISOString().slice(0, 10);
    const { error: visitErr } = await supabase.from("restaurant_visits").insert({
      restaurant_id: data.id,
      visited_on: visitedOn,
      comment: row.note,
      food: row.food,
      value: row.value,
      service: row.service,
      ambiance: row.ambiance,
      vegan_options: row.vegan_options,
      overall: row.overall,
    });
    if (visitErr) throw new Error(`Initial visit insert failed: ${visitErr.message}`);
    await recomputeRestaurantFromVisits(data.id);
  }

  const files = fd.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 0) {
    const photos = await uploadPhotos(data.id, files);
    await supabase.from("restaurants").update({ photos }).eq("id", data.id);
  }

  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/restaurants/table");
  revalidatePath("/restaurants/suggestions");
  revalidatePath("/map");
  revalidatePath("/admin");
  return { id: data.id, placeId: row.place_id ?? null, note: row.note ?? null, name: row.name };
}

export async function updateRestaurant(id: number, fd: FormData): Promise<{ id: number; placeId: string | null; note: string | null; name: string }> {
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

  // If an unrated bookmark is being rated for the first time and has no visits yet,
  // record the initial visit row so visit_count becomes 1.
  if (row.food !== null) {
    const { count } = await supabase
      .from("restaurant_visits")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", id);
    if ((count ?? 0) === 0) {
      const visitedOn = row.last_visited ?? new Date().toISOString().slice(0, 10);
      await supabase.from("restaurant_visits").insert({
        restaurant_id: id,
        visited_on: visitedOn,
        comment: row.note,
        food: row.food,
        value: row.value,
        service: row.service,
        ambiance: row.ambiance,
        vegan_options: row.vegan_options,
        overall: row.overall,
      });
      await recomputeRestaurantFromVisits(id);
    }
  }

  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/restaurants/table");
  revalidatePath("/restaurants/suggestions");
  revalidatePath("/map");
  revalidatePath("/admin");
  revalidatePath(`/restaurant/${id}`);
  return { id, placeId: row.place_id ?? null, note: row.note ?? null, name: row.name };
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

/**
 * Recompute the recency-weighted ratings for a restaurant from its visit log
 * and write the result back to the restaurants row. Also refreshes the
 * cached visit_count and last_visited. Called after any visit mutation.
 *
 * @param restaurantId - Target restaurant primary key.
 */
export async function recomputeRestaurantFromVisits(restaurantId: number): Promise<void> {
  const supabase = getServiceClient();
  const { data: rest, error: restErr } = await supabase
    .from("restaurants")
    .select("category")
    .eq("id", restaurantId)
    .single();
  if (restErr || !rest) throw new Error(`Restaurant not found: ${restErr?.message}`);

  const { data: visits, error: visitsErr } = await supabase
    .from("restaurant_visits")
    .select("visited_on, food, value, service, ambiance, vegan_options")
    .eq("restaurant_id", restaurantId);
  if (visitsErr) throw new Error(`Visit fetch failed: ${visitsErr.message}`);

  const list = visits ?? [];
  const visit_count = list.length;

  let update: Record<string, unknown> = { visit_count };

  if (visit_count > 0) {
    const agg = weightedMeanRatings(list, rest.category);
    // Find most recent visited_on for the last_visited cache.
    const latest = list
      .map((v) => v.visited_on)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;
    update = {
      ...update,
      food: agg.food,
      value: agg.value,
      service: agg.service,
      ambiance: agg.ambiance,
      vegan_options: agg.vegan_options,
      // The schema requires overall to be non-null. Fall back to the existing
      // value if we somehow can't compute one (e.g., partial ratings + unknown
      // category) — but in practice the weighted mean produces something.
      ...(agg.overall !== null ? { overall: agg.overall } : {}),
      last_visited: latest,
    };
  }

  const { error: updErr } = await supabase
    .from("restaurants")
    .update(update)
    .eq("id", restaurantId);
  if (updErr) throw new Error(`Restaurant update failed: ${updErr.message}`);
}

export async function logVisit(restaurantId: number, fd: FormData) {
  await assertAdmin();
  const supabase = getServiceClient();

  const visited_on =
    optionalStr(fd, "visited_on") ?? new Date().toISOString().slice(0, 10);
  const comment = optionalStr(fd, "comment");
  const food = num(fd, "food");
  const value = num(fd, "value");
  const service = num(fd, "service");
  const ambiance = num(fd, "ambiance");
  const vegan_options = num(fd, "vegan_options");

  // Look up the category so the per-visit overall is computed consistently
  // with how the cached restaurant overall is computed.
  const { data: rest, error: restErr } = await supabase
    .from("restaurants")
    .select("category")
    .eq("id", restaurantId)
    .single();
  if (restErr || !rest) throw new Error(`Restaurant not found: ${restErr?.message}`);

  const overall = computeOverall(rest.category, { food, value, service, ambiance, vegan_options });

  const { error } = await supabase.from("restaurant_visits").insert({
    restaurant_id: restaurantId,
    visited_on,
    comment,
    food,
    value,
    service,
    ambiance,
    vegan_options,
    overall,
  });
  if (error) throw new Error(`Visit insert failed: ${error.message}`);

  await recomputeRestaurantFromVisits(restaurantId);

  revalidatePath("/");
  revalidatePath("/restaurants");
  revalidatePath("/restaurants/table");
  revalidatePath("/map");
  revalidatePath(`/restaurant/${restaurantId}`);
}

export async function deleteVisit(visitId: number, restaurantId: number) {
  await assertAdmin();
  const supabase = getServiceClient();
  const { error } = await supabase.from("restaurant_visits").delete().eq("id", visitId);
  if (error) throw new Error(`Visit delete failed: ${error.message}`);
  await recomputeRestaurantFromVisits(restaurantId);
  revalidatePath("/restaurants");
  revalidatePath("/restaurants/table");
  revalidatePath(`/restaurant/${restaurantId}`);
}
