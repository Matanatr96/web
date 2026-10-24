"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  bounceStyle,
  courtToSvg,
  ITF_DOUBLES_HALF_WIDTH_M,
  ITF_HALF_LENGTH_M,
  ITF_NET_POST_OFFSET_M,
  ITF_SERVICE_LINE_M,
  ITF_SINGLES_HALF_WIDTH_M,
  type TennisMatchStatus,
  type TennisShot,
} from "@/lib/tennis";

export { bounceStyle };

export interface TennisCourtMinimapProps {
  /** Shots to render on the 2D court diagram. */
  shots: TennisShot[];
  /** Whether doubles sidelines are active for this session. */
  doubles?: boolean;
  /** Whether to highlight the Deep Target Zone (6.40m to 11.885m behind service lines). */
  showDeepZones?: boolean;
  /** Optional index of a highlighted shot (`shotIdx`). */
  activeShotIdx?: number | null;
  /** Optional rally index filter. */
  rallyIdx?: number | null;
}

const VIEW_W = 280;
const VIEW_H = 520;
const PAD_M = 2.0;

function pt(xM: number, yM: number) {
  return courtToSvg(xM, yM, { width: VIEW_W, height: VIEW_H, padM: PAD_M });
}

function formatStrokeLabel(stroke: string | null): string {
  if (!stroke) return "Shot";
  const lower = stroke.toLowerCase();
  if (lower === "fh" || lower === "forehand") return "FH";
  if (lower === "bh" || lower === "backhand") return "BH";
  if (lower === "serve") return "Serve";
  return stroke.toUpperCase();
}

/**
 * Server-safe 2D ITF metric SVG court minimap displaying shaded Deep Target Zones
 * ($6.40\text{–}11.885\text{ m}$), shot trajectory vectors, bounce locations colored by
 * Stroke Type / Depth Zone (`deep` emerald, `short` cyan, `serve` amber, `other` slate),
 * a `◆ Selected Shot` diamond marker, a visual legend, and a compact selected-shot callout badge.
 *
 * @param props - `TennisCourtMinimapProps` containing shots, doubles mode, deep-zone shading, and `activeShotIdx`.
 * @returns Rendered `<svg>` court minimap, visual legend, and selected-shot callout.
 */
