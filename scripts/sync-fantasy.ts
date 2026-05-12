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
  players: string[] | null;
  starters: string[] | null;
  players_points: Record<string, number> | null;
};

type SleeperState = { week: number; season: string; season_type: string };

type SleeperLeague = {
  name: string;
  settings: { playoff_week_start?: number; [k: string]: unknown };
};

type SleeperPlayer = {
  player_id?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string | null;
  team?: string | null;
};

type SleeperDraftPick = {
  season: string;
  round: number;
  roster_id: number;            // original owner roster_id
  previous_owner_id: number;
  owner_id: number;             // new owner roster_id
};

type SleeperWaiverBudget = {
  sender: number;
  receiver: number;
  amount: number;
};

type SleeperTransaction = {
  transaction_id: string;
  type: string;                 // "trade" | "waiver" | "free_agent" | ...
  status: string;               // "complete" | "failed"
  created: number;              // ms epoch
  leg: number;                  // week
  roster_ids: number[];
  adds: Record<string, number> | null;   // player_id -> roster_id receiving
  drops: Record<string, number> | null;  // player_id -> roster_id giving up
  draft_picks: SleeperDraftPick[];
  waiver_budget: SleeperWaiverBudget[];
};

type SleeperBracketEntry = {
  r: number;          // round number (1-indexed)
  m: number;          // matchup id within round
  t1: number | null;  // roster_id of team 1
  t2: number | null;  // roster_id of team 2
  w: number | null;   // winning roster_id
  l: number | null;   // losing roster_id
  p?: number;         // placement (1 = championship, 3 = 3rd, etc.)
  t1_from?: { w?: number; l?: number };
  t2_from?: { w?: number; l?: number };
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return (await r.json()) as T;
}

type PlayerMap = Map<string, { name: string; position: string | null; team: string | null }>;

