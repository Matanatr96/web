import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { matchCuisineFromGoogleType } from "@/lib/restaurants-query";
import { CUISINES } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCATION_BIAS_RADIUS_M = 25000;

export type AutocompletePlacePick = {
  placeId: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  googleType?: string;
  googleTypeRaw?: string;
  matchedCuisine: string | null;
};

type PlacesV1AutocompleteResult = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: Array<{ longText?: string; types?: string[] }>;
  primaryTypeDisplayName?: { text?: string };
  primaryType?: string;
};

/**
 * Admin-gated Google Places search/autocomplete endpoint for the iPhone
 * "Add / Rate Restaurant" and "Link Receipt" sheets.
 *
 * Uses the server-side `GOOGLE_MAPS_SERVER_KEY` (falling back to
 * `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) to query Google Places API v1 (`places:searchText`),
 * extracts the locality/city from `addressComponents`, and auto-matches the
 * primary place type against the canonical cuisine list via `matchCuisineFromGoogleType`.
 *
 * @param req - Incoming POST request with `{ query: string; lat?: number; lng?: number }`.
 * @returns JSON `{ results: AutocompletePlacePick[] }`.
 */
export async function POST(req: Request) {
  try {
    if (!(await isAdmin())) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as {
      query?: string;
      lat?: number;
      lng?: number;
    } | null;

    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query) {
      return NextResponse.json({ results: [] });
    }

    const apiKey =
      process.env.GOOGLE_MAPS_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Places API not configured" }, { status: 500 });
    }

    // Fetch canonical cuisine names from DB (falling back to CUISINES constant).
    const { data: cuisineRows } = await getSupabase()
      .from("cuisines")
      .select("name")
      .order("name");
    const cuisineList =
      cuisineRows && cuisineRows.length > 0
        ? cuisineRows.map((c: { name: string }) => c.name)
        : CUISINES;

    const requestBody: {
      textQuery: string;
      pageSize: number;
      locationBias?: {
        circle: { center: { latitude: number; longitude: number }; radius: number };
      };
    } = {
      textQuery: query,
      pageSize: 8,
    };

    if (
      typeof body?.lat === "number" &&
      Number.isFinite(body.lat) &&
      typeof body?.lng === "number" &&
      Number.isFinite(body.lng)
    ) {
      requestBody.locationBias = {
        circle: {
          center: { latitude: body.lat, longitude: body.lng },
          radius: LOCATION_BIAS_RADIUS_M,
        },
      };
    }

    const fields = [
      "places.id",
      "places.displayName",
      "places.formattedAddress",
      "places.location",
      "places.addressComponents",
      "places.primaryTypeDisplayName",
      "places.primaryType",
    ].join(",");

    const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fields,
      },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json(
        { error: `Places API error: ${resp.status} ${text}` },
        { status: 502 },
      );
    }

    const payload = (await resp.json()) as { places?: PlacesV1AutocompleteResult[] };
    const places = payload.places ?? [];

    const results: AutocompletePlacePick[] = places
      .filter((p): p is PlacesV1AutocompleteResult & { id: string } => Boolean(p.id))
      .map((p) => {
        const components = p.addressComponents ?? [];
        const cityComp =
          components.find((c) => c.types?.includes("locality")) ??
          components.find((c) => c.types?.includes("postal_town")) ??
          components.find((c) => c.types?.includes("sublocality")) ??
          components.find((c) => c.types?.includes("administrative_area_level_2"));

        const googleType = p.primaryTypeDisplayName?.text ?? undefined;
        const googleTypeRaw = p.primaryType ?? undefined;
        const matchedCuisine = matchCuisineFromGoogleType(
          googleType,
          googleTypeRaw,
          cuisineList,
        );

        return {
          placeId: p.id,
          name: p.displayName?.text ?? "",
          address: p.formattedAddress ?? "",
          city: cityComp?.longText ?? "",
          lat: p.location?.latitude ?? 0,
          lng: p.location?.longitude ?? 0,
          googleType,
          googleTypeRaw,
          matchedCuisine,
        };
      });

    return NextResponse.json({ results });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("places-autocomplete error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
