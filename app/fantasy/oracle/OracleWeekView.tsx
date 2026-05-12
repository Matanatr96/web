"use client";

import { useState } from "react";
import GenerateSummaryButton from "./GenerateSummaryButton";
import PostToSignalButton from "./PostToSignalButton";
import SyncBanterButton from "./SyncBanterButton";
import type { WeeklySummary, WeeklyStats, FantasyBanter } from "@/lib/types";

type Props = {
  season: number;
  week: number;
  stats: WeeklyStats | null;
  initialSummary: WeeklySummary | null;
  initialBanter: FantasyBanter[];
  isAdmin: boolean;
};

export default function OracleWeekView({ season, week, stats, initialSummary, initialBanter, isAdmin }: Props) {
  const [summary, setSummary] = useState<WeeklySummary | null>(initialSummary);
  const [banter, setBanter] = useState<FantasyBanter[]>(initialBanter);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  function handleSynced(imported: number) {
    setSyncMessage(imported > 0 ? `${imported} new message${imported !== 1 ? "s" : ""} pulled` : "No new messages");
  }

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <StatCard label="High Scorer" value={`${stats.highest_scorer.display_name}`} sub={`${stats.highest_scorer.points} pts`} accent="emerald" />
          <StatCard label="Low Scorer" value={`${stats.lowest_scorer.display_name}`} sub={`${stats.lowest_scorer.points} pts`} accent="red" />
          {stats.biggest_blowout && (
            <StatCard
              label="Biggest Blowout"
              value={`${stats.biggest_blowout.winner_name} over ${stats.biggest_blowout.loser_name}`}
              sub={`${stats.biggest_blowout.winner_points}–${stats.biggest_blowout.loser_points} (+${stats.biggest_blowout.margin.toFixed(2)})`}
              accent="amber"
            />
          )}
          {stats.closest_matchup && (
            <StatCard
              label="Closest Matchup"
              value={`${stats.closest_matchup.winner_name} over ${stats.closest_matchup.loser_name}`}
              sub={`${stats.closest_matchup.winner_points}–${stats.closest_matchup.loser_points} (margin: ${stats.closest_matchup.margin.toFixed(2)})`}
              accent="sky"
            />
          )}
          {stats.bench_mistake && (
            <div className="sm:col-span-2">
              <StatCard
                label="Oracle of Regret — Biggest Bench Mistake"
                value={`${stats.bench_mistake.display_name}`}
                sub={`Started ${stats.bench_mistake.started_player} (${stats.bench_mistake.started_player_pts} pts) over ${stats.bench_mistake.benched_player} (${stats.bench_mistake.benched_player_pts} pts) — left ${stats.bench_mistake.pts_delta.toFixed(2)} pts on bench${stats.bench_mistake.won_matchup ? ", still won" : ", and lost"}`}
                accent="violet"
              />
            </div>
          )}
        </div>
      )}

      {!stats && (
        <p className="text-sm text-stone-500">No matchup data for week {week}.</p>
      )}

      {/* Generated summary */}
      {summary ? (
        <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-400 mb-1">Weekly Summary</p>
            <p className="text-sm leading-relaxed text-stone-700 dark:text-stone-300">{summary.summary}</p>
          </div>

          {/* Power Rankings */}
          {summary.rankings && summary.rankings.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-stone-400 mb-2">Power Rankings</p>
              <ol className="space-y-1">
                {summary.rankings.map((r) => (
                  <li key={r.rank} className="flex gap-2 text-sm">
                    <span className={`w-5 shrink-0 font-semibold ${r.rank <= 3 ? "text-emerald-600 dark:text-emerald-400" : r.rank >= summary.rankings!.length - 2 ? "text-red-500 dark:text-red-400" : "text-stone-400"}`}>
                      {r.rank}.
                    </span>
                    <span>
                      <span className="font-medium text-stone-800 dark:text-stone-100">{r.display_name}</span>
                      <span className="text-stone-500 dark:text-stone-400"> — {r.reason}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {summary.haiku && (
            <div className="border-l-2 border-violet-400 pl-4">
              <p className="text-xs uppercase tracking-wide text-stone-400 mb-1">Haiku of Regret</p>
              <pre className="text-sm font-serif italic text-stone-600 dark:text-stone-400 whitespace-pre-wrap">{summary.haiku}</pre>
            </div>
          )}
          <p className="text-xs text-stone-400">
            Generated {new Date(summary.generated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </p>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <GenerateSummaryButton
                season={season}
                week={week}
                hasSummary={true}
                onGenerated={setSummary}
              />
              <PostToSignalButton
                season={season}
                week={week}
                postedAt={summary.posted_to_signal_at}
                onPosted={setSummary}
              />
            </div>
          )}
        </div>
      ) : (
        isAdmin && stats && (
          <div className="rounded-xl border border-dashed border-stone-300 dark:border-stone-700 p-5">
            <p className="text-sm text-stone-500 mb-3">No summary generated yet for this week.</p>
            <GenerateSummaryButton
              season={season}
              week={week}
              hasSummary={false}
              onGenerated={setSummary}
            />
          </div>
        )
      )}

      {/* Signal banter */}
      {(banter.length > 0 || isAdmin) && (
        <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-stone-400">Group Chat</p>
            {isAdmin && (
              <div className="flex items-center gap-3">
                {syncMessage && <span className="text-xs text-stone-400">{syncMessage}</span>}
                <SyncBanterButton onSynced={(n) => { handleSynced(n); }} />
              </div>
            )}
          </div>
          {banter.length > 0 ? (
            <ul className="space-y-2">
              {banter.map((b) => (
                <li key={b.id} className="text-sm">
                  <span className="font-medium text-stone-700 dark:text-stone-300">{b.sender_name}</span>
                  <span className="text-stone-400 text-xs ml-2">
                    {new Date(b.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <p className="text-stone-600 dark:text-stone-400 mt-0.5">{b.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-stone-400">No messages synced for this week yet. Hit "Sync Signal messages" to pull them in.</p>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label, value, sub, accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: "emerald" | "red" | "amber" | "sky" | "violet";
}) {
  const accentBorder = {
    emerald: "border-emerald-400",
    red: "border-red-400",
    amber: "border-amber-400",
    sky: "border-sky-400",
    violet: "border-violet-400",
  }[accent];

  return (
    <div className={`rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4 border-l-4 ${accentBorder}`}>
      <p className="text-xs uppercase tracking-wide text-stone-400 mb-1">{label}</p>
      <p className="text-sm font-semibold text-stone-800 dark:text-stone-100">{value}</p>
      <p className="text-xs text-stone-500 mt-0.5">{sub}</p>
    </div>
  );
}
