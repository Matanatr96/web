import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";

const SLEEPER = "https://api.sleeper.app/v1";
const MAX_WEEK = 18;
const PLAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type SleeperState = { week: number; season: string };

type SleeperUser = {
  user_id: string;
  display_name: string;
  avatar: string | null;
};

type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
};

type SleeperLeague = {
  name: string;
  settings?: { playoff_week_start?: number; [k: string]: unknown };
};

type SleeperBracketEntry = {
  r: number;
  m: number;
  t1: number | null;
  t2: number | null;
  w: number | null;
  l: number | null;
  p?: number;
  t1_from?: { w?: number; l?: number };
  t2_from?: { w?: number; l?: number };
};

type SleeperMatchup = {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  players: string[] | null;
  starters: string[] | null;
  players_points: Record<string, number> | null;
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
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
};

type SleeperWaiverBudget = {
  sender: number;
  receiver: number;
  amount: number;
};

type SleeperTransaction = {
  transaction_id: string;
  type: string;
  status: string;
  created: number;
  leg: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: SleeperDraftPick[];
  waiver_budget: SleeperWaiverBudget[];
};

type SleeperDraftMeta = {
  draft_id: string;
  status: string;
  type: string;
  season: string;
  season_type: string;
  league_id: string;
};

type SleeperPickRaw = {
  draft_id: string;
  picked_by: string;
  player_id: string;
  round: number;
  pick_no: number;
  metadata?: {
    position?: string;
    team?: string;
    first_name?: string;
    last_name?: string;
    adp_formatted?: string;
    adp?: string;
  };
};

type PlayerMeta = {
  name: string;
  position: string | null;
  team: string | null;
};

type PlayerMap = Map<string, PlayerMeta>;

let cachedPlayers: { map: PlayerMap; fetchedAt: number } | null = null;

async function sleeperFetch<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

async function getPlayersMap(): Promise<PlayerMap> {
  if (cachedPlayers && Date.now() - cachedPlayers.fetchedAt < PLAYER_CACHE_TTL_MS) {
    return cachedPlayers.map;
  }
  try {
    const raw = await sleeperFetch<Record<string, SleeperPlayer>>(`${SLEEPER}/players/nfl`);
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
    cachedPlayers = { map, fetchedAt: Date.now() };
    return map;
  } catch (err) {
    console.warn("[fantasy-sync] /players/nfl fetch failed, falling back to empty map:", err);
    return cachedPlayers?.map ?? new Map();
  }
}

async function isAuthorized(req: Request): Promise<boolean> {
  if (await isAdmin()) return true;
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authHeader = req.headers.get("authorization");
  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret");
  return authHeader === `Bearer ${expected}` || querySecret === expected;
}

