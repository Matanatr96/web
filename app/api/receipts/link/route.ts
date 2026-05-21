import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Body = {
  receipt_id: number;
  place: {
    placeId: string;
    name: string;
    address: string;
    city: string;
    lat: number;
    lng: number;
    googleType?: string;
    googleTypeRaw?: string;
  };
};

/**
 * Link a receipt to a restaurant identified by a Google Places pick. Creates
 * the restaurant row if one with that place_id doesn't exist yet (with
 * placeholder rating — the caller redirects the admin to /admin/[id]/edit so
 * they can fill it in immediately).
 */
export async function POST(req: Request) {
  try {
    if (!(await isAdmin())) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }

    const body = (await req.json()) as Body;
    if (!body?.receipt_id || !body.place?.placeId) {
      return NextResponse.json({ error: "receipt_id and place.placeId are required" }, { status: 400 });
    }

    const db = getServiceClient();

    // Try to find an existing restaurant with the same place_id.
    const { data: existing, error: findErr } = await db
      .from("restaurants")
      .select("id, overall, food, value, service, ambiance, vegan_options")
      .eq("place_id", body.place.placeId)
      .maybeSingle();
    if (findErr) throw findErr;

    let restaurantId: number;
    let isNew = false;
    let isRated = false;

    if (existing) {
      restaurantId = existing.id;
      // Consider it rated if any sub-rating is set (overall is required-not-null
      // so we can't use that alone — a placeholder row has overall=0).
      isRated = [existing.food, existing.value, existing.service, existing.ambiance, existing.vegan_options]
        .some((v) => v !== null);
    } else {
      const { data: inserted, error: insErr } = await db
        .from("restaurants")
        .insert({
          name: body.place.name,
          city: body.place.city || "Unknown",
          category: "Food",
          overall: 0,
          address: body.place.address || null,
          lat: body.place.lat || null,
          lng: body.place.lng || null,
          place_id: body.place.placeId,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      restaurantId = inserted.id;
      isNew = true;
    }

    const { error: updErr } = await db
      .from("receipts")
      .update({ restaurant_id: restaurantId })
      .eq("id", body.receipt_id);
    if (updErr) throw updErr;

    return NextResponse.json({ restaurant_id: restaurantId, is_new: isNew, is_rated: isRated });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("receipts/link error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
