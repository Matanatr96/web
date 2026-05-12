/**
 * Backfill the Google Maps primary-type-derived cuisine onto each restaurant.
 *
 * For every restaurant that has a place_id, call the Places API (New) Place
 * Details endpoint, run the result through the same fuzzy matcher the admin
 * form uses, and append the matched cuisine to restaurant_cuisines if it
 * isn't already there.
 *
 * Usage:
 *   npx tsx scripts/backfill-google-cuisine.ts             # dry run (default)
 *   npx tsx scripts/backfill-google-cuisine.ts --write     # actually insert
 */

import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { matchCuisineFromGoogleType } from "@/lib/restaurants-query";

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

const WRITE = process.argv.includes("--write");

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

type PlaceDetails = {
  primaryType?: string;
  primaryTypeDisplayName?: { text: string };
};

async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": MAPS_KEY!,
      "X-Goog-FieldMask": "primaryType,primaryTypeDisplayName",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`  Places API ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return (await res.json()) as PlaceDetails;
}

async function main() {
  // Pull every restaurant that has a place_id, plus its current cuisines.
  const { data: restaurants, error: rErr } = await supabase
    .from("restaurants")
    .select("id, name, place_id, restaurant_cuisines(cuisine_name)")
    .not("place_id", "is", null)
    .order("id");
  if (rErr) throw rErr;

  // Canonical cuisines (used to constrain matches).
  const { data: cuisineData, error: cErr } = await supabase
    .from("cuisines")
    .select("name");
  if (cErr) throw cErr;
  const cuisineList = (cuisineData ?? []).map((c) => c.name as string);
  if (cuisineList.length === 0) {
    console.error("No cuisines defined in the cuisines table.");
    process.exit(1);
  }
  console.log(`Canonical cuisine list: ${cuisineList.length} entries.`);

  const rows = (restaurants ?? []) as Array<{
    id: number;
    name: string;
    place_id: string;
    restaurant_cuisines: { cuisine_name: string }[];
  }>;
  console.log(`Found ${rows.length} restaurant(s) with a place_id.\n`);
  console.log(WRITE ? "Mode: WRITE (changes will be persisted)." : "Mode: DRY RUN (no changes).");
  console.log();

  let added = 0;
  let alreadyPresent = 0;
  let noMatch = 0;
  let apiFail = 0;
  const proposed: { id: number; name: string; cuisine: string; signal: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const existing = new Set(row.restaurant_cuisines.map((rc) => rc.cuisine_name));
    process.stdout.write(`[${i + 1}/${rows.length}] ${row.name} … `);

    const details = await getPlaceDetails(row.place_id);
    if (!details) {
      apiFail++;
      continue;
    }

    const display = details.primaryTypeDisplayName?.text;
    const raw = details.primaryType;
    const matched = matchCuisineFromGoogleType(display, raw, cuisineList);
    const signal = display ?? raw ?? "(none)";

    if (!matched) {
      console.log(`no match (type=${signal})`);
      noMatch++;
      continue;
    }
    if (existing.has(matched)) {
      console.log(`already has "${matched}"`);
      alreadyPresent++;
      continue;
    }

    console.log(`+ ${matched}  (from ${signal})`);
    proposed.push({ id: row.id, name: row.name, cuisine: matched, signal });

    if (WRITE) {
      const { error: insErr } = await supabase
        .from("restaurant_cuisines")
        .insert({ restaurant_id: row.id, cuisine_name: matched });
      if (insErr) {
        console.error(`  insert failed: ${insErr.message}`);
        apiFail++;
        continue;
      }
      added++;
    }
  }

  console.log();
  console.log(
    WRITE
      ? `Done. Added ${added}, already-present ${alreadyPresent}, no-match ${noMatch}, errors ${apiFail}.`
      : `Dry run complete. Would add ${proposed.length}, already-present ${alreadyPresent}, no-match ${noMatch}, errors ${apiFail}.`,
  );
  if (!WRITE && proposed.length > 0) {
    console.log("\nProposed additions:");
    for (const p of proposed) console.log(`  #${p.id} ${p.name} → ${p.cuisine}  [${p.signal}]`);
    console.log("\nRe-run with --write to apply.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
