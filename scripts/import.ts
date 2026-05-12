/**
 * Import restaurants from CSV into Supabase.
 *
 * Usage:
 *   1. Ensure .env.local contains NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *   2. Ensure db/schema.sql has been applied to the database
 *   3. Run: npm run db:import
 *
 * This script is idempotent at the row level — it truncates the table first,
 * then inserts fresh rows. Run it whenever you want to resync from the CSV.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Load .env.local first (preferred), then fall back to .env
loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY. Check .env.local.",
  );
  process.exit(1);
}

const CSV_PATH = resolve(process.cwd(), "data/restaurants-4-21.csv");

type Row = {
  name: string;
  city: string;
  category: string;
  cuisine: string;        // primary cuisine from the CSV (one per row)
  overall: number;
  food: number | null;
  value: number | null;
  service: number | null;
  ambiance: number | null;
  vegan_options: number | null;
  note: string | null;
};

/**
 * Known typo fixes — applied to every string field on import.
 * Keep this dictionary small and obvious; anything ambiguous should be
 * fixed from the admin UI after import instead.
 */
const CITY_FIXES: Record<string, string> = {
  Monetey: "Monterey",
};

const cleanString = (raw: string | undefined): string => {
  if (raw === undefined || raw === null) return "";
  // Trim whitespace + strip wrapping double quotes (sheet had `"Indian"` for one row).
  return raw.trim().replace(/^"+|"+$/g, "").trim();
};

const cleanCity = (raw: string): string => {
  const s = cleanString(raw);
  return CITY_FIXES[s] ?? s;
};

const cleanNumber = (raw: string | undefined): number | null => {
  const s = cleanString(raw);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const cleanNote = (raw: string | undefined): string | null => {
  const s = cleanString(raw);
  return s.length > 0 ? s : null;
};

async function main() {
  console.log(`Reading ${CSV_PATH}`);
  const csv = readFileSync(CSV_PATH, "utf8");

  // Parse with columns:true so we access fields by header name.
  // The sheet has a blank spacer column between Overall and Food — csv-parse
  // tolerates this by giving it an empty-string key, which we simply ignore.
  const records: Record<string, string>[] = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  const rows: Row[] = [];
  const skipped: { line: number; reason: string; raw: Record<string, string> }[] = [];

  records.forEach((r, idx) => {
    const lineNumber = idx + 2; // +2 accounts for header row + 1-indexed
    const name = cleanString(r["Place"]);
    const city = cleanCity(r["City"]);
    const overall = cleanNumber(r["Overall"]);
    const category = cleanString(r["Category"]);
    const cuisine = cleanString(r["Cuisine"]);

    if (!name) {
      skipped.push({ line: lineNumber, reason: "empty Place", raw: r });
      return;
    }
    if (overall === null) {
      skipped.push({ line: lineNumber, reason: "missing Overall", raw: r });
      return;
    }
    if (!city || !category || !cuisine) {
      skipped.push({
        line: lineNumber,
        reason: "missing city/category/cuisine",
        raw: r,
      });
      return;
    }

    rows.push({
      name,
      city,
      category,
      cuisine,
      overall,
      food: cleanNumber(r["Food"]),
      value: cleanNumber(r["Value for Money"]),
      service: cleanNumber(r["Service"]),
      ambiance: cleanNumber(r["Ambiance"]),
      vegan_options: cleanNumber(r["Vegan Options"]),
      note: cleanNote(r["Note"]),
    });
  });

  console.log(`Parsed ${rows.length} rows (skipped ${skipped.length})`);
  if (skipped.length) {
    console.log("Skipped rows:");
    for (const s of skipped) console.log(`  line ${s.line}: ${s.reason}`);
  }

  const supabase = createClient(SUPABASE_URL!, SECRET_KEY!, {
    auth: { persistSession: false },
  });

  console.log("Clearing existing rows...");
  // Delete everything. We use a WHERE clause that matches all rows because
  // Supabase requires a filter on delete() to avoid accidents.
  const { error: delErr } = await supabase
    .from("restaurants")
    .delete()
    .gt("id", 0);
  if (delErr) {
    console.error("Delete failed:", delErr);
    process.exit(1);
  }

  console.log(`Inserting ${rows.length} rows...`);
  // Restaurants table no longer has a `cuisine` column — strip it from the
  // payload and write the corresponding row into restaurant_cuisines after.
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const payload = chunk.map(({ cuisine: _cuisine, ...rest }) => rest);
    const { data: inserted, error } = await supabase
      .from("restaurants")
      .insert(payload)
      .select("id, name");
    if (error || !inserted) {
      console.error(`Insert failed at chunk starting ${i}:`, error);
      process.exit(1);
    }
    // Pair each inserted row back to its cuisine by index (insert preserves order).
    const cuisineRows = inserted.map((rec, idx) => ({
      restaurant_id: rec.id,
      cuisine_name: chunk[idx].cuisine,
    }));
    const { error: cErr } = await supabase
      .from("restaurant_cuisines")
      .insert(cuisineRows);
    if (cErr) {
      console.error(`Cuisine insert failed at chunk starting ${i}:`, cErr);
      process.exit(1);
    }
    console.log(`  inserted ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