function buildPlayerMap(raw: Record<string, SleeperPlayer>): PlayerMap {
  const map: PlayerMap = new Map();
  for (const [pid, p] of Object.entries(raw)) {
    const name =
      p.full_name ??
      [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ??
      pid;
    map.set(pid, {
      name: name || pid,
      position: p.position ?? null,
      team: p.team ?? null,
    });
  }
  return map;
}

async function syncSeason(
  season: number,
  leagueId: string,
  currentWeek: number,
  players: PlayerMap,
) {
  console.log(`\n[${season}] league ${leagueId}`);

  const [users, rosters, league, winnersBracket] = await Promise.all([
    fetchJson<SleeperUser[]>(`${SLEEPER}/league/${leagueId}/users`),
    fetchJson<SleeperRoster[]>(`${SLEEPER}/league/${leagueId}/rosters`),
    fetchJson<SleeperLeague>(`${SLEEPER}/league/${leagueId}`),
    fetchJson<SleeperBracketEntry[]>(`${SLEEPER}/league/${leagueId}/winners_bracket`).catch(() => [] as SleeperBracketEntry[]),
  ]);

  // Translate bracket from roster_id to user_id so the page can look up
  // owners directly without joining rosters.
  const rosterToUserForBracket = new Map<number, string>();
  for (const r of rosters) {
    if (r.owner_id) rosterToUserForBracket.set(r.roster_id, r.owner_id);
  }
  const translatedBracket = winnersBracket.map((b) => ({
    r: b.r,
    m: b.m,
    p: b.p ?? null,
    t1: b.t1 != null ? rosterToUserForBracket.get(b.t1) ?? null : null,
    t2: b.t2 != null ? rosterToUserForBracket.get(b.t2) ?? null : null,
    w:  b.w  != null ? rosterToUserForBracket.get(b.w)  ?? null : null,
    l:  b.l  != null ? rosterToUserForBracket.get(b.l)  ?? null : null,
    t1_from: b.t1_from ?? null,
    t2_from: b.t2_from ?? null,
  }));

  const playoffStart = league.settings?.playoff_week_start ?? null;
  const { error: lErr } = await db
    .from("fantasy_leagues")
    .update({
      name: league.name,
      playoff_week_start: playoffStart,
      winners_bracket: translatedBracket.length > 0 ? translatedBracket : null,
    })
    .eq("season", season);
  if (lErr) throw lErr;
  console.log(`  league: playoff_week_start=${playoffStart}, bracket entries=${translatedBracket.length}`);

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

    // Store player-level scores for bench mistake computation.
    const playerScoreRows: Array<{
      season: number;
      week: number;
      owner_id: string;
      player_id: string;
      player_name: string;
      position: string | null;
      team: string | null;
      points: number;
      is_starter: boolean;
    }> = [];
    for (const entry of entries) {
      const ownerId = rosterToUser.get(entry.roster_id);
      if (!ownerId) continue;
      const playerIds = entry.players ?? [];
      const starterSet = new Set(entry.starters ?? []);
      const pointsMap = entry.players_points ?? {};
      for (const pid of playerIds) {
        const meta = players.get(pid);
        playerScoreRows.push({
          season,
          week,
          owner_id: ownerId,
          player_id: pid,
          player_name: meta?.name ?? pid,
          position: meta?.position ?? null,
          team: meta?.team ?? null,
          points: pointsMap[pid] ?? 0,
          is_starter: starterSet.has(pid),
        });
      }
    }
    if (playerScoreRows.length > 0) {
      const { error: psErr } = await db
        .from("fantasy_player_scores")
        .upsert(playerScoreRows, { onConflict: "season,week,owner_id,player_id" });
      if (psErr) throw psErr;
    }

    console.log(`  week ${week}: ${rows.length} matchup rows, ${playerScoreRows.length} player score rows`);
  }
  console.log(`[${season}] done — ${matchupCount} matchup rows total`);

  // Trades: walk weeks 1..MAX_WEEK and grab any completed trades.
  const ownerNameById = new Map<string, string>();
  for (const u of users) ownerNameById.set(u.user_id, u.display_name);

  const tradeRows: Array<{
    id: string;
    season: number;
    week: number;
    status: string;
    created_ms: number;
    user_ids: string[];
    payload: Record<string, {
      players: Array<{ player_id: string; name: string; position: string | null; team: string | null }>;
      picks: Array<{ season: string; round: number; original_owner_id: string | null; original_owner_name: string | null }>;
      faab: number;
    }>;
  }> = [];

  for (let week = 1; week <= MAX_WEEK; week++) {
    let txns: SleeperTransaction[];
    try {
      txns = await fetchJson<SleeperTransaction[]>(
        `${SLEEPER}/league/${leagueId}/transactions/${week}`,
      );
    } catch {
      continue;
    }
    if (!Array.isArray(txns)) continue;

    for (const t of txns) {
      if (t.type !== "trade" || t.status !== "complete") continue;

      // Build per-side payload keyed by user_id.
      const side: Record<string, {
        players: Array<{ player_id: string; name: string; position: string | null; team: string | null }>;
        picks: Array<{ season: string; round: number; original_owner_id: string | null; original_owner_name: string | null }>;
        faab: number;
      }> = {};
      const ensure = (uid: string) => {
        if (!side[uid]) side[uid] = { players: [], picks: [], faab: 0 };
        return side[uid];
      };
      const uidFor = (rosterId: number): string | null =>
        rosterToUser.get(rosterId) ?? null;

      const userIds: string[] = [];
      for (const rid of t.roster_ids) {
        const uid = uidFor(rid);
        if (uid && !userIds.includes(uid)) userIds.push(uid);
      }

      // Players: each `add` lists who *received* a player. The corresponding
      // `drop` would be the previous owner — equivalent for trades.
      if (t.adds) {
        for (const [pid, rid] of Object.entries(t.adds)) {
          const uid = uidFor(rid);
          if (!uid) continue;
          const meta = players.get(pid);
          ensure(uid).players.push({
            player_id: pid,
            name: meta?.name ?? pid,
            position: meta?.position ?? null,
            team: meta?.team ?? null,
          });
        }
      }

      // Draft picks: `owner_id` is the new owner roster_id.
      for (const p of t.draft_picks ?? []) {
        const uid = uidFor(p.owner_id);
        if (!uid) continue;
        const origUid = uidFor(p.roster_id);
        ensure(uid).picks.push({
          season: p.season,
          round: p.round,
          original_owner_id: origUid,
          original_owner_name: origUid ? ownerNameById.get(origUid) ?? null : null,
        });
      }

      // FAAB swaps: receiver +amount, sender -amount.
      for (const w of t.waiver_budget ?? []) {
        const recv = uidFor(w.receiver);
        const sender = uidFor(w.sender);
        if (recv) ensure(recv).faab += w.amount;
        if (sender) ensure(sender).faab -= w.amount;
      }

      tradeRows.push({
        id: t.transaction_id,
        season,
        week,
        status: t.status,
        created_ms: t.created,
        user_ids: userIds,
        payload: side,
      });
    }
  }

  if (tradeRows.length > 0) {
    const { error: tErr } = await db
      .from("fantasy_trades")
      .upsert(tradeRows, { onConflict: "id" });
    if (tErr) throw tErr;
  }
  console.log(`  trades: ${tradeRows.length} rows`);
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

  // Sleeper recommends caching /players/nfl (~5MB) and refreshing at most
  // once per day. We fetch it once per script run.
  console.log("Fetching /players/nfl …");
  const rawPlayers = await fetchJson<Record<string, SleeperPlayer>>(
    `${SLEEPER}/players/nfl`,
  );
  const players = buildPlayerMap(rawPlayers);
  console.log(`  loaded ${players.size} players`);

  for (const { season, league_id } of leagues) {
    await syncSeason(season, league_id, currentWeek, players);
  }
  console.log("\nAll done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
