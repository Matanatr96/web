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

function formatPlayerLabel(hitter: TennisShot["hitter"]): string {
  if (hitter === "near") return "Near";
  if (hitter === "far") return "Far";
  return "—";
}

function formatStrokeUpper(stroke: string | null): string {
  if (!stroke) return "SHOT";
  const lower = stroke.toLowerCase();
  if (lower === "forehand" || lower === "fh") return "FH";
  if (lower === "backhand" || lower === "bh") return "BH";
  if (lower === "serve") return "SERVE";
  if (lower === "feed") return "FEED";
  return stroke.toUpperCase();
}

function formatDirectionLabel(dir: TennisShot["direction"]): string {
  if (dir === "cross") return "Cross";
  if (dir === "dtl") return "DTL";
  if (dir === "middle") return "Middle";
  return "—";
}

function formatBounceDepthLabel(zone: TennisShot["depthZone"]): {
  label: string;
  className: string;
} {
  if (zone === "deep") {
    return {
      label: "Deep",
      className:
        "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    };
  }
  if (zone === "short") {
    return {
      label: "Short",
      className:
        "bg-cyan-100 text-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300",
    };
  }
  return {
    label: "—",
    className:
      "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  };
}

/**
 * `/tennis/[id]` Next.js 15 Server Component adaptive session detail dashboard.
 * Renders:
 * - **SwingVision Headline Stat Tiles**: Longest Rally, Avg Rally Length, Serve Speed (avg/max mph),
 *   FH Speed (avg/max mph), BH Speed (avg/max mph), Avg Net Clearance, and Deep Zone %
 * - **Match Mode** scoreboard, serve speed, and point log
 * - Quick filter pills (*All Rallies*, *🔥 10+ Shots*, *⚡ Fastest Shots (70+ mph)*, *🎯 Deep Shots*, *⭐ Bookmarked*)
 * - Interactive 2D SVG Court Minimap with shaded Deep Target Zones ($6.4\text{–}11.885\text{ m}$)
 * - `<video>` player streaming 720p rally clips via HTTP `Range` (`206 Partial Content`) from Modal
 * - Shot-by-Shot Scrubber strip + Shot Table (Shot #, Player, Stroke, Direction, Ball Speed, Net Clearance, Bounce Depth)
 * - 65-Joint Biomechanics ATP Pro Z-Score comparison table
 *
 * @param props - Route params (`id`) and searchParams (`filter`, `rally`, `hide1`, `shot`, `slowmo`).
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

  const isFastRally = (r: (typeof detail.rallies)[number]): boolean =>
    r.shots.some((s) => (s.speedMph ?? 0) >= 70);
  const isDeepRally = (r: (typeof detail.rallies)[number]): boolean =>
    r.shots.some((s) => s.depthZone === "deep");

  const activeFilter = resolvedSearch.filter ?? "all";
  const filteredRallies = detail.rallies.filter((r) => {
    const count = Math.max(r.shotCount, r.shots.length);
    if (hideOneShotFeeds && count < 2 && activeFilter === "all") {
      return false;
    }
    if (activeFilter === "10plus") return count >= 10;
    if (activeFilter === "fastest") return isFastRally(r);
    if (activeFilter === "deep") return isDeepRally(r);
    if (activeFilter === "bookmarked") return r.bookmarked;
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

  const topSpeedShots = [...allShots]
    .filter((s): s is TennisShot & { speedMph: number } => s.speedMph !== null && s.speedMph > 0)
    .sort((a, b) => b.speedMph - a.speedMph)
    .slice(0, 8);

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
                <div className="text-xs text-stone-500">Avg / Max Ball Speed</div>
                <div className="text-lg font-semibold tabular-nums">
                  {summary.avgSpeedMph !== null || summary.maxSpeedMph !== null
                    ? `${summary.avgSpeedMph ?? "—"} / ${summary.maxSpeedMph ?? "—"} mph`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-stone-500">Serve Speed (Avg / Max)</div>
                <div className="text-lg font-semibold tabular-nums">
                  {summary.serveSpeedAvg !== null || summary.serveSpeedMax !== null
                    ? `${summary.serveSpeedAvg ?? "—"} / ${summary.serveSpeedMax ?? "—"} mph`
                    : "—"}
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

      {/* SwingVision Headline Stat Tiles */}
      <section
        aria-label="SwingVision Headline Stats"
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 mb-6"
      >
        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            Longest Rally
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {summary.longestRally}
            </span>
            <span className="text-xs text-stone-500">shots</span>
          </div>
          <div className="mt-1 text-[11px] text-stone-400 tabular-nums">
            {summary.totalRallies} rallies · {summary.totalShots} shots
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            Avg Rally Length
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tabular-nums">
              {summary.avgRallyLength}
            </span>
            <span className="text-xs text-stone-500">shots</span>
          </div>
          <div className="mt-1 text-[11px] text-stone-400 tabular-nums">
            🔥 {summary.rallies10Plus} rallies ≥10 shots
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            Serve Speed
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold tabular-nums">
              {summary.serveSpeedAvg ?? "—"} / {summary.serveSpeedMax ?? "—"}
            </span>
            <span className="text-xs text-stone-500">mph</span>
          </div>
          <div className="mt-1 text-[11px] text-stone-400">
            Avg / Max serve speed
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            FH Speed
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold tabular-nums">
              {summary.fhSpeedAvg ?? "—"} / {summary.fhSpeedMax ?? "—"}
            </span>
            <span className="text-xs text-stone-500">mph</span>
          </div>
          <div className="mt-1 text-[11px] text-stone-400">
            Forehand avg / max
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            BH Speed
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold tabular-nums">
              {summary.bhSpeedAvg ?? "—"} / {summary.bhSpeedMax ?? "—"}
            </span>
            <span className="text-xs text-stone-500">mph</span>
          </div>
          <div className="mt-1 text-[11px] text-stone-400">
            Backhand avg / max
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            Avg Net Clearance
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold tabular-nums">
              {summary.netClearanceAvgM !== null
                ? `${summary.netClearanceAvgM.toFixed(2)} m`
                : "—"}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-stone-400 tabular-nums">
            {summary.netClearanceAvgM !== null
              ? `${Math.round(summary.netClearanceAvgM * 100)} cm above net`
              : "Height above net strap"}
          </div>
        </div>

        <div className="col-span-2 sm:col-span-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3.5">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            Deep Zone %
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tabular-nums text-sky-600 dark:text-sky-400">
              {summary.deepZonePct}%
            </span>
            <span className="text-xs text-stone-500">6.4–11.9m</span>
          </div>
          <div className="mt-1 text-[11px] text-stone-400 tabular-nums">
            Short balls: {summary.shortZonePct}%
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
            key: "fastest",
            label: `⚡ Fastest Shots (70+ mph) (${detail.rallies.filter(isFastRally).length})`,
          },
          {
            key: "deep",
            label: `🎯 Deep Shots (${detail.rallies.filter(isDeepRally).length})`,
          },
          {
            key: "bookmarked",
            label: `⭐ Bookmarked (${detail.rallies.filter((r) => r.bookmarked).length})`,
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
                      {(activeRally.endS - activeRally.startS).toFixed(1)}s duration)
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

                {/* Interactive Shot-by-Shot Scrubber Chip Strip & Shot Table */}
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
                            <span className="uppercase">{formatStrokeUpper(s.stroke)}</span>
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
                            <th className="py-1.5 pr-3">Shot #</th>
                            <th className="py-1.5 pr-3">Player</th>
                            <th className="py-1.5 pr-3">Stroke</th>
                            <th className="py-1.5 pr-3">Direction</th>
                            <th className="py-1.5 pr-3">Ball Speed</th>
                            <th className="py-1.5 pr-3">Net Clearance</th>
                            <th className="py-1.5">Bounce Depth</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 dark:divide-stone-800 tabular-nums">
                          {activeRally.shots.map((s) => {
                            const isSelectedShot = selectedShotIdx === s.shotIdx;
                            const hitLocalS = toClipLocalTimeS(s.tHitS, activeRally.startS);
                            const shotHref = `/tennis/${detail.id}?filter=${activeFilter}&rally=${activeRally.rallyIdx}&shot=${s.shotIdx}&hide1=${hideOneShotFeeds ? "1" : "0"}`;
                            const depthBadge = formatBounceDepthLabel(s.depthZone);
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
                                <td className="py-1.5 pr-3 text-stone-600 dark:text-stone-400">
                                  <Link href={shotHref} className="block">
                                    {formatPlayerLabel(s.hitter)}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3 font-semibold uppercase">
                                  <Link href={shotHref} className="block">
                                    {formatStrokeUpper(s.stroke)}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3 text-stone-600 dark:text-stone-400">
                                  <Link href={shotHref} className="block">
                                    {formatDirectionLabel(s.direction)}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3 font-medium">
                                  <Link href={shotHref} className="block">
                                    {s.speedMph !== null ? `${s.speedMph} mph` : "—"}
                                  </Link>
                                </td>
                                <td className="py-1.5 pr-3">
                                  <Link href={shotHref} className="block">
                                    {s.netClearanceM !== null
                                      ? `${s.netClearanceM.toFixed(2)} m (${Math.round(s.netClearanceM * 100)} cm)`
                                      : "—"}
                                  </Link>
                                </td>
                                <td className="py-1.5">
                                  <Link href={shotHref} className="inline-block">
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${depthBadge.className}`}
                                    >
                                      {depthBadge.label}
                                    </span>
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
                  const rallySpeeds = r.shots
                    .map((s) => s.speedMph)
                    .filter((v): v is number => v !== null && v > 0);
                  const maxRallySpeed =
                    rallySpeeds.length > 0 ? Math.max(...rallySpeeds) : null;

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
                        {maxRallySpeed !== null && (
                          <span className="ml-1.5 rounded bg-emerald-100 dark:bg-emerald-950/60 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-emerald-800 dark:text-emerald-300">
                            ⚡ {maxRallySpeed} mph
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

        {/* Right Column: 2D SVG Court Minimap + Top Speed Shots (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-xs uppercase tracking-wide text-stone-500">
                2D ITF Court Minimap (Stroke &amp; Depth Zones)
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

          {/* Top Speed Shots Leaderboard */}
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4">
            <h3 className="text-xs uppercase tracking-wide text-stone-500 mb-2">
              ⚡ Fastest Shots ({topSpeedShots.length})
            </h3>
            <p className="text-xs text-stone-400 mb-3">
              3D ballistic trajectory speed &amp; net clearance. Click any shot to seek the rally clip.
            </p>
            {topSpeedShots.length === 0 ? (
              <p className="text-xs text-stone-500 italic">
                No ball speed measurements recorded in this session yet.
              </p>
            ) : (
              <ul className="divide-y divide-stone-100 dark:divide-stone-800 text-xs">
                {topSpeedShots.map((s) => {
                  const rStartS = rallyStartByIdx.get(s.rallyIdx) ?? 0;
                  const clipHitS = toClipLocalTimeS(s.tHitS, rStartS);
                  const isActiveFastShot =
                    activeRally?.rallyIdx === s.rallyIdx &&
                    selectedShotIdx === s.shotIdx;

                  return (
                    <li key={`fast-${s.rallyIdx}-${s.shotIdx}`} className="py-1.5">
                      <Link
                        href={`/tennis/${detail.id}?filter=${activeFilter}&rally=${s.rallyIdx}&shot=${s.shotIdx}&hide1=${hideOneShotFeeds ? "1" : "0"}`}
                        className={`flex items-center justify-between gap-2 rounded-md p-2 transition ${
                          isActiveFastShot
                            ? "border border-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/30"
                            : "hover:bg-stone-50 dark:hover:bg-stone-800/60"
                        }`}
                      >
                        <div>
                          <div className="font-medium">
                            Rally #{s.rallyIdx + 1} · Shot #{s.shotIdx + 1} (
                            {formatStrokeUpper(s.stroke)})
                          </div>
                          <div className="text-stone-400 tabular-nums">
                            {clipHitS !== null ? `${clipHitS.toFixed(1)}s` : "—"} ·{" "}
                            {s.netClearanceM !== null
                              ? `${Math.round(s.netClearanceM * 100)} cm net`
                              : "net n/a"}{" "}
                            · {formatBounceDepthLabel(s.depthZone).label}
                          </div>
                        </div>
                        <span className="rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 px-2 py-0.5 font-semibold tabular-nums">
                          {s.speedMph} mph
                        </span>
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
