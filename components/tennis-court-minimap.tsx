import {
  courtToSvg,
  ITF_DOUBLES_HALF_WIDTH_M,
  ITF_HALF_LENGTH_M,
  ITF_NET_POST_OFFSET_M,
  ITF_SERVICE_LINE_M,
  ITF_SINGLES_HALF_WIDTH_M,
  type TennisShot,
} from "@/lib/tennis";

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

function callColor(call: TennisShot["call"]): {
  fill: string;
  stroke: string;
  label: string;
} {
  if (call === "in") {
    return { fill: "#10b981", stroke: "#047857", label: "IN" };
  }
  if (call === "out") {
    return { fill: "#f43f5e", stroke: "#be123c", label: "OUT" };
  }
  if (call === "close") {
    return { fill: "#f59e0b", stroke: "#b45309", label: "CLOSE (±2σ)" };
  }
  return { fill: "#a8a29e", stroke: "#57534e", label: "UNKNOWN" };
}

/**
 * Server-safe 2D ITF metric SVG court minimap displaying shaded Deep Target Zones
 * ($6.40\text{–}11.885\text{ m}$), shot trajectory vectors, and color-coded bounce locations
 * (`in` green, `out` red, `close` amber) with uncertainty rings.
 *
 * @param props - `TennisCourtMinimapProps` containing shots, doubles mode, and deep-zone shading options.
 * @returns Rendered `<svg>` court minimap element.
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
              Deep Zone (6.4–11.9m)
            </text>
            <text
              x={VIEW_W / 2}
              y={nearDeepBR.y - 8}
              textAnchor="middle"
              className="fill-emerald-200/75 text-[8px] font-semibold tracking-wider uppercase"
            >
              Deep Zone (6.4–11.9m)
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
            const isHighlighted =
              activeShotIdx === null || activeShotIdx === shot.shotIdx;

            return (
              <line
                key={`vec-${shot.rallyIdx}-${shot.shotIdx}`}
                x1={pHit.x}
                y1={pHit.y}
                x2={pBounce.x}
                y2={pBounce.y}
                stroke="#38bdf8"
                strokeWidth={isHighlighted ? "1.6" : "1.0"}
                strokeOpacity={isHighlighted ? "0.72" : "0.25"}
                markerEnd="url(#shot-arrow)"
              />
            );
          })}
        </g>

        {/* Bounce impact dots + 2-sigma uncertainty halo */}
        <g>
          {filteredShots.map((shot) => {
            if (shot.bounceX === null || shot.bounceY === null) return null;
            const pBounce = pt(shot.bounceX, shot.bounceY);
            const colors = callColor(shot.call);
            const isHighlighted =
              activeShotIdx === null || activeShotIdx === shot.shotIdx;
            const sigmaRadiusPx = Math.min(
              14,
              Math.max(5.5, (shot.sigmaM ?? 0.03) * 2 * 18),
            );
            const marginCm =
              shot.marginM !== null ? `${(Math.abs(shot.marginM) * 100).toFixed(1)} cm` : "—";

            return (
              <g
                key={`bounce-${shot.rallyIdx}-${shot.shotIdx}`}
                opacity={isHighlighted ? 1 : 0.4}
              >
                <title>
                  {`Rally #${shot.rallyIdx + 1} · Shot #${shot.shotIdx + 1} (${(shot.stroke ?? "shot").toUpperCase()}) · ${colors.label} (${marginCm}) · ${shot.speedMph ? `${shot.speedMph} mph` : "speed n/a"} · Zone: ${shot.depthZone ?? "unknown"}`}
                </title>
                {shot.call === "close" && (
                  <circle
                    cx={pBounce.x}
                    cy={pBounce.y}
                    r={sigmaRadiusPx}
                    fill="none"
                    stroke={colors.fill}
                    strokeWidth="1.2"
                    strokeDasharray="2 2"
                  />
                )}
                <circle
                  cx={pBounce.x}
                  cy={pBounce.y}
                  r={isHighlighted ? "4.6" : "3.5"}
                  fill={colors.fill}
                  stroke="#0f172a"
                  strokeWidth="1.2"
                />
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-3 text-xs text-stone-600 dark:text-stone-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 inline-block" />
          In
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500 inline-block" />
          Close (±2σ)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500 inline-block" />
          Out (Play-On Tracked)
        </span>
        {showDeepZones && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/30 border border-emerald-500 inline-block" />
            Deep Target (6.4–11.9m)
          </span>
        )}
      </div>
    </div>
  );
}
