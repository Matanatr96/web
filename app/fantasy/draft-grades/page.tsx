import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type {
  FantasyDraftPick,
  FantasyLeague,
  FantasyOwner,
  FantasyPlayerScore,
  DraftGradeRow,
} from "@/lib/types";
import { computeDraftGrades, ownerColorMap } from "@/lib/fantasy";
import SeasonPicker from "@/components/season-picker";

export const dynamic = "force-dynamic";

type SearchParams = { season?: string };

export default async function DraftGradesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const db = getSupabase();

  const [{ data: leagueData }, { data: ownerData }, { data: draftPickData }] =
    await Promise.all([
      db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
      db.from("fantasy_owners").select("*"),
      db.from("fantasy_draft_picks").select("*"),
    ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const allDraftPicks = (draftPickData ?? []) as FantasyDraftPick[];

  const seasons = leagues.map((l) => l.season);
  const requestedSeason = params.season ? Number(params.season) : seasons[0];
  const season = seasons.includes(requestedSeason) ? requestedSeason : seasons[0];

  // Fetch player scores only for the selected season to keep the payload lean.
  const { data: playerScoreData } = await db
    .from("fantasy_player_scores")
    .select("*")
    .eq("season", season);
  const playerScores = (playerScoreData ?? []) as FantasyPlayerScore[];

  const colorMap = ownerColorMap(owners);
  const grades = computeDraftGrades(allDraftPicks, playerScores, owners, season);

  return (
    <div className="max-w-5xl mx-auto">
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
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Draft Grades</h1>
          <p className="mt-1 text-sm text-stone-500">
            How well did each manager&apos;s picks perform? Scored by Value Over Replacement
            (VOR): each pick&apos;s season points minus the positional replacement level (QB12,
            RB24, WR24, TE12).
          </p>
        </div>
        <SeasonPicker seasons={seasons} current={season} basePath="/fantasy/draft-grades" />
      </div>

      {grades.length === 0 ? (
        <p className="text-sm text-stone-500">
          No draft picks found for {season}. Run{" "}
          <code className="font-mono text-xs bg-stone-100 dark:bg-stone-800 px-1 rounded">
            npm run db:sync-fantasy
          </code>{" "}
          to sync draft data.
        </p>
      ) : (
        <div className="space-y-3">
          {grades.map((row, i) => (
            <GradeCard
              key={row.owner_id}
              row={row}
              rank={i + 1}
              color={colorMap.get(row.owner_id) ?? ""}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GradeCard({
  row,
  rank,
  color,
}: {
  row: DraftGradeRow;
  rank: number;
  color: string;
}) {
  const gradeColor =
    row.letter_grade === "A"
      ? "text-emerald-600 dark:text-emerald-400"
      : row.letter_grade === "B"
        ? "text-sky-600 dark:text-sky-400"
        : row.letter_grade === "C"
          ? "text-amber-600 dark:text-amber-400"
          : row.letter_grade === "D"
            ? "text-orange-600 dark:text-orange-400"
            : "text-red-600 dark:text-red-400";

  const vorSign = row.total_vor >= 0 ? "+" : "";

  return (
    <details className="group rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 overflow-hidden">
      <summary className="flex items-center gap-4 px-5 py-4 cursor-pointer select-none list-none hover:bg-stone-50 dark:hover:bg-stone-800/60 transition">
        {/* Rank */}
        <span className="text-xs text-stone-400 tabular-nums w-4 shrink-0">{rank}</span>

        {/* Name */}
        <span className={`font-semibold text-base flex-1 min-w-0 truncate ${color}`}>
          {row.display_name}
        </span>

        {/* Total VOR */}
        <span
          className={`tabular-nums font-semibold text-sm ${
            row.total_vor >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-500 dark:text-red-400"
          }`}
        >
          {vorSign}
          {row.total_vor.toFixed(1)} VOR
        </span>

        {/* Letter grade */}
        <span className={`text-xl font-bold w-8 text-right tabular-nums ${gradeColor}`}>
          {row.letter_grade}
        </span>

        {/* Expand chevron */}
        <span className="text-stone-400 text-sm ml-1 group-open:rotate-180 transition-transform">
          ▾
        </span>
      </summary>

      {/* Pick breakdown */}
      <div className="border-t border-stone-100 dark:border-stone-800 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-stone-500 bg-stone-50 dark:bg-stone-800/50">
            <tr>
              <th className="text-left px-5 py-2 font-medium">Pick</th>
              <th className="text-left px-3 py-2 font-medium">Player</th>
              <th className="text-left px-3 py-2 font-medium">Pos</th>
              <th className="text-right px-3 py-2 font-medium">Season Pts</th>
              <th className="text-right px-3 py-2 font-medium">Repl. Pts</th>
              <th className="text-right px-5 py-2 font-medium">VOR</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
            {row.picks.map((pick) => {
              const vorSign = pick.vor >= 0 ? "+" : "";
              return (
                <tr key={pick.player_id}>
                  <td className="px-5 py-2 tabular-nums text-stone-500">
                    R{pick.round}.{pick.pick_number}
                  </td>
                  <td className="px-3 py-2 font-medium">{pick.player_name}</td>
                  <td className="px-3 py-2 text-stone-500">{pick.position}</td>
                  <td className="text-right px-3 py-2 tabular-nums">
                    {pick.season_pts.toFixed(1)}
                  </td>
                  <td className="text-right px-3 py-2 tabular-nums text-stone-400">
                    {pick.replacement_pts.toFixed(1)}
                  </td>
                  <td
                    className={`text-right px-5 py-2 tabular-nums font-semibold ${
                      pick.vor >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-500 dark:text-red-400"
                    }`}
                  >
                    {vorSign}
                    {pick.vor.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
