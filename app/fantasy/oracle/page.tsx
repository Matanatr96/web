import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { computeWeeklyStats } from "@/lib/fantasy";
import type { FantasyLeague, FantasyMatchup, FantasyOwner, FantasyPlayerScore, WeeklySummary } from "@/lib/types";
import SeasonPicker from "@/components/season-picker";
import OracleWeekView from "./OracleWeekView";

export const dynamic = "force-dynamic";

type SearchParams = { season?: string; week?: string };

export default async function OraclePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const db = getSupabase();
  const admin = await isAdmin();

  const [
    { data: leagueData },
    { data: ownerData },
    { data: matchupData },
    { data: summaryData },
  ] = await Promise.all([
    db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
    db.from("fantasy_owners").select("*"),
    db.from("fantasy_matchups").select("*").order("season", { ascending: false }),
    db.from("fantasy_weekly_summaries").select("*").order("season", { ascending: false }).order("week", { ascending: false }),
  ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const matchups = (matchupData ?? []) as FantasyMatchup[];
  const summaries = (summaryData ?? []) as WeeklySummary[];

  const seasons = [...new Set(leagues.map((l) => l.season))].sort((a, b) => b - a);
  const requestedSeason = params.season ? Number(params.season) : seasons[0];
  const season = seasons.includes(requestedSeason) ? requestedSeason : seasons[0];

  // Available weeks for this season (weeks that have matchup data).
  const seasonMatchups = matchups.filter((m) => m.season === season && m.points > 0);
  const availableWeeks = [...new Set(seasonMatchups.map((m) => m.week))].sort((a, b) => b - a);
  const requestedWeek = params.week ? Number(params.week) : availableWeeks[0];
  const week = availableWeeks.includes(requestedWeek) ? requestedWeek : availableWeeks[0];

  // Fetch player scores for selected week only.
  const { data: playerScoreData } = await db
    .from("fantasy_player_scores")
    .select("*")
    .eq("season", season)
    .eq("week", week);
  const playerScores = (playerScoreData ?? []) as FantasyPlayerScore[];

  const stats = week
    ? computeWeeklyStats(matchups, playerScores, owners, season, week)
    : null;

  const currentSummary = summaries.find((s) => s.season === season && s.week === week) ?? null;
  const pastSummaries = summaries.filter((s) => !(s.season === season && s.week === week));

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <Link
          href="/fantasy"
          className="text-sm text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition"
        >
          ← Fantasy
        </Link>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-3 mb-8">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Oracle of Regret</h1>
          <p className="mt-1 text-sm text-stone-500">
            Weekly summaries, bench mistakes, and haikus of shame.
          </p>
        </div>
        <SeasonPicker seasons={seasons} current={season} basePath="/fantasy/oracle" />
      </div>

      {/* Week picker */}
      {availableWeeks.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {availableWeeks.map((w) => (
            <Link
              key={w}
              href={`/fantasy/oracle?season=${season}&week=${w}`}
              className={`px-3 py-1 text-sm rounded-full border transition ${
                w === week
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 border-transparent"
                  : "border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800"
              }`}
            >
              Week {w}
              {summaries.some((s) => s.season === season && s.week === w) && (
                <span className="ml-1 text-violet-500">●</span>
              )}
            </Link>
          ))}
        </div>
      )}

      {/* Current week view */}
      {week ? (
        <section className="mb-12">
          <h2 className="text-lg font-semibold mb-4">Week {week}</h2>
          <OracleWeekView
            season={season}
            week={week}
            stats={stats}
            initialSummary={currentSummary}
            isAdmin={admin}
          />
        </section>
      ) : (
        <p className="text-sm text-stone-500">No matchup data available for {season}.</p>
      )}

      {/* Hall of Regret — past summaries */}
      {pastSummaries.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold mb-4">Hall of Regret</h2>
          <div className="space-y-4">
            {pastSummaries.map((s) => (
              <div
                key={`${s.season}-${s.week}`}
                className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <Link
                    href={`/fantasy/oracle?season=${s.season}&week=${s.week}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {s.season} · Week {s.week}
                  </Link>
                  <span className="text-xs text-stone-400">
                    {new Date(s.generated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400 mb-3 line-clamp-2">{s.summary}</p>
                {s.haiku && (
                  <pre className="text-xs font-serif italic text-violet-500 dark:text-violet-400 whitespace-pre-wrap border-l-2 border-violet-400 pl-3">
                    {s.haiku}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
