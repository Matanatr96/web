/**
 * Sync restaurant name and city with current Google Maps data.
 *
 * For each restaurant that has a place_id, fetches the canonical name and
 * city (locality) from the Places API and updates the DB row when they differ.
 *
 * Usage:
 *   npx tsx scripts/normalize-name-city.ts          # only rows where name/city differ
 *   npx tsx scripts/normalize-name-city.ts --all    # review every row with a place_id
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

const SHOW_ALL = process.argv.includes("--all");

type PlaceDetails = {
  displayName: string;
  city: string | null;
};

async function fetchPlaceDetails(placeId: string): Promise<PlaceDetails> {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${placeId}`,
    {
      headers: {
        "X-Goog-Api-Key": MAPS_KEY!,
        "X-Goog-FieldMask": "displayName,addressComponents",
      },
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Places API ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    displayName?: { text: string };
    addressComponents?: Array<{ longText: string; types: string[] }>;
  };

  const displayName = json.displayName?.text ?? "(no name)";

  const localityComponent = json.addressComponents?.find((c) =>
    c.types.includes("locality"),
  );
  const sublocalityComponent = json.addressComponents?.find((c) =>
    c.types.includes("sublocality"),
  );
  const city = localityComponent?.longText ?? sublocalityComponent?.longText ?? null;

  return { displayName, city };
}

async function main() {
  const { data, error } = await supabase
    .from("restaurants")
    .select("id, name, city, place_id")
    .not("place_id", "is", null)
    .order("id");
  if (error) throw error;

  const rows = (data ?? []) as {
    id: number;
    name: string;
    city: string;
    place_id: string;
  }[];

  if (rows.length === 0) {
    console.log("No restaurants with a place_id found.");
    return;
  }

  console.log(`Checking ${rows.length} restaurant(s) against Google Maps...\n`);
  const rl = createInterface({ input, output });
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    let details: PlaceDetails;
    try {
      details = await fetchPlaceDetails(row.place_id);
    } catch (e) {
      const err = e as Error;
      console.error(`[${i + 1}/${rows.length}] "${row.name}" — API error: ${err.message}`);
      errors++;
      continue;
    }

    const nameDiffers = details.displayName !== row.name;
    const cityDiffers = details.city !== null && details.city !== row.city;

    if (!nameDiffers && !cityDiffers) {
      if (SHOW_ALL) {
        console.log(`[${i + 1}/${rows.length}] "${row.name}" — no changes.`);
      }
      continue;
    }

    console.log(`\n[${i + 1}/${rows.length}] id=${row.id}`);
    if (nameDiffers) {
      console.log(`  name:  "${row.name}"  →  "${details.displayName}"`);
    } else {
      console.log(`  name:  "${row.name}" (unchanged)`);
    }
    if (cityDiffers) {
      console.log(`  city:  "${row.city}"  →  "${details.city}"`);
    } else {
      console.log(`  city:  "${row.city}" (unchanged)`);
    }

    const answer = (await rl.question("  Apply? [Y/n/s(kip all)]: "))
      .trim()
      .toLowerCase();

    if (answer === "s") {
      console.log("  Stopping early.");
      skipped++;
      break;
    }

    if (answer === "n") {
      skipped++;
      continue;
    }

    const patch: Record<string, string> = {};
    if (nameDiffers) patch.name = details.displayName;
    if (cityDiffers) patch.city = details.city!;

    const { error: upErr } = await supabase
      .from("restaurants")
      .update(patch)
      .eq("id", row.id);

    if (upErr) {
      console.error(`  Update failed: ${upErr.message}`);
      errors++;
    } else {
      console.log("  ✓ Updated.");
      updated++;
    }
  }

  rl.close();
  console.log(`\nDone. Updated ${updated}, skipped ${skipped}, errors ${errors}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
