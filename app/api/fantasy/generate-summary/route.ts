import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getServiceClient, getSupabase } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { computeWeeklyStats } from "@/lib/fantasy";
import { nflWeekEnd } from "@/lib/nfl-week";
import type { FantasyMatchup, FantasyOwner, FantasyPlayerScore, FantasyBanter, PowerRanking } from "@/lib/types";

const BANTER_LOOKBACK_DAYS = 60;

const client = new Anthropic();

type OwnerWeekRow = { display_name: string; points: number; result: "W" | "L" | "T" };

function buildPrompt(
  stats: ReturnType<typeof computeWeeklyStats>,
  ownerRows: OwnerWeekRow[],
  leagueName: string,
  banter: FantasyBanter[],
): string {
  if (!stats) return "";
  const { season, week, highest_scorer, lowest_scorer, biggest_blowout, closest_matchup, bench_mistake } = stats;

  const scoreLines = ownerRows
    .sort((a, b) => b.points - a.points)
    .map((o, i) => `  ${i + 1}. ${o.display_name}: ${o.points} pts (${o.result})`)
    .join("\n");

  const banterSection = banter.length > 0
    ? `\nGroup chat messages from the last ${BANTER_LOOKBACK_DAYS} days (running jokes, trades, beefs — use as context, but the recap is about this week):\n${banter.map((b) => `  [${b.sent_at.slice(0, 10)}] ${b.sender_name}: ${b.message}`).join("\n")}`
    : "";

  const lines = [
    `Fantasy football league: ${leagueName}`,
    `Season ${season}, Week ${week}`,
    "",
    "All scores this week (sorted by points):",
    scoreLines,
    "",
    `High scorer: ${highest_scorer.display_name} with ${highest_scorer.points} pts`,
    `Low scorer: ${lowest_scorer.display_name} with ${lowest_scorer.points} pts`,
    biggest_blowout
      ? `Biggest blowout: ${biggest_blowout.winner_name} demolished ${biggest_blowout.loser_name} ${biggest_blowout.winner_points}–${biggest_blowout.loser_points} (margin: ${biggest_blowout.margin.toFixed(2)})`
      : null,
    closest_matchup
      ? `Closest matchup: ${closest_matchup.winner_name} barely edged ${closest_matchup.loser_name} ${closest_matchup.winner_points}–${closest_matchup.loser_points} (margin: ${closest_matchup.margin.toFixed(2)})`
      : null,
    bench_mistake
      ? `Biggest bench mistake: ${bench_mistake.display_name} started ${bench_mistake.started_player} (${bench_mistake.started_player_pts} pts) over ${bench_mistake.benched_player} (${bench_mistake.benched_player_pts} pts) — left ${bench_mistake.pts_delta.toFixed(2)} points on the bench${bench_mistake.won_matchup ? " but still won" : " and lost the matchup"}`
      : null,
    banterSection || null,
  ].filter(Boolean);

  return `You are a brutally honest fantasy football group chat member writing the weekly recap. You've been in this league for years and have no filter. You write like a real person texting their friends — lowercase is fine, contractions, slang, the works. No corporate voice, no "it's worth noting", no "one could argue". Just say the thing.

Write three things:

1. SUMMARY — 2-4 sentences. Call out the high scorer, low scorer, closest game, and biggest blowout by name. Be mean if it's deserved. Reference the actual margins and scores. If someone got demolished, say so. If someone's bench beat their starter, rub it in. If there's group chat banter, reference it. Sound like a person, not a press release. No filler phrases like "what a week" or "the stakes were high."

2. POWER RANKINGS — Rank all ${ownerRows.length} managers 1 through ${ownerRows.length} based on this week's performance. Consider points scored, whether they won or lost, margins, and any banter context. Give each person a one-line reason — sharp, specific, and a little mean if warranted. Format each line exactly as:
[rank]. [Name] — [reason]

3. HAIKU — 5-7-5 syllables, three lines. About the bench mistake specifically (or the most embarrassing result if no bench data). Make it sting. Reference the actual player names if you can make it fit.

Format exactly as:
SUMMARY:
[your summary]

POWER RANKINGS:
1. [Name] — [reason]
2. [Name] — [reason]
...

HAIKU:
[line 1]
[line 2]
[line 3]

Week's results:
${lines.join("\n")}`;
}

