/**
 * Sync fantasy football data from Sleeper into Supabase.
 *
 * Setup:
 *   1. Apply db/fantasy_schema.sql to the database.
 *   2. Insert league rows, one per season:
 *        insert into fantasy_leagues (season, league_id, name)
 *        values (2024, '1234567890', 'KFL'), ...;
 *   3. Run: npm run db:sync-fantasy
 *
 * Sleeper has no auth on read endpoints. The script is idempotent — re-runs
 * upsert by (season, week, owner_id) and refresh owner display names.
 */

import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SECRET_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in env.");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });

const SLEEPER = "https://api.sleeper.app/v1";
// Sleeper regular season is 14 weeks for most leagues; playoffs follow.
// We pull through week 18 to be safe and skip empty weeks.
const MAX_WEEK = 18;

type SleeperUser = {
  user_id: string;
  display_name: string;
  avatar: string | null;
};

type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
};

type SleeperMatchup = {
  roster_id: number;
  matchup_id: number | null;
  points: number;
};

type SleeperState = { week: number; season: string; season_type: string };

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return (await r.json()) as T;
}

async function syncSeason(season: number, leagueId: string, currentWeek: number) {
  console.log(`\n[${season}] league ${leagueId}`);

  const [users, rosters] = await Promise.all([
    fetchJson<SleeperUser[]>(`${SLEEPER}/league/${leagueId}/users`),
    fetchJson<SleeperRoster[]>(`${SLEEPER}/league/${leagueId}/rosters`),
  ]);

  // Upsert owners.
  const ownerRows = users.map((u) => ({
    user_id: u.user_id,
    display_name: u.display_name,
    avatar: u.avatar,
  }));
  const { error: ownerErr } = await db
    .from("fantasy_owners")
    .upsert(ownerRows, { onConflict: "user_id" });
  if (ownerErr) throw ownerErr;
  console.log(`  upserted ${ownerRows.length} owners`);

  // roster_id -> user_id
  const rosterToUser = new Map<number, string>();
  for (const r of rosters) {
    if (r.owner_id) rosterToUser.set(r.roster_id, r.owner_id);
  }

  let matchupCount = 0;
  for (let week = 1; week <= MAX_WEEK; week++) {
    let entries: SleeperMatchup[];
    try {
      entries = await fetchJson<SleeperMatchup[]>(
        `${SLEEPER}/league/${leagueId}/matchups/${week}`,
      );
    } catch (e) {
      console.log(`  week ${week}: fetch failed (${(e as Error).message}), stopping season`);
      break;
    }
    if (!entries || entries.length === 0) break;

    // Skip weeks where nobody has scored yet (future weeks return 0s).
    const totalPoints = entries.reduce((s, e) => s + (e.points ?? 0), 0);
    if (totalPoints === 0) {
      // For the current week, allow zero in case it just opened. Past weeks
      // with all zeros mean no data.
      if (week > currentWeek) break;
    }

    // Group by matchup_id to pair head-to-head.
    const groups = new Map<number, SleeperMatchup[]>();
    for (const e of entries) {
      if (e.matchup_id == null) continue;
      const list = groups.get(e.matchup_id) ?? [];
      list.push(e);
      groups.set(e.matchup_id, list);
    }

    const rows: Array<{
      season: number;
      week: number;
      owner_id: string;
      opponent_id: string | null;
      points: number;
      opponent_points: number;
      result: "W" | "L" | "T";
    }> = [];

    for (const [, pair] of groups) {
      if (pair.length !== 2) continue; // Skip byes / weird groupings.
      const [a, b] = pair;
      const aUser = rosterToUser.get(a.roster_id);
      const bUser = rosterToUser.get(b.roster_id);
      if (!aUser || !bUser) continue;
      const aResult: "W" | "L" | "T" =
        a.points > b.points ? "W" : a.points < b.points ? "L" : "T";
      const bResult: "W" | "L" | "T" = aResult === "T" ? "T" : aResult === "W" ? "L" : "W";
      rows.push({
        season, week, owner_id: aUser, opponent_id: bUser,
        points: a.points, opponent_points: b.points, result: aResult,
      });
      rows.push({
        season, week, owner_id: bUser, opponent_id: aUser,
        points: b.points, opponent_points: a.points, result: bResult,
      });
    }

    if (rows.length === 0) continue;
    const { error: mErr } = await db
      .from("fantasy_matchups")
      .upsert(rows, { onConflict: "season,week,owner_id" });
    if (mErr) throw mErr;
    matchupCount += rows.length;
    console.log(`  week ${week}: ${rows.length} matchup rows`);
  }
  console.log(`[${season}] done — ${matchupCount} matchup rows total`);
}

async function main() {
  const { data: leagues, error } = await db
    .from("fantasy_leagues")
    .select("season, league_id")
    .order("season", { ascending: true });
  if (error) throw error;
  if (!leagues || leagues.length === 0) {
    console.error("No rows in fantasy_leagues. Insert at least one season+league_id first.");
    process.exit(1);
  }

  const state = await fetchJson<SleeperState>(`${SLEEPER}/state/nfl`);
  const currentWeek = state.week ?? 1;

  for (const { season, league_id } of leagues) {
    await syncSeason(season, league_id, currentWeek);
  }
  console.log("\nAll done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
