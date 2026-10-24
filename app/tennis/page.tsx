import Link from "next/link";
import TennisCalibUploader from "@/components/tennis-calib-uploader";
import { isAdmin } from "@/lib/auth";
import {
  formatScore,
  formatSessionSource,
  getTennisMatches,
  summarizeAllSessions,
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
 * Displays player-centric hero copy, a 5-tile aggregate Career/Recent Stats bar powered by
 * `summarizeAllSessions(matches)` (`Sessions`, `Rallies`, `Total Shots`, `Longest Rally`,
 * `Top Ball Speed`), `All` / `Rally` / `Match` filter pills, session cards with SwingVision
 * offline speed & shot analytics, a 3-step onboarding empty state, and the admin uploader.
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

  const { summary: careerSummary, sessions } = summarizeAllSessions(matches);
  const hasTopSpeed = careerSummary.maxSpeedMph !== null && careerSummary.maxSpeedMph > 0;

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
            Offline SwingVision rally segmentation, serve &amp; groundstroke ball speeds (mph), net clearance, court depth placement, and pro-level stroke biomechanics from a single phone video.
          </p>
        </div>
      </header>

      {admin && (
        <div className="mb-6">
          <TennisCalibUploader />
        </div>
      )}

      {/* Aggregate Overview Strip */}
      {sessions.length > 0 && (
        <section
          aria-label="Career and Recent Session Summary"
          className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6"
        >
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
            <div className="text-[11px] uppercase tracking-wider font-medium text-stone-500">
              Sessions
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums">
              {careerSummary.totalSessions}
            </div>
          </div>
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
            <div className="text-[11px] uppercase tracking-wider font-medium text-stone-500">
              Rallies
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums">
              {careerSummary.totalRallies}
            </div>
          </div>
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
            <div className="text-[11px] uppercase tracking-wider font-medium text-stone-500">
              Total Shots
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums">
              {careerSummary.totalShots}
            </div>
          </div>
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
            <div className="text-[11px] uppercase tracking-wider font-medium text-stone-500">
              Longest Rally
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                {careerSummary.longestRally}
              </span>
              <span className="text-xs text-stone-500">shots</span>
            </div>
          </div>
          <div className="col-span-2 sm:col-span-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
            <div className="text-[11px] uppercase tracking-wider font-medium text-stone-500">
              {hasTopSpeed ? "Top Ball Speed" : "Avg Rally Length"}
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-2xl font-bold tabular-nums text-sky-600 dark:text-sky-400">
                {hasTopSpeed ? careerSummary.maxSpeedMph : careerSummary.avgRallyLength}
              </span>
              <span className="text-xs text-stone-500">
                {hasTopSpeed ? "mph" : "shots"}
              </span>
            </div>
          </div>
        </section>
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

      {/* Session List or 3-Step Onboarding Empty State */}
      {sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 dark:border-stone-800 p-8 sm:p-10 bg-white/50 dark:bg-stone-900/40">
          <div className="text-center max-w-xl mx-auto">
            <div className="text-2xl mb-2">🎾</div>
            <h2 className="text-base font-semibold">
              No {activeFilter === "all" ? "tennis" : activeFilter} sessions recorded yet
            </h2>
            <p className="text-sm text-stone-500 mt-1">
              Get started in three quick steps to turn any court video into interactive rally highlights and SwingVision shot analytics:
            </p>
          </div>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
            <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Step 1
              </div>
              <div className="mt-1 text-sm font-semibold">
                1. Record on iPhone or Upload Video
              </div>
              <p className="mt-1 text-xs text-stone-500">
                Record 1080p60 with the TennisVision iPhone app, pick a clip from your Camera Roll, or upload from the web.
              </p>
            </div>

            <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Step 2
              </div>
              <div className="mt-1 text-sm font-semibold">
                2. Auto-Detect Court or Tap 4 Corners
              </div>
              <p className="mt-1 text-xs text-stone-500">
                Skip calibration to let the cloud GPU auto-detect court corners, or optionally tap 4 court corners on Frame 0.
              </p>
            </div>

            <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Step 3
              </div>
              <div className="mt-1 text-sm font-semibold">
                3. Review Shot Speeds, 2D Placement &amp; Biomechanics
              </div>
              <p className="mt-1 text-xs text-stone-500">
                Scrub rally-by-rally clips, inspect Serve/FH/BH speeds, net clearance, and bounce depth zones, and compare your swing against ATP pros.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {sessions.map((m) => {
            const st = statusBadge(m.status);
            const isRally = m.sessionType === "rally";
            const longest = m.longestRally;
            const avgLen = m.avgRallyLength;
            const rallies10Plus = m.stats.rallies10Plus ?? 0;
            const deepPct = m.deepPct;
            const avgSpeed = m.avgSpeedMph;
            const maxSpeed = m.maxSpeedMph;
            const fhAvg = m.fhSpeedAvg;
            const fhMax = m.fhSpeedMax;
            const bhAvg = m.bhSpeedAvg;
            const bhMax = m.bhSpeedMax;
            const serveAvg = m.serveSpeedAvg;
            const serveMax = m.serveSpeedMax;
            const sourceLabel = formatSessionSource(
              m.source,
              m.stats as Record<string, unknown>,
            );
            const courtLabel = m.doubles ? "Doubles" : "Singles";

            return (
              <Link
                key={m.id}
                href={`/tennis/${m.id}`}
                className="block rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 hover:border-stone-400 dark:hover:border-stone-700 transition"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
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
                    {!isRally && (
                      <span className="rounded-full bg-sky-50 dark:bg-sky-950/50 border border-sky-200 dark:border-sky-800 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-sky-800 dark:text-sky-300">
                        {m.scoreFormatted ?? formatScore(m.score)}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-stone-500 tabular-nums">{m.playedOn}</span>
                    <span className="rounded-full border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/70 px-2.5 py-0.5 font-medium text-stone-700 dark:text-stone-300">
                      {sourceLabel}
                    </span>
                    <span className="rounded-full border border-stone-200 dark:border-stone-700 px-2 py-0.5 font-medium text-stone-600 dark:text-stone-400">
                      {courtLabel}
                    </span>
                    {maxSpeed !== null && (
                      <span className="rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 px-2.5 py-0.5 font-semibold tabular-nums">
                        ⚡ {maxSpeed} mph max
                      </span>
                    )}
                    <span className={`rounded-full px-2 py-0.5 font-medium ${st.className}`}>
                      {st.label}
                    </span>
                  </div>
                </div>

                {/* SwingVision Headline Metrics Strip */}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-3 pt-3 border-t border-stone-100 dark:border-stone-800 text-sm">
                  <div>
                    <div className="text-xs text-stone-500">Longest Rally</div>
                    <div className="font-semibold tabular-nums">
                      {longest} shots
                    </div>
                    <div className="text-[11px] text-stone-400 tabular-nums">
                      Avg {avgLen} shots · {m.totalRallies} rallies · {m.totalShots} shots
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-stone-500">Avg / Max Ball Speed</div>
                    <div className="font-semibold tabular-nums">
                      {avgSpeed !== null || maxSpeed !== null
                        ? `${avgSpeed ?? "—"} / ${maxSpeed ?? "—"} mph`
                        : "— / — mph"}
                    </div>
                    <div className="text-[11px] text-stone-400 tabular-nums">
                      All tracked strokes
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-stone-500">FH / BH Speed</div>
                    <div className="font-semibold tabular-nums">
                      {fhAvg !== null || bhAvg !== null
                        ? `${fhAvg ?? "—"} / ${bhAvg ?? "—"} mph`
                        : "— / — mph"}
                    </div>
                    <div className="text-[11px] text-stone-400 tabular-nums">
                      Max {fhMax ?? "—"} / {bhMax ?? "—"} mph
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-stone-500">Serve Speed</div>
                    <div className="font-semibold tabular-nums">
                      {serveAvg !== null || serveMax !== null
                        ? `${serveAvg ?? "—"} / ${serveMax ?? "—"} mph`
                        : "— / — mph"}
                    </div>
                    <div className="text-[11px] text-stone-400 tabular-nums">
                      Avg / Max serve speed
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-stone-500">Deep Zone %</div>
                    <div className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {deepPct}%
                    </div>
                    <div className="text-[11px] text-stone-400 tabular-nums">
                      🔥 {rallies10Plus} rallies ≥10 shots
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </article>
  );
}
