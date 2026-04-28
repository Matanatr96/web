/**
 * Backfill place_id for restaurants that already have lat/lng but no place_id.
 *
 * Usage:
 *   npx tsx scripts/backfill-place-id.ts
 *
 * For each qualifying row it runs a Google Places Text Search, ranks candidates
 * by distance from the existing coordinates, and auto-selects if the closest
 * match is within AUTO_PICK_METERS. Otherwise it prompts you to pick manually.
 * Resumable: rows that already have a place_id are skipped.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const MAPS_KEY = process.env.GOOGLE_MAPS_SERVER_KEY;

if (!SUPABASE_URL || !SECRET_KEY || !MAPS_KEY) {
  console.error(
    "Missing env. Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, GOOGLE_MAPS_SERVER_KEY in .env.local.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

const AUTO_PICK_METERS = 50;

type Candidate = {
  id: string;
  displayName: string;
  formattedAddress: string;
  location: { latitude: number; longitude: number };
  distanceMeters?: number;
};

function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function textSearch(query: string): Promise<Candidate[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": MAPS_KEY!,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify({ textQuery: query, pageSize: 5 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Places API ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    places?: Array<{
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
    }>;
  };
  return (json.places ?? [])
    .filter((p) => p.location && p.formattedAddress)
    .map((p) => ({
      id: p.id,
      displayName: p.displayName?.text ?? "(no name)",
      formattedAddress: p.formattedAddress!,
      location: p.location!,
    }));
}

async function main() {
  const { data, error } = await supabase
    .from("restaurants")
    .select("id, name, city, lat, lng")
    .is("place_id", null)
    .not("lat", "is", null)
    .order("id");
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) {
    console.log("All geocoded restaurants already have a place_id. Nothing to do.");
    return;
  }

  console.log(`Found ${rows.length} restaurant(s) missing a place_id.\n`);
  const rl = createInterface({ input, output });
  let saved = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as {
      id: number;
      name: string;
      city: string;
      lat: number;
      lng: number;
    };
    let query = `${row.name} ${row.city}`;

    while (true) {
      console.log(`\n[${i + 1}/${rows.length}] "${row.name}" in ${row.city} (lat=${row.lat.toFixed(5)}, lng=${row.lng.toFixed(5)})`);

      let candidates: Candidate[];
      try {
        candidates = await textSearch(query);
      } catch (e) {
        const err = e as Error & { cause?: unknown };
        const cause = err.cause instanceof Error ? ` (${err.cause.message})` : err.cause ? ` (${String(err.cause)})` : "";
        console.error(`  API error: ${err.message}${cause}`);
        const retry = (await rl.question("  Retry? [y/n]: ")).trim().toLowerCase();
        if (retry === "y" || retry === "") continue;
        skipped++;
        break;
      }

      // Annotate candidates with distance from existing coordinates.
      candidates = candidates.map((c) => ({
        ...c,
        distanceMeters: haversineMeters(
          row.lat, row.lng,
          c.location.latitude, c.location.longitude,
        ),
      }));
      candidates.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));

      const closest = candidates[0];

      // Auto-pick if the nearest result is clearly right.
      if (closest && (closest.distanceMeters ?? Infinity) <= AUTO_PICK_METERS) {
        console.log(`  Auto-picking closest match (${Math.round(closest.distanceMeters!)}m away):`);
        console.log(`    ${closest.displayName} — ${closest.formattedAddress}`);
        const { error: upErr } = await supabase
          .from("restaurants")
          .update({ place_id: closest.id })
          .eq("id", row.id);
        if (upErr) {
          console.error(`  Update failed: ${upErr.message}`);
          skipped++;
        } else {
          console.log("  ✓ Saved.");
          saved++;
        }
        break;
      }

      // Otherwise prompt.
      if (candidates.length === 0) {
        console.log("  No matches.");
      } else {
        candidates.forEach((c, idx) => {
          const dist = c.distanceMeters !== undefined ? ` ~${Math.round(c.distanceMeters)}m` : "";
          const marker = idx === 0 ? " ←" : "";
          console.log(`  ${idx + 1}. ${c.displayName} — ${c.formattedAddress}${dist}${marker}`);
        });
      }
      const skipNum = candidates.length + 1;
      const customNum = candidates.length + 2;
      console.log(`  ${skipNum}. Skip`);
      console.log(`  ${customNum}. Type custom search query`);

      const answer = (await rl.question("  Pick [1]: ")).trim();
      const choice = answer === "" ? 1 : Number(answer);

      if (!Number.isFinite(choice) || choice < 1 || choice > customNum) {
        console.log("  Invalid choice, try again.");
        continue;
      }

      if (choice === skipNum) {
        skipped++;
        break;
      }

      if (choice === customNum) {
        const next = (await rl.question("  New query: ")).trim();
        if (next) query = next;
        continue;
      }

      const picked = candidates[choice - 1];
      const { error: upErr } = await supabase
        .from("restaurants")
        .update({ place_id: picked.id })
        .eq("id", row.id);
      if (upErr) {
        console.error(`  Update failed: ${upErr.message}`);
        skipped++;
      } else {
        console.log("  ✓ Saved.");
        saved++;
      }
      break;
    }
  }

  rl.close();
  console.log(`\nDone. Saved ${saved}, skipped ${skipped}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
