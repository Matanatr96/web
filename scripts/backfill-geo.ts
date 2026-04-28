/**
 * Interactive backfill: geocode existing restaurants via Google Places Text Search.
 *
 * Usage:
 *   1. Ensure .env.local has NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, GOOGLE_MAPS_SERVER_KEY
 *   2. Run: npx tsx scripts/backfill-geo.ts
 *
 * For each restaurant where lat is null, fetches up to 5 candidate places from
 * Google and prompts you to pick one (Enter = top match). Resumable: ctrl-c
 * any time and re-run; finished rows are skipped on the next pass.
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

type Candidate = {
  id: string;
  displayName: string;
  formattedAddress: string;
  location: { latitude: number; longitude: number };
};

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
    .select("id, name, city")
    .is("lat", null)
    .order("id");
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) {
    console.log("All restaurants already have coordinates. Nothing to do.");
    return;
  }

  console.log(`Found ${rows.length} restaurant(s) to geocode.\n`);
  const rl = createInterface({ input, output });
  let saved = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let query = `${row.name} ${row.city}`;

    while (true) {
      console.log(`\n[${i + 1}/${rows.length}] "${row.name}" in ${row.city}`);
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

      if (candidates.length === 0) {
        console.log("  No matches.");
      } else {
        candidates.forEach((c, idx) => {
          const marker = idx === 0 ? " ←" : "";
          console.log(`  ${idx + 1}. ${c.displayName} — ${c.formattedAddress}${marker}`);
        });
      }
      const skipNum = candidates.length + 1;
      const customNum = candidates.length + 2;
      console.log(`  ${skipNum}. Skip`);
      console.log(`  ${customNum}. Type custom search query`);

      const answer = (await rl.question(`  Pick [1]: `)).trim();
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
        .update({
          place_id: picked.id,
          address: picked.formattedAddress,
          lat: picked.location.latitude,
          lng: picked.location.longitude,
        })
        .eq("id", row.id);
      if (upErr) {
        console.error(`  Update failed: ${upErr.message}`);
        skipped++;
      } else {
        console.log(`  ✓ Saved.`);
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
