import { NextResponse } from "next/server";
import { getServiceClient, getSupabase } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { sendSignalMessage } from "@/lib/signal";
import type { WeeklySummary } from "@/lib/types";

function formatMessage(s: WeeklySummary): string {
  const lines = [
    `📊 KFL Week ${s.week} Recap`,
    "",
    s.summary,
  ];
  if (s.haiku) {
    lines.push("", "✦ Haiku of Regret ✦", s.haiku);
  }
  return lines.join("\n");
}

export async function POST(req: Request) {
  try {
    const authed = await isAdmin();
    if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { season, week, force } = await req.json() as {
      season: number;
      week: number;
      force?: boolean;
    };
    if (!season || !week) {
      return NextResponse.json({ error: "season and week are required" }, { status: 400 });
    }

    const db = getServiceClient();
    const publicDb = getSupabase();

    const { data: row, error } = await publicDb
      .from("fantasy_weekly_summaries")
      .select("*")
      .eq("season", season)
      .eq("week", week)
      .maybeSingle();

    if (error) throw error;
    if (!row) return NextResponse.json({ error: "No summary found for that week — generate one first" }, { status: 404 });

    if (row.posted_to_signal_at && !force) {
      return NextResponse.json(
        { error: `Already posted on ${new Date(row.posted_to_signal_at).toLocaleDateString()}. Pass force:true to repost.` },
        { status: 409 }
      );
    }

    await sendSignalMessage(formatMessage(row as WeeklySummary));

    const { data: updated, error: updateErr } = await db
      .from("fantasy_weekly_summaries")
      .update({ posted_to_signal_at: new Date().toISOString() })
      .eq("season", season)
      .eq("week", week)
      .select()
      .single();

    if (updateErr) throw updateErr;

    return NextResponse.json({ summary: updated });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("post-to-signal error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
