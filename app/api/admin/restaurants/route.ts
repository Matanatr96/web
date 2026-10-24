import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { computeOverall } from "@/lib/utils";
import {
  addCuisine,
  createRestaurant,
  deletePhotosFromStorage,
  deleteRestaurant,
  deleteVisit,
  logVisit,
  recomputeRestaurantFromVisits,
  replaceCuisines,
  updateRestaurant,
  uploadPhotoBuffers,
} from "@/app/admin/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PhotoPayload = {
  data: string;
  media_type?: string;
};

type CreateOrUpdateRestaurantPayload = {
  action: "create_or_update_restaurant";
  id?: number | null;
  name: string;
  city: string;
  category?: string;
  cuisines: string[];
  unrated?: boolean;
  food?: number | null;
  value?: number | null;
  service?: number | null;
  ambiance?: number | null;
  vegan_options?: number | null;
  overall?: number | null;
  note?: string | null;
  last_visited?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  place_id?: string | null;
  existing_photos?: string[];
  deleted_photos?: string[];
  photos_base64?: (string | PhotoPayload)[];
  attach_receipt_id?: number | null;
};

type DeleteRestaurantPayload = {
  action: "delete_restaurant";
  id: number;
};

type LogVisitPayload = {
  action: "log_visit";
  restaurant_id: number;
  visited_on?: string | null;
  comment?: string | null;
  food?: number | null;
  value?: number | null;
  service?: number | null;
  ambiance?: number | null;
  vegan_options?: number | null;
  attach_receipt_id?: number | null;
};

type DeleteVisitPayload = {
  action: "delete_visit";
  visit_id: number;
  restaurant_id: number;
};

type AddCuisinePayload = {
  action: "add_cuisine";
  name: string;
};

type AdminRestaurantRequest =
  | CreateOrUpdateRestaurantPayload
  | DeleteRestaurantPayload
  | LogVisitPayload
  | DeleteVisitPayload
  | AddCuisinePayload;

function appendNullableNum(fd: FormData, key: string, val: number | null | undefined) {
  if (val !== null && val !== undefined && Number.isFinite(Number(val))) {
    fd.set(key, String(val));
  }
}

function decodeBase64Photos(items: (string | PhotoPayload)[] | undefined): Buffer[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const buffers: Buffer[] = [];
  for (const item of items) {
    const raw = typeof item === "string" ? item : item?.data;
    if (!raw) continue;
    const stripped = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    buffers.push(Buffer.from(stripped, "base64"));
  }
  return buffers;
}

/**
 * Admin-gated JSON endpoint for mobile restaurant, visit, and cuisine mutations.
 * Delegates directly to the shared functions in `app/admin/actions.ts` so WebP
 * photo compression, recency-weighted visit aggregation, and Next.js path
 * revalidation behave identically to the web admin UI.
 *
 * @param req - Incoming HTTP POST request containing an `AdminRestaurantRequest` JSON payload.
 * @returns JSON response with mutation results or an error status.
 */