function parseLLMOutput(text: string): { summary: string; haiku: string; rankings: PowerRanking[] } {
  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*?)(?=POWER RANKINGS:|$)/i);
  const rankingsMatch = text.match(/POWER RANKINGS:\s*([\s\S]*?)(?=HAIKU:|$)/i);
  const haikuMatch = text.match(/HAIKU:\s*([\s\S]*?)$/i);

  const rankingsText = rankingsMatch?.[1]?.trim() ?? "";
  const rankings: PowerRanking[] = rankingsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const m = line.match(/^(\d+)\.\s+(.+?)\s+[—–-]+\s+(.+)$/);
      if (!m) return [];
      return [{ rank: Number(m[1]), display_name: m[2].trim(), reason: m[3].trim() }];
    });

  return {
    summary: summaryMatch?.[1]?.trim() ?? text.trim(),
    haiku: haikuMatch?.[1]?.trim() ?? "",
    rankings,
  };
}

export async function POST(req: Request) {
  try {
    const authed = await isAdmin();
    if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { season, week, regenerate } = await req.json() as {
      season: number;
      week: number;
      regenerate?: boolean;
    };
    if (!season || !week) {
      return NextResponse.json({ error: "season and week are required" }, { status: 400 });
    }

    const db = getServiceClient();
    const publicDb = getSupabase();

    // Return existing summary unless regenerate is requested.
    if (!regenerate) {
      const { data: existing } = await publicDb
        .from("fantasy_weekly_summaries")
        .select("*")
        .eq("season", season)
        .eq("week", week)
        .maybeSingle();
      if (existing) return NextResponse.json({ summary: existing });
    }

    // Pull banter from the 2 months leading up to the end of this week.
    const weekEnd = nflWeekEnd(season, week) ?? new Date();
    const lookbackStart = new Date(weekEnd.getTime() - BANTER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Fetch required data in parallel.
    const [{ data: matchupData }, { data: ownerData }, { data: playerScoreData }, { data: leagueData }, { data: banterData }] =
      await Promise.all([
        publicDb.from("fantasy_matchups").select("*").eq("season", season).eq("week", week),
        publicDb.from("fantasy_owners").select("*"),
        publicDb.from("fantasy_player_scores").select("*").eq("season", season).eq("week", week),
        publicDb.from("fantasy_leagues").select("name").eq("season", season).maybeSingle(),
        publicDb
          .from("fantasy_banter")
          .select("*")
          .gte("sent_at", lookbackStart.toISOString())
          .lte("sent_at", weekEnd.toISOString())
          .order("sent_at", { ascending: true }),
      ]);

    const matchups = (matchupData ?? []) as FantasyMatchup[];
    const owners = (ownerData ?? []) as FantasyOwner[];
    const playerScores = (playerScoreData ?? []) as FantasyPlayerScore[];
    const banter = (banterData ?? []) as FantasyBanter[];
    const leagueName = leagueData?.name ?? "KFL";

    const stats = computeWeeklyStats(matchups, playerScores, owners, season, week);
    if (!stats) {
      return NextResponse.json({ error: "No matchup data for that season/week" }, { status: 404 });
    }

    // Build per-owner rows for rankings context.
    const ownerById = new Map(owners.map((o) => [o.user_id, o]));
    const seen = new Set<string>();
    const ownerRows: OwnerWeekRow[] = [];
    for (const m of matchups.filter((m) => m.season === season && m.week === week)) {
      if (seen.has(m.owner_id)) continue;
      seen.add(m.owner_id);
      ownerRows.push({
        display_name: ownerById.get(m.owner_id)?.display_name ?? m.owner_id,
        points: m.points,
        result: m.result as "W" | "L" | "T",
      });
    }

    const prompt = buildPrompt(stats, ownerRows, leagueName, banter);
    const message = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const { summary, haiku, rankings } = parseLLMOutput(text);

    const row = {
      season,
      week,
      summary,
      haiku: haiku || null,
      rankings: rankings.length > 0 ? rankings : null,
      stats,
      generated_at: new Date().toISOString(),
    };

    const { data: saved, error: upsertErr } = await db
      .from("fantasy_weekly_summaries")
      .upsert(row, { onConflict: "season,week" })
      .select()
      .single();
    if (upsertErr) throw upsertErr;

    return NextResponse.json({ summary: saved });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("generate-summary error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
