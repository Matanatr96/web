import Link from "next/link";
import TennisCalibUploader from "@/components/tennis-calib-uploader";
import { isAdmin } from "@/lib/auth";
import {
  formatScore,
  getTennisMatches,
  type TennisMatch,
  type TennisSessionType,
} from "@/lib/tennis";

export const dynamic = "force-dynamic";

type Props = {
  searchParams?: Promise<{ mode?: string }>;
};

function statusBadge(status: TennisMatch["status"]): {
  label: string;
  className: string;
} {
  if (status === "ready") {
    return {
      label: "Ready",
      className:
        "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    };
  }
  if (status === "processing") {
    return {
      label: "Processing GPU",
      className:
        "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    };
  }
  if (status === "failed") {
    return {
      label: "Failed",
      className:
        "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
    };
  }
  return {
    label: "Uploading",
    className:
      "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  };
}

/**
 * `/tennis` Next.js 15 Server Component session index page.
 * Displays `All` / `Rally` / `Match` filter pills, headline rally-streak and shot-speed
 * metrics, an empty-state guide, and the admin Frame-0 calibration uploader.
 *
 * @param props - Route props with `searchParams` (`mode?: "all" | "rally" | "match"`).
 * @returns Rendered session dashboard index.
 */
export default async function TennisIndexPage({ searchParams }: Props) {
  const resolvedSearch = searchParams ? await searchParams : {};
  const rawMode = resolvedSearch.mode;
  const activeFilter: TennisSessionType | "all" =
    rawMode === "rally" || rawMode === "match" ? rawMode : "all";

  const [matches, admin] = await Promise.all([
    getTennisMatches(activeFilter),
    isAdmin(),
  ]);

  const filterTabs: Array<{ key: TennisSessionType | "all"; label: string }> = [
    { key: "all", label: "All Sessions" },
    { key: "rally", label: "🎾 Rally Sessions" },
    { key: "match", label: "🏆 Scored Matches" },
  ];

  return (
    <article>
      <header className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Tennis Vision &amp; Rally Coach
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            DIY SwingVision + 65-joint biomechanics coach. Rally-first streak tracking, sub-frame{" "}
            <span className="font-mono text-xs">Z = 0.033m</span> line calls, 3D aerodynamic drag ballistics, and Modal Byte-Range video clips.
          </p>
        </div>
      </header>

      {admin && (
        <div className="mb-6">
          <TennisCalibUploader />
        </div>
      )}

      {/* Filter Pills */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {filterTabs.map((tab) => {
          const isActive = activeFilter === tab.key;
          const href = tab.key === "all" ? "/tennis" : `/tennis?mode=${tab.key}`;
          return (
            <Link
              key={tab.key}
              href={href}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                isActive
                  ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                  : "border border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:border-stone-300"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {/* Session List or Empty State */}
      {matches.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 dark:border-stone-800 p-10 text-center bg-white/50 dark:bg-stone-900/40">
          <div className="text-2xl mb-2">🎾</div>
          <h2 className="text-base font-semibold">
            No {activeFilter === "all" ? "tennis" : activeFilter} sessions recorded yet
          </h2>
          <p className="text-sm text-stone-500 max-w-lg mx-auto mt-1">
            Record a 1080p60 clip with Blackmagic Camera (`1/1000s` shutter, stabilization off) or the iOS TennisVision app. Sessions default to{" "}
            <span className="font-medium text-stone-700 dark:text-stone-300">
              Rally Mode
            </span>{" "}
            (continuous streaks even when playing on after an out ball, Deep-Zone target %, and FH/BH speeds).
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {matches.map((m) => {
            const st = statusBadge(m.status);
            const isRally = m.sessionType === "rally";
            const longest = m.stats.longestRally ?? 0;
            const avgLen = m.stats.avgRallyLength ?? 0;
            const rallies10Plus = m.stats.rallies10Plus ?? 0;
            const deepPct = m.stats.deepZonePct ?? 0;
            const fhAvg = m.stats.fhSpeedAvg;
            const bhAvg = m.stats.bhSpeedAvg;

            return (
              <Link
                key={m.id}
                href={`/tennis/${m.id}`}
                className="block rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 hover:border-stone-400 dark:hover:border-stone-700 transition"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        isRally
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                          : "bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300"
                      }`}
                    >
                      {isRally ? "🎾 Rally Mode" : "🏆 Match Mode"}
                    </span>
                    <h2 className="text-lg font-semibold tracking-tight">
                      {m.title ?? (isRally ? "Rally Session" : "Match Session")}
                    </h2>
                  </div>

                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-stone-500 tabular-nums">{m.playedOn}</span>
                    <span className="text-stone-300 dark:text-stone-700">·</span>
                    <span className="uppercase text-stone-400">{m.source}</span>
                    <span className={`rounded-full px-2 py-0.5 font-medium ${st.className}`}>
                      {st.label}
                    </span>
                  </div>
                </div>

                {/* Headline Metrics Strip */}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-3 pt-3 border-t border-stone-100 dark:border-stone-800 text-sm">
                  {isRally ? (
                    <>
                      <div>
                        <div className="text-xs text-stone-500">Longest Streak</div>
                        <div className="font-semibold tabular-nums">
                          {longest} shots
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">Avg Rally Length</div>
                        <div className="font-semibold tabular-nums">
                          {avgLen} shots
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">🔥 10+ Shot Rallies</div>
                        <div className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {rallies10Plus}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">Deep-Zone Target %</div>
                        <div className="font-semibold tabular-nums">{deepPct}%</div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">FH / BH Speed</div>
                        <div className="font-semibold tabular-nums">
                          {fhAvg ? `${fhAvg}` : "—"} / {bhAvg ? `${bhAvg} mph` : "—"}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="sm:col-span-2">
                        <div className="text-xs text-stone-500">Match Score</div>
                        <div className="font-semibold tabular-nums">
                          {formatScore(m.score)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">1st Serve In %</div>
                        <div className="font-semibold tabular-nums">
                          {m.stats.firstServeInPct !== null &&
                          m.stats.firstServeInPct !== undefined
                            ? `${m.stats.firstServeInPct}%`
                            : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">Longest Rally</div>
                        <div className="font-semibold tabular-nums">
                          {longest} shots
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-stone-500">Rallies Tracked</div>
                        <div className="font-semibold tabular-nums">
                          {m.ralliesDone}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </article>
  );
}
