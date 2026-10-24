import Link from "next/link";
import { notFound } from "next/navigation";
import { toggleRallyBookmark } from "@/app/tennis/actions";
import TennisCourtMinimap, {
  TennisClipPlayer,
  TennisStatusPoller,
} from "@/components/tennis-court-minimap";
import { isAdmin } from "@/lib/auth";
import {
  formatScore,
  formatSessionSource,
  getTennisMatch,
  resolveClipUrl,
  summarizeSession,
  type TennisShot,
  toClipLocalTimeS,
} from "@/lib/tennis";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    filter?: string;
    rally?: string;
    hide1?: string;
    shot?: string;
    slowmo?: string;
  }>;
};

function zScoreBadgeClass(z: number): string {
  const absZ = Math.abs(z);
  if (absZ <= 0.75) {
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300";
  }
  if (absZ <= 1.5) {
    return "bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300";
  }
  return "bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300";
}

/**
 * `/tennis/[id]` Next.js 15 Server Component adaptive session detail dashboard.
 * Renders:
 * - **Rally Mode** headline cards (Longest Rally Streak, Avg Rally Length, Deep-Zone Target %,
 *   FH vs. BH Avg Speed & Play-On-After-Out count)
 * - **Match Mode** scoreboard, 1st serve %, and point log
 * - Quick filter pills (*All Rallies*, *🔥 10+ Shots*, *⭐ Bookmarked*, *Close Calls*)
 * - Interactive 2D SVG Court Minimap with shaded Deep Target Zones ($6.4\text{–}11.885\text{ m}$)
 * - `<video>` player streaming 720p rally clips via HTTP `Range` (`206 Partial Content`) from Modal
 * - Slow-Mo Hawk-Eye challenge zoom cards ($Z = 0.033\text{ m}$ plane, $2\sigma_m$ uncertainty)
 * - 65-Joint Biomechanics ATP Pro Z-Score comparison table
 *
 * @param props - Route params (`id`) and searchParams (`filter`, `rally`, `hide1`).
 * @returns Rendered session detail dashboard.
 */