async function handleSync(req: Request) {
  try {
    if (!(await isAuthorized(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const syncAllSeasons = url.searchParams.get("all") === "1";

    const db = getServiceClient();

    const [state, { data: leagues, error: leagueErr }, players] = await Promise.all([
      sleeperFetch<SleeperState>(`${SLEEPER}/state/nfl`),
      db.from("fantasy_leagues").select("season, league_id").order("season", { ascending: false }),
      getPlayersMap(),
    ]);

    if (leagueErr) throw leagueErr;
    if (!leagues || leagues.length === 0) {
      return NextResponse.json({ error: "No leagues configured." }, { status: 400 });
    }

    const latestSeason = leagues[0].season;
    const targetLeagues = syncAllSeasons
      ? leagues
      : leagues.filter((l) => l.season === latestSeason);

    const currentWeek = Math.min(Math.max(state.week ?? 1, 1), MAX_WEEK);
    let totalSynced = 0;
    let totalTradesSynced = 0;
    const weeksSyncedSet = new Set<number>();

    for (const { season, league_id } of targetLeagues) {
      const maxWeekForSeason = season < Number(state.season ?? latestSeason) ? MAX_WEEK : currentWeek;

      const [users, rosters, leagueMeta, winnersBracket] = await Promise.all([
        sleeperFetch<SleeperUser[]>(`${SLEEPER}/league/${league_id}/users`).catch(() => [] as SleeperUser[]),
        sleeperFetch<SleeperRoster[]>(`${SLEEPER}/league/${league_id}/rosters`).catch(() => [] as SleeperRoster[]),
        sleeperFetch<SleeperLeague>(`${SLEEPER}/league/${league_id}`).catch(() => null),
        sleeperFetch<SleeperBracketEntry[]>(`${SLEEPER}/league/${league_id}/winners_bracket`).catch(
          () => [] as SleeperBracketEntry[],
        ),
      ]);

      const rosterToUser = new Map<number, string>();
      for (const r of rosters) {
        if (r.owner_id) rosterToUser.set(r.roster_id, r.owner_id);
      }

      // 1. Update league metadata + translated bracket.
      if (leagueMeta) {
        const translatedBracket = winnersBracket.map((b) => ({
          r: b.r,
          m: b.m,
          p: b.p ?? null,
          t1: b.t1 != null ? rosterToUser.get(b.t1) ?? null : null,
          t2: b.t2 != null ? rosterToUser.get(b.t2) ?? null : null,
          w: b.w != null ? rosterToUser.get(b.w) ?? null : null,
          l: b.l != null ? rosterToUser.get(b.l) ?? null : null,
          t1_from: b.t1_from ?? null,
          t2_from: b.t2_from ?? null,
        }));

        const { error: lErr } = await db
          .from("fantasy_leagues")
          .update({
            name: leagueMeta.name,
            playoff_week_start: leagueMeta.settings?.playoff_week_start ?? null,
            winners_bracket: translatedBracket.length > 0 ? translatedBracket : null,
          })
          .eq("season", season);
        if (lErr) throw lErr;
      }

      // 2. Upsert owners so FK constraints and display names stay current.
      if (users.length > 0) {
        const ownerRows = users.map((u) => ({
          user_id: u.user_id,
          display_name: u.display_name,
          avatar: u.avatar,
        }));
        const { error: ownerErr } = await db
          .from("fantasy_owners")
          .upsert(ownerRows, { onConflict: "user_id" });
        if (ownerErr) throw ownerErr;
      }

      // 3. Fetch all weeks 1..maxWeekForSeason in parallel so completed weeks
      // (e.g. Week 4 after Sleeper rolls state.week to 5 on Wednesday) and any
      // stat corrections are always ingested.
      const weeks = Array.from({ length: maxWeekForSeason }, (_, i) => i + 1);
      const weeklyMatchups = await Promise.all(
        weeks.map(async (week) => ({
          week,
          entries: await sleeperFetch<SleeperMatchup[]>(
            `${SLEEPER}/league/${league_id}/matchups/${week}`,
          ).catch(() => [] as SleeperMatchup[]),
        })),
      );

      for (const { week, entries } of weeklyMatchups) {
        if (!entries || entries.length === 0) continue;
        const totalPoints = entries.reduce((s, e) => s + (e.points ?? 0), 0);
        if (totalPoints === 0) continue;

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
          if (pair.length !== 2) continue;
          const [a, b] = pair;
          const aUser = rosterToUser.get(a.roster_id);
          const bUser = rosterToUser.get(b.roster_id);
          if (!aUser || !bUser) continue;
          const aResult: "W" | "L" | "T" =
            a.points > b.points ? "W" : a.points < b.points ? "L" : "T";
          const bResult: "W" | "L" | "T" =
            aResult === "T" ? "T" : aResult === "W" ? "L" : "W";
          rows.push({
            season,
            week,
            owner_id: aUser,
            opponent_id: bUser,
            points: a.points,
            opponent_points: b.points,
            result: aResult,
          });
          rows.push({
            season,
            week,
            owner_id: bUser,
            opponent_id: aUser,
            points: b.points,
            opponent_points: a.points,
            result: bResult,
          });
        }

        if (rows.length === 0) continue;

        const { error } = await db
          .from("fantasy_matchups")
          .upsert(rows, { onConflict: "season,week,owner_id" });
        if (error) throw error;
        totalSynced += rows.length;
        weeksSyncedSet.add(week);

        // Sync player-level scores with resolved player names & positions.
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
          const starterSet = new Set(entry.starters ?? []);
          const pointsMap = entry.players_points ?? {};
          for (const pid of entry.players ?? []) {
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
      }

      // 4. Sync completed trades across weeks 1..maxWeekForSeason.
      const ownerNameById = new Map(users.map((u) => [u.user_id, u.display_name]));
      const weeklyTxns = await Promise.all(
        weeks.map(async (week) => ({
          week,
          txns: await sleeperFetch<SleeperTransaction[]>(
            `${SLEEPER}/league/${league_id}/transactions/${week}`,
          ).catch(() => [] as SleeperTransaction[]),
        })),
      );

      const tradeRows: Array<{
        id: string;
        season: number;
        week: number;
        status: string;
        created_ms: number;
        user_ids: string[];
        payload: Record<
          string,
          {
            players: Array<{ player_id: string; name: string; position: string | null; team: string | null }>;
            picks: Array<{
              season: string;
              round: number;
              original_owner_id: string | null;
              original_owner_name: string | null;
            }>;
            faab: number;
          }
        >;
      }> = [];

      for (const { week, txns } of weeklyTxns) {
        if (!Array.isArray(txns)) continue;
        for (const t of txns) {
          if (t.type !== "trade" || t.status !== "complete") continue;
          const side: Record<
            string,
            {
              players: Array<{ player_id: string; name: string; position: string | null; team: string | null }>;
              picks: Array<{
                season: string;
                round: number;
                original_owner_id: string | null;
                original_owner_name: string | null;
              }>;
              faab: number;
            }
          > = {};
          const ensure = (uid: string) => {
            if (!side[uid]) side[uid] = { players: [], picks: [], faab: 0 };
            return side[uid];
          };
          const uidFor = (rosterId: number): string | null => rosterToUser.get(rosterId) ?? null;

          const userIds: string[] = [];
          for (const rid of t.roster_ids ?? []) {
            const uid = uidFor(rid);
            if (uid && !userIds.includes(uid)) userIds.push(uid);
          }

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
        totalTradesSynced += tradeRows.length;
      }

      // 5. Sync completed regular-season draft picks if present.
      const drafts = await sleeperFetch<SleeperDraftMeta[]>(
        `${SLEEPER}/league/${league_id}/drafts`,
      ).catch(() => [] as SleeperDraftMeta[]);
      const completedDrafts = drafts.filter(
        (d) => d.status === "complete" && d.season_type === "regular",
      );
      for (const draft of completedDrafts) {
        const rawPicks = await sleeperFetch<SleeperPickRaw[]>(
          `${SLEEPER}/draft/${draft.draft_id}/picks`,
        ).catch(() => [] as SleeperPickRaw[]);
        const pickRows = rawPicks
          .filter((p) => p.picked_by)
          .map((p) => {
            const meta = players.get(p.player_id);
            const adpStr = p.metadata?.adp_formatted ?? p.metadata?.adp;
            const fallbackName =
              [p.metadata?.first_name ?? "", p.metadata?.last_name ?? ""]
                .filter(Boolean)
                .join(" ") || p.player_id;
            return {
              season,
              league_id,
              draft_id: draft.draft_id,
              owner_id: p.picked_by,
              player_id: p.player_id,
              player_name: meta?.name ?? fallbackName,
              position: meta?.position ?? p.metadata?.position ?? null,
              team: meta?.team ?? p.metadata?.team ?? null,
              round: p.round,
              pick_number: p.pick_no,
              adp: adpStr ? parseFloat(adpStr) : null,
            };
          });
        if (pickRows.length > 0) {
          const { error: dpErr } = await db
            .from("fantasy_draft_picks")
            .upsert(pickRows, { onConflict: "draft_id,pick_number" });
          if (dpErr) throw dpErr;
        }
      }
    }

    const weeksSynced = [...weeksSyncedSet].sort((a, b) => a - b);
    const latestScoredWeek = weeksSynced.length > 0 ? weeksSynced[weeksSynced.length - 1] : currentWeek;

    return NextResponse.json({
      season: latestSeason,
      week: latestScoredWeek,
      currentWeek,
      weeksSynced,
      synced: totalSynced,
      tradesSynced: totalTradesSynced,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("fantasy sync error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Triggers a Sleeper fantasy football sync via GET (used by scheduled cron workflows).
 * Requires either an active admin session cookie or a valid `CRON_SECRET` bearer/query token.
 *
 * @param req - Incoming HTTP request.
 * @returns JSON response containing synced weeks and row counts.
 */
export async function GET(req: Request) {
  return handleSync(req);
}

/**
 * Triggers a Sleeper fantasy football sync via POST (used by admin UI buttons and manual triggers).
 * Syncs owners, league metadata, all scored weeks `1..currentWeek`, player scores with metadata,
 * completed trades, and draft picks for the active season (or all seasons when `?all=1`).
 *
 * @param req - Incoming HTTP request.
 * @returns JSON response containing synced weeks and row counts.
 */
export async function POST(req: Request) {
  return handleSync(req);
}
