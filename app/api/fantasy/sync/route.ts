import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";

const SLEEPER = "https://api.sleeper.app/v1";

type SleeperState = { week: number; season: string };
type SleeperMatchup = { roster_id: number; matchup_id: number | null; points: number };
type SleeperRoster = { roster_id: number; owner_id: string | null };

async function sleeperFetch<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

export async function POST() {
  try {
    const authed = await isAdmin();
    if (!authed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getServiceClient();

    const [state, { data: leagues, error: leagueErr }] = await Promise.all([
      sleeperFetch<SleeperState>(`${SLEEPER}/state/nfl`),
      db.from("fantasy_leagues").select("season, league_id").order("season", { ascending: false }),
    ]);

    if (leagueErr) throw leagueErr;
    if (!leagues || leagues.length === 0) {
      return NextResponse.json({ error: "No leagues configured." }, { status: 400 });
    }

    const latestSeason = leagues[0].season;
    const currentLeagues = leagues.filter((l) => l.season === latestSeason);
    const currentWeek = state.week ?? 1;
    let totalSynced = 0;

    for (const { season, league_id } of currentLeagues) {
      const [entries, rosters] = await Promise.all([
        sleeperFetch<SleeperMatchup[]>(
          `${SLEEPER}/league/${league_id}/matchups/${currentWeek}`,
        ).catch(() => [] as SleeperMatchup[]),
        sleeperFetch<SleeperRoster[]>(
          `${SLEEPER}/league/${league_id}/rosters`,
        ).catch(() => [] as SleeperRoster[]),
      ]);

      if (!entries || entries.length === 0) continue;
      const totalPoints = entries.reduce((s, e) => s + (e.points ?? 0), 0);
      if (totalPoints === 0) continue;

      const rosterToUser = new Map<number, string>();
      for (const r of rosters) {
        if (r.owner_id) rosterToUser.set(r.roster_id, r.owner_id);
      }

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
          season, week: currentWeek,
          owner_id: aUser, opponent_id: bUser,
          points: a.points, opponent_points: b.points, result: aResult,
        });
        rows.push({
          season, week: currentWeek,
          owner_id: bUser, opponent_id: aUser,
          points: b.points, opponent_points: a.points, result: bResult,
        });
      }

      if (rows.length === 0) continue;

      const { error } = await db
        .from("fantasy_matchups")
        .upsert(rows, { onConflict: "season,week,owner_id" });
      if (error) throw error;
      totalSynced += rows.length;
    }

    return NextResponse.json({ week: currentWeek, synced: totalSynced });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("fantasy sync error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