export default function TennisCourtMinimap({
  shots,
  doubles = false,
  showDeepZones = true,
  activeShotIdx = null,
  rallyIdx = null,
}: TennisCourtMinimapProps) {
  const filteredShots =
    rallyIdx !== null && rallyIdx !== undefined
      ? shots.filter((s) => s.rallyIdx === rallyIdx)
      : shots;

  const selectedShot =
    activeShotIdx !== null && activeShotIdx !== undefined
      ? (filteredShots.find((s) => s.shotIdx === activeShotIdx) ?? null)
      : null;

  const activeHalfW = doubles ? ITF_DOUBLES_HALF_WIDTH_M : ITF_SINGLES_HALF_WIDTH_M;

  // Outer doubles court rectangle
  const topLeftDoubles = pt(-ITF_DOUBLES_HALF_WIDTH_M, ITF_HALF_LENGTH_M);
  const bottomRightDoubles = pt(ITF_DOUBLES_HALF_WIDTH_M, -ITF_HALF_LENGTH_M);
  const courtW = bottomRightDoubles.x - topLeftDoubles.x;
  const courtH = bottomRightDoubles.y - topLeftDoubles.y;

  // Singles sidelines
  const topLeftSingles = pt(-ITF_SINGLES_HALF_WIDTH_M, ITF_HALF_LENGTH_M);
  const bottomRightSingles = pt(ITF_SINGLES_HALF_WIDTH_M, -ITF_HALF_LENGTH_M);

  // Service lines
  const farServiceLeft = pt(-ITF_SINGLES_HALF_WIDTH_M, ITF_SERVICE_LINE_M);
  const farServiceRight = pt(ITF_SINGLES_HALF_WIDTH_M, ITF_SERVICE_LINE_M);
  const nearServiceLeft = pt(-ITF_SINGLES_HALF_WIDTH_M, -ITF_SERVICE_LINE_M);
  const nearServiceRight = pt(ITF_SINGLES_HALF_WIDTH_M, -ITF_SERVICE_LINE_M);

  // Center service line & center marks
  const centerServiceTop = pt(0, ITF_SERVICE_LINE_M);
  const centerServiceBottom = pt(0, -ITF_SERVICE_LINE_M);
  const farCenterMarkTop = pt(0, ITF_HALF_LENGTH_M);
  const farCenterMarkBottom = pt(0, ITF_HALF_LENGTH_M - 0.35);
  const nearCenterMarkBottom = pt(0, -ITF_HALF_LENGTH_M);
  const nearCenterMarkTop = pt(0, -ITF_HALF_LENGTH_M + 0.35);

  // Net and net posts
  const netPostOffset = ITF_DOUBLES_HALF_WIDTH_M + ITF_NET_POST_OFFSET_M;
  const netLeft = pt(-netPostOffset, 0);
  const netRight = pt(netPostOffset, 0);

  // Deep Target Zones (6.40m to 11.885m on both ends)
  const farDeepTL = pt(-activeHalfW, ITF_HALF_LENGTH_M);
  const farDeepBR = pt(activeHalfW, ITF_SERVICE_LINE_M);
  const nearDeepTL = pt(-activeHalfW, -ITF_SERVICE_LINE_M);
  const nearDeepBR = pt(activeHalfW, -ITF_HALF_LENGTH_M);

  return (
    <div className="flex flex-col items-center">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full max-w-[290px] rounded-lg border border-stone-200 dark:border-stone-800 bg-emerald-950 shadow-inner"
        role="img"
        aria-label="2D ITF Tennis Court Minimap with Bounce Locations and Deep Target Zones"
      >
        <defs>
          <marker
            id="shot-arrow"
            viewBox="0 0 10 10"
            refX="7"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" fillOpacity="0.85" />
          </marker>
        </defs>

        {/* Outer apron surface */}
        <rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="#064e3b" />

        {/* Hard-court playing surface */}
        <rect
          x={topLeftDoubles.x}
          y={topLeftDoubles.y}
          width={courtW}
          height={courtH}
          fill="#1e3a8a"
          opacity="0.92"
        />

        {/* Shaded Deep Target Zones (6.4m - 11.885m) */}
        {showDeepZones && (
          <g>
            <rect
              x={farDeepTL.x}
              y={farDeepTL.y}
              width={farDeepBR.x - farDeepTL.x}
              height={farDeepBR.y - farDeepTL.y}
              fill="#10b981"
              fillOpacity="0.18"
            />
            <rect
              x={nearDeepTL.x}
              y={nearDeepTL.y}
              width={nearDeepBR.x - nearDeepTL.x}
              height={nearDeepBR.y - nearDeepTL.y}
              fill="#10b981"
              fillOpacity="0.18"
            />
            <text
              x={VIEW_W / 2}
              y={farDeepTL.y + 16}
              textAnchor="middle"
              className="fill-emerald-200/75 text-[8px] font-semibold tracking-wider uppercase"
            >
              Deep Target Zone (6.4–11.9m)
            </text>
            <text
              x={VIEW_W / 2}
              y={nearDeepBR.y - 8}
              textAnchor="middle"
              className="fill-emerald-200/75 text-[8px] font-semibold tracking-wider uppercase"
            >
              Deep Target Zone (6.4–11.9m)
            </text>
          </g>
        )}

        {/* ITF White Court Lines */}
        <g stroke="#f8fafc" strokeWidth="1.6" fill="none">
          {/* Doubles outer boundary */}
          <rect
            x={topLeftDoubles.x}
            y={topLeftDoubles.y}
            width={courtW}
            height={courtH}
          />
          {/* Singles sidelines */}
          <line
            x1={topLeftSingles.x}
            y1={topLeftSingles.y}
            x2={topLeftSingles.x}
            y2={bottomRightSingles.y}
          />
          <line
            x1={bottomRightSingles.x}
            y1={topLeftSingles.y}
            x2={bottomRightSingles.x}
            y2={bottomRightSingles.y}
          />
          {/* Service lines */}
          <line
            x1={farServiceLeft.x}
            y1={farServiceLeft.y}
            x2={farServiceRight.x}
            y2={farServiceRight.y}
          />
          <line
            x1={nearServiceLeft.x}
            y1={nearServiceLeft.y}
            x2={nearServiceRight.x}
            y2={nearServiceRight.y}
          />
          {/* Center service line */}
          <line
            x1={centerServiceTop.x}
            y1={centerServiceTop.y}
            x2={centerServiceBottom.x}
            y2={centerServiceBottom.y}
          />
          {/* Baseline center marks */}
          <line
            x1={farCenterMarkTop.x}
            y1={farCenterMarkTop.y}
            x2={farCenterMarkBottom.x}
            y2={farCenterMarkBottom.y}
          />
          <line
            x1={nearCenterMarkBottom.x}
            y1={nearCenterMarkBottom.y}
            x2={nearCenterMarkTop.x}
            y2={nearCenterMarkTop.y}
          />
        </g>

        {/* Net line & posts */}
        <g>
          <line
            x1={netLeft.x}
            y1={netLeft.y}
            x2={netRight.x}
            y2={netRight.y}
            stroke="#e2e8f0"
            strokeWidth="2.5"
            strokeDasharray="4 2"
          />
          <circle cx={netLeft.x} cy={netLeft.y} r="3.2" fill="#f8fafc" />
          <circle cx={netRight.x} cy={netRight.y} r="3.2" fill="#f8fafc" />
        </g>

        {/* Shot trajectory vectors (hit -> bounce) */}
        <g>
          {filteredShots.map((shot) => {
            if (
              shot.hitX === null ||
              shot.hitY === null ||
              shot.bounceX === null ||
              shot.bounceY === null
            ) {
              return null;
            }
            const pHit = pt(shot.hitX, shot.hitY);
            const pBounce = pt(shot.bounceX, shot.bounceY);
            const isSelected = activeShotIdx === shot.shotIdx;
            const isHighlighted = activeShotIdx === null || isSelected;

            return (
              <line
                key={`vec-${shot.rallyIdx}-${shot.shotIdx}`}
                x1={pHit.x}
                y1={pHit.y}
                x2={pBounce.x}
                y2={pBounce.y}
                stroke={isSelected ? "#facc15" : "#38bdf8"}
                strokeWidth={isSelected ? "2.4" : isHighlighted ? "1.6" : "1.0"}
                strokeOpacity={isHighlighted ? "0.85" : "0.25"}
                markerEnd="url(#shot-arrow)"
              />
            );
          })}
        </g>

        {/* Bounce impact dots colored by Stroke Type / Depth Zone and ◆ Selected Shot diamond */}
        <g>
          {filteredShots.map((shot) => {
            if (shot.bounceX === null || shot.bounceY === null) return null;
            const pBounce = pt(shot.bounceX, shot.bounceY);
            const colors = bounceStyle(shot);
            const isSelected = activeShotIdx === shot.shotIdx;
            const isHighlighted = activeShotIdx === null || isSelected;
            const clearanceLabel =
              shot.netClearanceM !== null
                ? `${Math.round(shot.netClearanceM * 100)} cm net`
                : "net n/a";
            const d = 6.8;

            return (
              <g
                key={`bounce-${shot.rallyIdx}-${shot.shotIdx}`}
                opacity={isHighlighted ? 1 : 0.38}
              >
                <title>
                  {`Rally #${shot.rallyIdx + 1} · Shot #${shot.shotIdx + 1} (${formatStrokeLabel(shot.stroke)}) · ${shot.speedMph ? `${shot.speedMph} mph` : "speed n/a"} · ${clearanceLabel} · ${colors.label}`}
                </title>
                {isSelected ? (
                  <>
                    <circle
                      cx={pBounce.x}
                      cy={pBounce.y}
                      r="9.5"
                      fill="none"
                      stroke="#facc15"
                      strokeWidth="1.5"
                      strokeOpacity="0.9"
                    />
                    <polygon
                      points={`${pBounce.x},${pBounce.y - d} ${pBounce.x + d},${pBounce.y} ${pBounce.x},${pBounce.y + d} ${pBounce.x - d},${pBounce.y}`}
                      fill={colors.fill}
                      stroke="#ffffff"
                      strokeWidth="1.6"
                    />
                  </>
                ) : (
                  <circle
                    cx={pBounce.x}
                    cy={pBounce.y}
                    r={isHighlighted ? "4.4" : "3.4"}
                    fill={colors.fill}
                    stroke={colors.stroke}
                    strokeWidth="1.2"
                  />
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Visual Legend */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] font-medium text-stone-600 dark:text-stone-400">
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
          <span>●</span> Deep Zone
        </span>
        <span className="inline-flex items-center gap-1 text-cyan-700 dark:text-cyan-400">
          <span>●</span> Short
        </span>
        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <span>●</span> Serve
        </span>
        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300">
          <span>◆</span> Selected Shot ◆
        </span>
      </div>

      {/* Selected-Shot Detail Callout Badge */}
      <div className="mt-3 w-full">
        {selectedShot ? (
          <div className="rounded-md border border-emerald-300 dark:border-emerald-800/80 bg-emerald-50/70 dark:bg-emerald-950/30 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="font-semibold text-stone-900 dark:text-stone-100">
                ◆ Shot #{selectedShot.shotIdx + 1} · {formatStrokeLabel(selectedShot.stroke)}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                  selectedShot.depthZone === "deep"
                    ? "bg-emerald-200/80 text-emerald-900 dark:bg-emerald-900/70 dark:text-emerald-200"
                    : selectedShot.depthZone === "short"
                      ? "bg-cyan-200/80 text-cyan-900 dark:bg-cyan-900/70 dark:text-cyan-200"
                      : "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300"
                }`}
              >
                {selectedShot.depthZone === "deep"
                  ? "Deep"
                  : selectedShot.depthZone === "short"
                    ? "Short"
                    : bounceStyle(selectedShot).label}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-600 dark:text-stone-300 tabular-nums">
              <span>
                Speed:{" "}
                <strong>
                  {selectedShot.speedMph !== null ? `${selectedShot.speedMph} mph` : "— mph"}
                </strong>
              </span>
              <span>
                Net Clearance:{" "}
                <strong>
                  {selectedShot.netClearanceM !== null
                    ? `${selectedShot.netClearanceM.toFixed(2)} m (${Math.round(selectedShot.netClearanceM * 100)} cm)`
                    : "—"}
                </strong>
              </span>
              <span>
                Depth:{" "}
                <strong className="uppercase">
                  {selectedShot.depthZone === "deep"
                    ? "Deep"
                    : selectedShot.depthZone === "short"
                      ? "Short"
                      : (selectedShot.depthZone ?? "unknown")}
                </strong>
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-stone-200 dark:border-stone-800 px-3 py-2 text-center text-[11px] text-stone-400">
            Click any shot in the scrubber to highlight its ◆ bounce, ball speed &amp; depth zone
          </div>
        )}
      </div>
    </div>
  );
}

export interface TennisClipPlayerProps {
  /** Modal HTTP Byte-Range video clip URL. */
  src: string;
  /** Optional clip-local timestamp (seconds) to seek to when a shot or challenge is selected. */
  seekToS?: number | null;
  /** Initial playback rate (`1`, `0.5`, or `0.25`). */
  playbackRate?: number;
  /** Optional href for navigating to the previous rally in the active filter view. */
  prevRallyHref?: string | null;
  /** Optional href for navigating to the next rally in the active filter view. */
  nextRallyHref?: string | null;
  /** Optional active shot index so re-selecting a shot re-triggers seek cleanly. */
  activeShotIdx?: number | null;
}

const SPEED_OPTIONS: Array<{ rate: number; label: string }> = [
  { rate: 1, label: "1.0×" },
  { rate: 0.5, label: "0.5×" },
  { rate: 0.25, label: "0.25× Slow-Mo" },
];

/**
 * Client-side `<video>` player for Modal HTTP Byte-Range rally clips with an integrated
 * 1-click control bar right beneath the video (**← Prev Rally**, **Next Rally →**, **Replay Rally**,
 * and **Playback Speed pills (`1.0×`, `0.5×`, `0.25× Slow-Mo`)**). Automatically seeks to a
 * selected shot/bounce timestamp (`seekToS`) and applies the selected playback speed.
 *
 * @param props - `TennisClipPlayerProps` with clip `src`, `seekToS`, `playbackRate`, and rally nav links.
 * @returns Rendered `<video>` element and interactive rally/speed control bar.
 */
export function TennisClipPlayer({
  src,
  seekToS = null,
  playbackRate = 1,
  prevRallyHref = null,
  nextRallyHref = null,
  activeShotIdx = null,
}: TennisClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [rate, setRate] = useState<number>(playbackRate);
  const rateRef = useRef<number>(playbackRate);
  const prevPropRateRef = useRef<number>(playbackRate);

  useEffect(() => {
    const propChanged = prevPropRateRef.current !== playbackRate;
    prevPropRateRef.current = playbackRate;
    const effectiveRate = propChanged ? playbackRate : rateRef.current;
    rateRef.current = effectiveRate;
    setRate(effectiveRate);

    const video = videoRef.current;
    if (!video) return;

    const applySeekAndRate = () => {
      video.defaultPlaybackRate = rateRef.current;
      video.playbackRate = rateRef.current;
      if (seekToS !== null && Number.isFinite(seekToS)) {
        const clamped =
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.min(Math.max(0, seekToS), Math.max(0, video.duration - 0.05))
            : Math.max(0, seekToS);
        video.currentTime = clamped;
        void video.play().catch(() => {
          // Autoplay may be blocked before user interaction; leave paused at seek frame.
        });
      }
    };

    if (video.readyState >= 1) {
      applySeekAndRate();
      return;
    }

    video.addEventListener("loadedmetadata", applySeekAndRate, { once: true });
    return () => {
      video.removeEventListener("loadedmetadata", applySeekAndRate);
    };
  }, [src, seekToS, playbackRate, activeShotIdx]);

  const handleSpeedChange = (newRate: number) => {
    rateRef.current = newRate;
    setRate(newRate);
    if (videoRef.current) {
      videoRef.current.defaultPlaybackRate = newRate;
      videoRef.current.playbackRate = newRate;
    }
  };

  const handleReplayRally = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    video.playbackRate = rate;
    void video.play().catch(() => {});
  };

  return (
    <div className="space-y-2.5">
      <video
        ref={videoRef}
        key={src}
        src={src}
        controls
        playsInline
        preload="metadata"
        className="w-full aspect-video rounded-md bg-stone-950 border border-stone-800"
      />

      {/* Sleek Rally Navigation & Playback Speed Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-950/60 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {prevRallyHref ? (
            <Link
              href={prevRallyHref}
              className="rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-2.5 py-1 font-medium text-stone-700 dark:text-stone-200 hover:border-stone-400 transition"
            >
              ← Prev Rally
            </Link>
          ) : (
            <span className="rounded border border-stone-200 dark:border-stone-800 px-2.5 py-1 font-medium text-stone-400 dark:text-stone-600 cursor-not-allowed">
              ← Prev Rally
            </span>
          )}

          {nextRallyHref ? (
            <Link
              href={nextRallyHref}
              className="rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-2.5 py-1 font-medium text-stone-700 dark:text-stone-200 hover:border-stone-400 transition"
            >
              Next Rally →
            </Link>
          ) : (
            <span className="rounded border border-stone-200 dark:border-stone-800 px-2.5 py-1 font-medium text-stone-400 dark:text-stone-600 cursor-not-allowed">
              Next Rally →
            </span>
          )}

          <button
            type="button"
            onClick={handleReplayRally}
            className="rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-2.5 py-1 font-medium text-stone-700 dark:text-stone-200 hover:border-stone-400 transition cursor-pointer"
          >
            ↺ Replay Rally
          </button>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Playback Speed">
          <span className="text-[11px] text-stone-400 mr-1">Speed:</span>
          {SPEED_OPTIONS.map((opt) => {
            const isActive = Math.abs(rate - opt.rate) < 0.01;
            return (
              <button
                key={opt.rate}
                type="button"
                onClick={() => handleSpeedChange(opt.rate)}
                aria-pressed={isActive}
                className={`rounded-full px-2.5 py-0.5 font-medium transition cursor-pointer ${
                  isActive
                    ? "bg-emerald-600 text-white"
                    : "border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-600 dark:text-stone-400 hover:border-stone-400"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Polls `router.refresh()` every 4 seconds while a session is in `"processing"` or `"uploading"`
 * state so newly processed rallies and summary metrics stream into `/tennis/[id]` automatically.
 *
 * @param props - Current `status` of the session.
 * @returns An inline live-polling indicator badge when active, or `null`.
 */
export function TennisStatusPoller({ status }: { status: TennisMatchStatus }) {
  const router = useRouter();
  const isPending = status === "processing" || status === "uploading";

  useEffect(() => {
    if (!isPending) return;
    const timer = window.setInterval(() => {
      router.refresh();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [isPending, router]);

  if (!isPending) return null;
  return (
    <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-amber-100 dark:bg-amber-950/60 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
      Auto-refreshing every 4s
    </span>
  );
}