export async function POST(req: Request) {
  try {
    if (!(await isAdmin())) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }

    const body = (await req.json()) as AdminRestaurantRequest;
    if (!body || typeof body !== "object" || !("action" in body)) {
      return NextResponse.json({ error: "Missing action field." }, { status: 400 });
    }

    switch (body.action) {
      case "create_or_update_restaurant": {
        const fd = new FormData();
        fd.set("name", (body.name ?? "").trim());
        fd.set("city", (body.city ?? "").trim());
        const category = (body.category ?? "Food").trim() || "Food";
        fd.set("category", category);

        const cuisines = Array.from(
          new Set((body.cuisines ?? []).map((c) => c.trim()).filter(Boolean)),
        );
        for (const c of cuisines) {
          fd.append("cuisine", c);
        }

        const isUnrated =
          body.unrated === true ||
          (body.food == null &&
            body.value == null &&
            body.service == null &&
            body.ambiance == null &&
            body.vegan_options == null);

        if (isUnrated) {
          fd.set("unrated", "true");
        } else {
          appendNullableNum(fd, "food", body.food);
          appendNullableNum(fd, "value", body.value);
          appendNullableNum(fd, "service", body.service);
          appendNullableNum(fd, "ambiance", body.ambiance);
          appendNullableNum(fd, "vegan_options", body.vegan_options);
          const computed =
            body.overall ??
            computeOverall(category, {
              food: body.food ?? null,
              value: body.value ?? null,
              service: body.service ?? null,
              ambiance: body.ambiance ?? null,
              vegan_options: body.vegan_options ?? null,
            });
          appendNullableNum(fd, "overall", computed);
        }

        if (body.note != null) fd.set("note", body.note);
        if (body.last_visited != null) fd.set("last_visited", body.last_visited);
        if (body.address != null) fd.set("address", body.address);
        appendNullableNum(fd, "lat", body.lat);
        appendNullableNum(fd, "lng", body.lng);
        if (body.place_id != null) fd.set("place_id", body.place_id);
        if (body.existing_photos) {
          fd.set("existing_photos", JSON.stringify(body.existing_photos));
        }
        if (body.deleted_photos) {
          fd.set("deleted_photos", JSON.stringify(body.deleted_photos));
        }

        const result =
          typeof body.id === "number" && Number.isFinite(body.id)
            ? await updateRestaurant(body.id, fd)
            : await createRestaurant(fd);

        // Handle optional base64 photo uploads from mobile camera/picker.
        const photoBuffers = decodeBase64Photos(body.photos_base64);
        if (photoBuffers.length > 0) {
          const uploadedUrls = await uploadPhotoBuffers(result.id, photoBuffers);
          const supabase = getServiceClient();
          const { data: currentRow } = await supabase
            .from("restaurants")
            .select("photos")
            .eq("id", result.id)
            .single();
          const mergedPhotos = [...(currentRow?.photos ?? []), ...uploadedUrls];
          await supabase
            .from("restaurants")
            .update({ photos: mergedPhotos })
            .eq("id", result.id);
        }

        // Link an unlinked receipt if requested during the Add/Rate flow.
        if (typeof body.attach_receipt_id === "number" && Number.isFinite(body.attach_receipt_id)) {
          const supabase = getServiceClient();
          await supabase
            .from("receipts")
            .update({ restaurant_id: result.id })
            .eq("id", body.attach_receipt_id);
        }

        revalidatePath(`/restaurant/${result.id}`);
        return NextResponse.json({
          ok: true,
          restaurant_id: result.id,
          placeId: result.placeId,
          note: result.note,
          name: result.name,
        });
      }

      case "delete_restaurant": {
        if (typeof body.id !== "number" || !Number.isFinite(body.id)) {
          return NextResponse.json({ error: "Valid restaurant id is required." }, { status: 400 });
        }
        await deleteRestaurant(body.id);
        return NextResponse.json({ ok: true, deleted: body.id });
      }

      case "log_visit": {
        if (typeof body.restaurant_id !== "number" || !Number.isFinite(body.restaurant_id)) {
          return NextResponse.json(
            { error: "Valid restaurant_id is required." },
            { status: 400 },
          );
        }
        const fd = new FormData();
        if (body.visited_on) fd.set("visited_on", body.visited_on);
        if (body.comment != null) fd.set("comment", body.comment);
        appendNullableNum(fd, "food", body.food);
        appendNullableNum(fd, "value", body.value);
        appendNullableNum(fd, "service", body.service);
        appendNullableNum(fd, "ambiance", body.ambiance);
        appendNullableNum(fd, "vegan_options", body.vegan_options);

        await logVisit(body.restaurant_id, fd);

        if (typeof body.attach_receipt_id === "number" && Number.isFinite(body.attach_receipt_id)) {
          const supabase = getServiceClient();
          await supabase
            .from("receipts")
            .update({ restaurant_id: body.restaurant_id })
            .eq("id", body.attach_receipt_id);
        }

        return NextResponse.json({ ok: true, restaurant_id: body.restaurant_id });
      }

      case "delete_visit": {
        if (
          typeof body.visit_id !== "number" ||
          typeof body.restaurant_id !== "number"
        ) {
          return NextResponse.json(
            { error: "visit_id and restaurant_id are required." },
            { status: 400 },
          );
        }
        await deleteVisit(body.visit_id, body.restaurant_id);
        return NextResponse.json({
          ok: true,
          deleted: body.visit_id,
          restaurant_id: body.restaurant_id,
        });
      }

      case "add_cuisine": {
        const fd = new FormData();
        fd.set("name", (body.name ?? "").trim());
        const res = await addCuisine(null, fd);
        if (res?.error) {
          return NextResponse.json({ error: res.error }, { status: 409 });
        }
        return NextResponse.json({ ok: true, name: body.name.trim() });
      }

      default: {
        // Keep unused imports referenced for completeness if needed by direct callers
        void replaceCuisines;
        void deletePhotosFromStorage;
        void recomputeRestaurantFromVisits;
        return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("api/admin/restaurants error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