export default async function TennisSessionDetailPage({
  params,
  searchParams,
}: Props) {
  const { id } = await params;
  const resolvedSearch = searchParams ? await searchParams : {};

  const [detail, admin] = await Promise.all([getTennisMatch(id), isAdmin()]);
  if (!detail) notFound();

  const isRallyMode = detail.sessionType === "rally";
  const hideOneShotFeeds =
    resolvedSearch.hide1 !== undefined ? resolvedSearch.hide1 !== "0" : isRallyMode;
  const summary = summarizeSession({
    sessionType: detail.sessionType,
    rallies: detail.rallies,
    points: detail.points,
    doubles: detail.doubles,
    hideOneShotFeeds,
    biomechTraits: detail.stats.biomechTraits,
    coachNotes: detail.stats.coachNotes,
  });

  const activeFilter = resolvedSearch.filter ?? "all";
  const filteredRallies = detail.rallies.filter((r) => {
    const count = Math.max(r.shotCount, r.shots.length);
    if (hideOneShotFeeds && count < 2 && activeFilter === "all") {
      return false;
    }
    if (activeFilter === "10plus") return count >= 10;
    if (activeFilter === "bookmarked") return r.bookmarked;
    if (activeFilter === "close") {
      return r.shots.some((s) => s.call === "close" || s.call === "out");
    }
    return true;
  });

  const explicitRallyIdx =
    resolvedSearch.rally !== undefined &&
    resolvedSearch.rally.trim() !== "" &&
    Number.isFinite(Number(resolvedSearch.rally))
      ? Number(resolvedSearch.rally)
      : null;

  const activeRally =
    explicitRallyIdx !== null
      ? (filteredRallies.find((r) => r.rallyIdx === explicitRallyIdx) ??
         detail.rallies.find((r) => r.rallyIdx === explicitRallyIdx) ??
         null)
      : (filteredRallies[0] ?? null);

  const selectedShotIdx =
    resolvedSearch.shot !== undefined &&
    resolvedSearch.shot.trim() !== "" &&
    Number.isFinite(Number(resolvedSearch.shot))
      ? Number(resolvedSearch.shot)
      : null;

  const activeShot =
    activeRally && selectedShotIdx !== null
      ? (activeRally.shots.find((s) => s.shotIdx === selectedShotIdx) ?? null)
      : null;

  const isSlowMo = resolvedSearch.slowmo === "1";
  const clipSeekTimeS =
    activeRally && activeShot
      ? isSlowMo
        ? (toClipLocalTimeS(activeShot.tBounceS, activeRally.startS) ??
          toClipLocalTimeS(activeShot.tHitS, activeRally.startS))
        : (toClipLocalTimeS(activeShot.tHitS, activeRally.startS) ??
          toClipLocalTimeS(activeShot.tBounceS, activeRally.startS))
      : null;
  const playbackRate = isSlowMo ? 0.25 : 1;

  const activeRallyPos = activeRally
    ? filteredRallies.findIndex((r) => r.rallyIdx === activeRally.rallyIdx)
    : -1;
  const prevRally =
    activeRallyPos > 0 ? filteredRallies[activeRallyPos - 1] : null;
  const nextRally =
    activeRallyPos >= 0 && activeRallyPos < filteredRallies.length - 1
      ? filteredRallies[activeRallyPos + 1]
      : activeRallyPos === -1
        ? (filteredRallies[0] ?? null)
        : null;
  const prevRallyHref = prevRally
    ? `/tennis/${detail.id}?filter=${activeFilter}&rally=${prevRally.rallyIdx}&hide1=${hideOneShotFeeds ? "1" : "0"}`
    : null;
  const nextRallyHref = nextRally
    ? `/tennis/${detail.id}?filter=${activeFilter}&rally=${nextRally.rallyIdx}&hide1=${hideOneShotFeeds ? "1" : "0"}`
    : null;

  const allShots: TennisShot[] = detail.rallies.flatMap((r) => r.shots);
  const minimapShots = activeRally ? activeRally.shots : allShots;

  // Gather close and out calls for Hawk-Eye Challenge cards
  const hawkEyeCalls = allShots.filter(
    (s) => s.call === "close" || s.call === "out",
  );

  const biomechRows = summary.biomechTraits ?? [];
  const clipSrc = activeRally
    ? resolveClipUrl(activeRally.clipUrl, process.env.NEXT_PUBLIC_TENNIS_MODAL_URL)
    : null;

  const sourceBadgeLabel = formatSessionSource(
    detail.source,
    detail.stats as Record<string, unknown>,
  );
  const rallyStartByIdx = new Map<number, number>(
    detail.rallies.map((r) => [r.rallyIdx, r.startS]),
  );

  return (
    <article>
      <nav className="text-sm text-stone-500 mb-4 flex items-center justify-between">
        <Link href="/tennis" className="hover:underline">
          ← All tennis sessions
        </Link>
        <span className="text-xs font-mono text-stone-400">
          ID: {detail.id.slice(0, 8)} · {detail.doubles ? "Doubles" : "Singles"} ·{" "}
          {detail.fps ? `${detail.fps} fps` : "fps n/a"}
        </span>
      </nav>

      {/* Session Header */}
      <header className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                isRallyMode
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                  : "bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300"
              }`}
            >
              {isRallyMode ? "🎾 Rally Mode" : "🏆 Match Mode"}
            </span>
            <h1 className="text-3xl font-bold tracking-tight">
              {detail.title ?? (isRallyMode ? "Cooperative Rally Session" : "Scored Match")}
            </h1>
          </div>
          <p className="mt-1 text-sm text-stone-500 flex flex-wrap items-center gap-1.5">
            <span>
              Played on {detail.playedOn} · {sourceBadgeLabel} · Status:{" "}
              <span className="font-medium text-stone-700 dark:text-stone-300">
                {detail.status}
              </span>
            </span>
            <TennisStatusPoller status={detail.status} />
          </p>
        </div>

        {isRallyMode && (
          <Link
            href={`/tennis/${detail.id}?filter=${activeFilter}&hide1=${hideOneShotFeeds ? "0" : "1"}`}
            className="self-start rounded-md border border-stone-200 dark:border-stone-800 px-3 py-1.5 text-xs text-stone-600 dark:text-stone-400 hover:border-stone-400"
          >
            {hideOneShotFeeds ? "Showing ≥2-Shot Rallies (Click to Include 1-Shot Feeds)" : "Including 1-Shot Feeds (Click to Hide)"}
          </Link>
        )}
      </header>

      {/* Match Mode Scoreboard Banner (when sessionType === 'match') */}
      {!isRallyMode && (
        <section className="rounded-lg border border-sky-200 dark:border-sky-900/60 bg-sky-50/50 dark:bg-sky-950/20 p-5 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-sky-700 dark:text-sky-300 font-semibold">
                Match Scoreboard
              </div>
              <div className="text-3xl font-bold tabular-nums mt-1">
                {formatScore(detail.score)}
              </div>
            </div>
            <div className="flex gap-6 text-sm">
              <div>
                <div className="text-xs text-stone-500">1st Serve In %</div>
                <div className="text-lg font-semibold tabular-nums">
                  {summary.firstServeInPct !== null ? `${summary.firstServeInPct}%` : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-stone-500">Max Serve Speed</div>
                <div className="text-lg font-semibold tabular-nums">
                  {summary.serveSpeedMax !== null ? `${summary.serveSpeedMax} mph` : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-stone-500">Scored Points</div>
                <div className="text-lg font-semibold tabular-nums">
                  {detail.points.length}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Headline Rally & Shot Metric Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
          <div className="text-xs uppercase tracking-wide text-stone-500">
            Longest Rally Streak
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {summary.longestRally}
            </span>
            <span className="text-xs text-stone-500">shots</span>
          </div>
          <div className="mt-1 text-xs text-stone-400">
            Clean in-bounds streak: {summary.longestInStreak} shots
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
          <div className="text-xs uppercase tracking-wide text-stone-500">
            Avg Rally Length
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums">
              {summary.avgRallyLength}
            </span>
            <span className="text-xs text-stone-500">shots / rally</span>
          </div>
          <div className="mt-1 text-xs text-stone-400">
            🔥 {summary.rallies10Plus} rallies with ≥10 shots ({summary.qualifyingRallies} total)
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
          <div className="text-xs uppercase tracking-wide text-stone-500">
            Deep-Zone Target %
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums text-sky-600 dark:text-sky-400">
              {summary.deepZonePct}%
            </span>
            <span className="text-xs text-stone-500">6.4–11.9m</span>
          </div>
          <div className="mt-1 text-xs text-stone-400">
            Short service-box balls: {summary.shortZonePct}%
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
          <div className="text-xs uppercase tracking-wide text-stone-500">
            FH vs. BH Avg Speed
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums">
              {summary.fhSpeedAvg ?? "—"} / {summary.bhSpeedAvg ?? "—"}
            </span>
            <span className="text-xs text-stone-500">mph</span>
          </div>
          <div className="mt-1 text-xs text-stone-400">
            In-bounds: {summary.inPct}% · Play-on after OUT: {summary.playedOnAfterOutRallies}
          </div>
        </div>
      </section>

      {/* Rally Quick Filter Pills */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {[
          {
            key: "all",
            label: `All Rallies (${hideOneShotFeeds ? summary.qualifyingRallies : detail.rallies.length})`,
          },
          { key: "10plus", label: `🔥 10+ Shots (${summary.rallies10Plus})` },
          {
            key: "bookmarked",
            label: `⭐ Bookmarked (${detail.rallies.filter((r) => r.bookmarked).length})`,
          },
          {
            key: "close",
            label: `Close Calls (${detail.rallies.filter((r) => r.shots.some((s) => s.call === "close" || s.call === "out")).length})`,
          },
        ].map((pill) => {
          const isCurrent = activeFilter === pill.key;
          return (
            <Link
              key={pill.key}
              href={`/tennis/${detail.id}?filter=${pill.key}&hide1=${hideOneShotFeeds ? "1" : "0"}`}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                isCurrent
                  ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                  : "border border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:border-stone-400"
              }`}
            >
              {pill.label}
            </Link>
          );
        })}
      </div>

      {/* Main Split View: Modal Byte-Range Video Player + Rally List + 2D SVG Court Minimap */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
        {/* Left/Center: Modal Byte-Range Video Player & Rally Selector (8 cols) */}
        <div className="lg:col-span-8 space-y-4">
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
            {activeRally ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div>
                    <h2 className="text-base font-semibold">
                      Rally #{activeRally.rallyIdx + 1} ·{" "}
                      {Math.max(activeRally.shotCount, activeRally.shots.length)} Shots
                    </h2>
                    <p className="text-xs text-stone-500 tabular-nums">
                      {activeRally.startS.toFixed(1)}s – {activeRally.endS.toFixed(1)}s (
                      {(activeRally.endS - activeRally.startS).toFixed(1)}s duration) · In-streak:{" "}
                      {activeRally.inStreak} shots
                    </p>
                  </div>
                  {admin && (
                    <form
                      action={toggleRallyBookmark.bind(
                        null,
                        detail.id,
                        activeRally.rallyIdx,
                        !activeRally.bookmarked,
                      )}
                    >
                      <button
                        type="submit"
                        className={`rounded-md border px-3 py-1 text-xs font-medium cursor-pointer ${
                          activeRally.bookmarked
                            ? "border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                            : "border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-400"
                        }`}
                      >
                        {activeRally.bookmarked ? "⭐ Bookmarked" : "☆ Bookmark Rally"}
                      </button>
                    </form>
                  )}
                </div>

                {/* Modal HTTP Byte-Range 720p Clip Stream */}
                {clipSrc ? (
                  <TennisClipPlayer
                    src={clipSrc}
                    seekToS={clipSeekTimeS}
                    playbackRate={playbackRate}
                    prevRallyHref={prevRallyHref}
                    nextRallyHref={nextRallyHref}
                    activeShotIdx={activeShot?.shotIdx ?? null}
                  />
                ) : (
                  <div className="flex w-full aspect-video items-center justify-center rounded-md bg-stone-950 text-xs text-stone-400">
                    {activeRally.clipUrl
                      ? "Clip unavailable: NEXT_PUBLIC_TENNIS_MODAL_URL is not configured."
                      : "Clip not ready yet."}
                  </div>
                )}

                {/* Interactive Shot-by-Shot Scrubber Chip Strip & Table */}
                {activeRally.shots.length > 0 && (
                  <div className="mt-4 space-y-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400 mr-1">
                        Shot Scrubber:
                      </span>
                      {activeRally.shots.map((s) => {
                        const isSelectedShot = selectedShotIdx === s.shotIdx;
                        const hitLocalS = toClipLocalTimeS(s.tHitS, activeRally.startS);
                        const shotHref = `/tennis/${detail.id}?filter=${activeFilter}&rally=${activeRally.rallyIdx}&shot=${s.shotIdx}&hide1=${hideOneShotFeeds ? "1" : "0"}`;
                        return (
                          <Link
                            key={`chip-${s.shotIdx}`}
                            href={shotHref}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums transition ${
                              isSelectedShot
                                ? "border-emerald-500 bg-emerald-600 text-white"
                                : "border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-950/60 text-stone-700 dark:text-stone-300 hover:border-stone-400"
                            }`}
                          >
                            <span>#{s.shotIdx + 1}</span>
                            <span className="uppercase">{s.stroke ?? "shot"}</span>
                            {s.speedMph !== null && <span>{s.speedMph} mph</span>}
                            {hitLocalS !== null && (
                              <span
                                className={
                                  isSelectedShot
                                    ? "text-emerald-100 text-[10px]"
                                    : "text-stone-400 text-[10px]"
                                }
                              >
                                {hitLocalS.toFixed(1)}s
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-stone-200 dark:border-stone-800 text-stone-500">
                            <th className="py-1.5 pr-3">#</th>
                            <th className="py-1.5 pr-3">Hitter</th>
                            <th className="py-1.5 pr-3">Stroke</th>
                            <th className="py-1.5 pr-3">Direction</th>
                            <th className="py-1.5 pr-3">Speed</th>
                            <th className="py-1.5 pr-3">Net Clearance</th>
                            <th className="py-1.5 pr-3">Depth Zone</th>
                            <th className="py-1.5">Line Call</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 dark:divide-stone-800 tabular-nums">
                          {activeRally.shots.map((s) => {
                            const isSelectedShot = selectedShotIdx === s.shotIdx;
                            const hitLocalS = toClipLocalTimeS(s.tHitS, activeRally.startS);
                            const shotHref = `/tennis/${detail.id}?filter=${activeFilter}&rally=${activeRally.rallyIdx}&shot=${s.shotIdx}&hide1=${hideOneShotFeeds ? "1" : "0"}`;
                            return (
                              <tr
                                key={s.shotIdx}
                                className={
                                  isSelectedShot
                                    ? "bg-emerald-50/70 dark:bg-emerald-950/30"
                                    : "hover:bg-stone-50 dark:hover:bg-stone-800/40 transition"
                                }
                              >
                                <td className="py-1.5 pr-3 font-medium">
                                  <Link
                                    href={shotHref}
                                    className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                                  >
                                    <span>{isSelectedShot ? "◆" : "▶"}</span>
                                    <span>#{s.shotIdx + 1}</span>
                                    {hitLocalS !== null && (
                                      <span className="text-[10px] font-normal text-stone-400">
                                        ({hitLocalS.toFixed(1)}s)
                                      </span>
                                    )}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3 uppercase text-stone-500">
                                  <Link href={shotHref} className="block">
                                    {s.hitter ?? "—"}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3 font-medium uppercase">
                                  <Link href={shotHref} className="block">
                                    {s.stroke ?? "shot"}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3 uppercase text-stone-500">
                                  <Link href={shotHref} className="block">
                                    {s.direction ?? "—"}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3">
                                  <Link href={shotHref} className="block">
                                    {s.speedMph !== null ? `${s.speedMph} mph` : "—"}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3">
                                  <Link href={shotHref} className="block">
                                    {s.netClearanceM !== null
                                      ? `${(s.netClearanceM * 100).toFixed(0)} cm`
                                      : "—"}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3">
                                  <Link href={shotHref} className="inline-block">
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                                        s.depthZone === "deep"
                                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                                          : s.depthZone === "short"
                                            ? "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300"
                                            : "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300"
                                      }`}
                                    >
                                      {s.depthZone ?? "unknown"}
                                    </span>
                                  </Link>
                                </td>
                                <td className="py-1.5">
                                  <Link href={shotHref} className="inline-flex items-center">
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${
                                        s.call === "in"
                                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                                          : s.call === "close"
                                            ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                                            : s.call === "out"
                                              ? "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
                                              : "bg-stone-100 text-stone-600"
                                      }`}
                                    >
                                      {s.call}
                                    </span>
                                    {s.marginM !== null && (
                                      <span className="ml-1.5 text-stone-400">
                                        ({(s.marginM * 100).toFixed(1)} cm)
                                      </span>
                                    )}
                                  </Link>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="py-12 text-center text-sm text-stone-500">
                No rallies match the current filter. When Modal finishes processing your clip, trimmed 720p rally segments will stream here automatically.
              </div>
            )}
          </div>

          {/* Rally Timeline Selector List */}
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
            <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-3">
              Rally Segments ({filteredRallies.length})
            </h3>
            {filteredRallies.length === 0 ? (
              <p className="text-xs text-stone-500">No rallies in this filter view.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {filteredRallies.map((r) => {
                  const count = Math.max(r.shotCount, r.shots.length);
                  const isSelected = activeRally?.rallyIdx === r.rallyIdx;
                  const hasPlayOnOut =
                    r.shots.findIndex((s) => s.call === "out") >= 0 &&
                    r.shots.findIndex((s) => s.call === "out") < r.shots.length - 1;

                  return (
                    <Link
                      key={r.rallyIdx}
                      href={`/tennis/${detail.id}?filter=${activeFilter}&rally=${r.rallyIdx}&hide1=${hideOneShotFeeds ? "1" : "0"}`}
                      className={`flex items-center justify-between rounded-md border p-2.5 text-xs transition ${
                        isSelected
                          ? "border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/30"
                          : "border-stone-200 dark:border-stone-800 hover:border-stone-400"
                      }`}
                    >
                      <div>
                        <span className="font-semibold">
                          Rally #{r.rallyIdx + 1} · {count} shots
                        </span>
                        {r.bookmarked && <span className="ml-1.5">⭐</span>}
                        {count >= 10 && <span className="ml-1">🔥</span>}
                        {hasPlayOnOut && (
                          <span className="ml-1.5 rounded bg-amber-100 dark:bg-amber-950/60 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-300">
                            Played on after OUT
                          </span>
                        )}
                        <div className="text-stone-400 tabular-nums mt-0.5">
                          {r.startS.toFixed(1)}s – {r.endS.toFixed(1)}s
                        </div>
                      </div>
                      <span className="text-stone-500 font-mono">Play →</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: 2D SVG Court Minimap + Hawk-Eye Challenge Cards (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-xs uppercase tracking-wide text-stone-500">
                2D ITF Court Minimap (Hr Z=0.033m)
              </h3>
              <span className="text-[11px] text-stone-400">
                {activeRally ? `Rally #${activeRally.rallyIdx + 1}` : "All Shots"}
              </span>
            </div>
            <TennisCourtMinimap
              shots={minimapShots}
              doubles={detail.doubles}
              showDeepZones={true}
              activeShotIdx={activeShot?.shotIdx ?? null}
            />
          </div>

          {/* Slow-Mo Hawk-Eye Challenge Zoom Cards */}
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
            <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">
              ⚑ Slow-Mo Hawk-Eye Line Challenges ({hawkEyeCalls.length})
            </h3>
            <p className="text-xs text-stone-400 mb-3">
              Sub-frame parabola <span className="font-mono">t*</span> on the{" "}
              <span className="font-mono">Z = 0.033m</span> ball-radius plane with{" "}
              <span className="font-mono">±2σ</span> Jacobian uncertainty gate. Click a call to seek the clip and replay at <span className="font-mono">0.25×</span>.
            </p>
            {hawkEyeCalls.length === 0 ? (
              <p className="text-xs text-stone-500 italic">
                No close or out bounces recorded in this session yet.
              </p>
            ) : (
              <ul className="divide-y divide-stone-100 dark:divide-stone-800 text-xs">
                {hawkEyeCalls.slice(0, 8).map((c) => {
                  const marginCm =
                    c.marginM !== null ? (c.marginM * 100).toFixed(1) : "0.0";
                  const twoSigmaCm =
                    c.sigmaM !== null ? (c.sigmaM * 2 * 100).toFixed(1) : "6.0";
                  const rStartS = rallyStartByIdx.get(c.rallyIdx) ?? 0;
                  const clipBounceS = toClipLocalTimeS(c.tBounceS, rStartS);
                  const isActiveChallenge =
                    activeRally?.rallyIdx === c.rallyIdx &&
                    selectedShotIdx === c.shotIdx &&
                    resolvedSearch.slowmo === "1";

                  return (
                    <li key={`chal-${c.rallyIdx}-${c.shotIdx}`} className="py-1.5">
                      <Link
                        href={`/tennis/${detail.id}?filter=${activeFilter}&rally=${c.rallyIdx}&shot=${c.shotIdx}&slowmo=1&hide1=${hideOneShotFeeds ? "1" : "0"}`}
                        className={`flex items-center justify-between gap-2 rounded-md p-2 transition ${
                          isActiveChallenge
                            ? "border border-amber-400 bg-amber-50/60 dark:bg-amber-950/30"
                            : "hover:bg-stone-50 dark:hover:bg-stone-800/60"
                        }`}
                      >
                        <div>
                          <div className="font-medium">
                            Rally #{c.rallyIdx + 1} · Shot #{c.shotIdx + 1} (
                            {(c.stroke ?? "shot").toUpperCase()})
                          </div>
                          <div className="text-stone-400 tabular-nums">
                            t* = {clipBounceS !== null ? `${clipBounceS.toFixed(3)}s` : "—"} · Margin:{" "}
                            {marginCm} cm (±{twoSigmaCm} cm 2σ)
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono text-stone-500">0.25× →</span>
                          <span
                            className={`rounded px-2 py-0.5 font-semibold uppercase ${
                              c.call === "close"
                                ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                                : "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
                            }`}
                          >
                            {c.call}
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* 65-Joint Biomechanics & ATP Pro Z-Score Comparison Table */}
      <section className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              65-Joint Biomechanics vs. 11-Pro ATP Baseline (RTMW-x + F3ED)
            </h2>
            <p className="text-xs text-stone-500">
              Normalized for player stature and camera perspective. Z-scores compare your stroke kinematics against the 11-pro ATP reference distribution.
            </p>
          </div>
        </div>

        {summary.coachNotes && (
          <div className="mb-4 rounded-md border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/50 dark:bg-emerald-950/20 p-3.5 text-sm text-stone-700 dark:text-stone-300">
            <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1">
              Claude Biomechanics Coach Breakdown
            </div>
            <p className="whitespace-pre-wrap">{summary.coachNotes}</p>
          </div>
        )}

        {biomechRows.length === 0 ? (
          <p className="text-sm text-stone-500 italic">
            Biomechanics have not been computed for this session. Tick &quot;Run biomechanics&quot; when uploading (Phase 3).
          </p>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-stone-200 dark:border-stone-800 text-stone-500">
                <th className="py-2 pr-4">Stroke</th>
                <th className="py-2 pr-4">Biomechanical Trait (65-Joint Skeleton)</th>
                <th className="py-2 pr-4">Your Mean</th>
                <th className="py-2 pr-4">ATP Pro Mean (±1σ)</th>
                <th className="py-2">Z-Score vs. Pros</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-800 tabular-nums">
              {biomechRows.map((row) => (
                <tr key={`${row.stroke}-${row.trait}`}>
                  <td className="py-2.5 pr-4 uppercase font-semibold text-stone-600 dark:text-stone-400">
                    {row.stroke}
                  </td>
                  <td className="py-2.5 pr-4 font-medium">{row.trait}</td>
                  <td className="py-2.5 pr-4">
                    {row.userValue} {row.unit}
                  </td>
                  <td className="py-2.5 pr-4 text-stone-500">
                    {row.proMean} ± {row.proStd} {row.unit}
                  </td>
                  <td className="py-2.5">
                    <span
                      className={`rounded-full px-2.5 py-0.5 font-semibold ${zScoreBadgeClass(
                        row.zScore,
                      )}`}
                    >
                      {row.zScore >= 0 ? `+${row.zScore.toFixed(2)}σ` : `${row.zScore.toFixed(2)}σ`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>
    </article>
  );
}
