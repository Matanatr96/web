import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getServiceClient, getSupabase } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { computeWeeklyStats } from "@/lib/fantasy";
import type { FantasyMatchup, FantasyOwner, FantasyPlayerScore } from "@/lib/types";

const client = new Anthropic();

function buildPrompt(stats: ReturnType<typeof computeWeeklyStats>, leagueName: string): string {
  if (!stats) return "";
  const { season, week, highest_scorer, lowest_scorer, biggest_blowout, closest_matchup, bench_mistake } = stats;

  const lines = [
    `Fantasy football league: ${leagueName}`,
    `Season ${season}, Week ${week}`,
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
  ].filter(Boolean);

  return `You are the sardonic, all-knowing Oracle of a fantasy football league. Given this week's results, write two things:

1. A SHORT SUMMARY (2-3 sentences) of the week's most notable moments. Be specific, reference names, be witty and a little mean — roast people if they deserve it. Don't be generic.

2. A HAIKU (5-7-5 syllables, three lines) specifically about the biggest bench mistake. If there is no bench mistake data, write the haiku about the week's most embarrassing result instead. The haiku should be poetic, cutting, and reference the actual players involved.

Format your response as:
SUMMARY:
[your summary here]

HAIKU:
[line 1]
[line 2]
[line 3]

Here are the week's results:
${lines.join("\n")}`;
}

function parseSummaryAndHaiku(text: string): { summary: string; haiku: string } {
  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*?)(?=HAIKU:|$)/i);
  const haikuMatch = text.match(/HAIKU:\s*([\s\S]*?)$/i);
  return {
    summary: summaryMatch?.[1]?.trim() ?? text.trim(),
    haiku: haikuMatch?.[1]?.trim() ?? "",
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

    // Fetch required data in parallel.
    const [{ data: matchupData }, { data: ownerData }, { data: playerScoreData }, { data: leagueData }] =
      await Promise.all([
        publicDb.from("fantasy_matchups").select("*").eq("season", season).eq("week", week),
        publicDb.from("fantasy_owners").select("*"),
        publicDb.from("fantasy_player_scores").select("*").eq("season", season).eq("week", week),
        publicDb.from("fantasy_leagues").select("name").eq("season", season).maybeSingle(),
      ]);

    const matchups = (matchupData ?? []) as FantasyMatchup[];
    const owners = (ownerData ?? []) as FantasyOwner[];
    const playerScores = (playerScoreData ?? []) as FantasyPlayerScore[];
    const leagueName = leagueData?.name ?? "KFL";

    const stats = computeWeeklyStats(matchups, playerScores, owners, season, week);
    if (!stats) {
      return NextResponse.json({ error: "No matchup data for that season/week" }, { status: 404 });
    }

    const prompt = buildPrompt(stats, leagueName);
    const message = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const { summary, haiku } = parseSummaryAndHaiku(text);

    const row = {
      season,
      week,
      summary,
      haiku: haiku || null,
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
