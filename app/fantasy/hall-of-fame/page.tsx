import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type {
  BracketEntry,
  FantasyLeague,
  FantasyOwner,
  HallOfFameEntry,
  LegacyScoreMode,
} from "@/lib/types";
import { computeHallOfFame, fetchAllMatchups, ownerColorMap } from "@/lib/fantasy";
import { fmt } from "@/lib/utils";
import RefreshMatchupsButton from "@/components/refresh-matchups-button";

export const dynamic = "force-dynamic";

type SearchParams = { mode?: string };

const MODES: { id: LegacyScoreMode; label: string; subtitle: string }[] = [
  {
    id: "balanced",
    label: "Balanced",
    subtitle: "35 Hardware · 25 Win% · 25 Dominance · 15 Playoffs · −2.5/Last",
  },
  {
    id: "rings",
    label: "Rings First",
    subtitle: "50 Hardware · 18 Win% · 17 Dominance · 15 Playoffs · −3.0/Last",
  },
  {
    id: "dominance",
    label: "No-Luck Dominance",
    subtitle: "20 Hardware · 25 Win% · 40 All-Play & PPG · 15 Playoffs · −2.5/Last",
  },
];

/**
 * Renders the KFL Hall of Fame & Legacy Score page with championship banners,
 * fantasyhoff-styled manager legacy cards, hardware counters (1st, 2nd, Last),
 * archetype badges, and expandable 5-pillar score breakdowns.
 */
export default async function FantasyHallOfFamePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const requestedMode = params.mode as LegacyScoreMode | undefined;
  const mode: LegacyScoreMode =
    requestedMode === "rings" || requestedMode === "dominance"
      ? requestedMode
      : "balanced";
  const activeModeMeta = MODES.find((m) => m.id === mode) ?? MODES[0];

  const db = getSupabase();
  const [{ data: leagueData }, { data: ownerData }, matchups] = await Promise.all([
    db.from("fantasy_leagues").select("*").order("season", { ascending: false }),
    db.from("fantasy_owners").select("*"),
    fetchAllMatchups(db),
  ]);

  const leagues = (leagueData ?? []) as FantasyLeague[];
  const owners = (ownerData ?? []) as FantasyOwner[];
  const colorMap = ownerColorMap(owners);
  const entries = computeHallOfFame(matchups, owners, leagues, mode);

  const ownerName = (id: string | null | undefined) =>
    id ? (owners.find((o) => o.user_id === id)?.display_name ?? id) : null;

  // Completed championship banners (newest first)
  const banners = leagues
    .map((league) => {
      const bracket = (league.winners_bracket ?? null) as BracketEntry[] | null;
      const p1 = bracket?.find((b) => b.p === 1);
      const p3 = bracket?.find((b) => b.p === 3);
      if (!p1?.w) return null;
      return {
        season: league.season,
        championId: p1.w,
        championName: ownerName(p1.w) ?? p1.w,
        runnerUpName: ownerName(p1.l),
        thirdPlaceName: ownerName(p3?.w),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b != null)
    .sort((a, b) => b.season - a.season);

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

      <div className="flex items-start justify-between flex-wrap gap-4 mb-8">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Hall of Fame</h1>
          <p className="mt-1 text-sm text-stone-500 max-w-2xl">
            Every KFL manager scored out of 100 across league history — blending championship
            hardware, regular-season win rate, all-play scoring dominance, and playoff pedigree.
          </p>
        </div>
        <RefreshMatchupsButton />
      </div>

      {/* Championship Banners */}
      {banners.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-3">
            Championship Banners
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
            {banners.map((b) => (
              <div
                key={b.season}
                className="relative rounded-lg border border-[#d4af37]/40 bg-[#163024] text-white px-4 py-3.5 shadow-sm overflow-hidden"
              >
                <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-[#d4af37] font-semibold mb-1.5">
                  <span>{b.season} KFL</span>
                  <span>🏆</span>
                </div>
                <div className="text-base font-bold truncate">{b.championName}</div>
                <div className="mt-2 pt-2 border-t border-white/10 text-[11px] text-emerald-100/70 space-y-0.5">
                  {b.runnerUpName && (
                    <div className="truncate">
                      <span className="text-[#d4af37]/80">2nd:</span> {b.runnerUpName}
                    </div>
                  )}
                  {b.thirdPlaceName && (
                    <div className="truncate">
                      <span className="text-[#d4af37]/80">3rd:</span> {b.thirdPlaceName}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Formula Mode Picker */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="inline-flex rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-100/70 dark:bg-stone-900 p-1">
          {MODES.map((m) => {
            const active = m.id === mode;
            return (
              <Link
                key={m.id}
                href={
                  m.id === "balanced"
                    ? "/fantasy/hall-of-fame"
                    : `/fantasy/hall-of-fame?mode=${m.id}`
                }
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  active
                    ? "bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 shadow-xs"
                    : "text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
                }`}
              >
                {m.label}
              </Link>
            );
          })}
        </div>
        <span className="text-xs text-stone-500">{activeModeMeta.subtitle}</span>
      </div>

      {/* Column Headers (Desktop) */}
      <div className="hidden sm:grid sm:grid-cols-[72px_1fr_196px_148px] px-2 py-2 text-[11px] font-semibold uppercase tracking-widest text-stone-400">
        <div className="text-center">Rank</div>
        <div className="pl-4">Manager / Career</div>
        <div className="text-center">Hardware</div>
        <div className="text-center">Legacy Score</div>
      </div>

      {/* Hall of Fame Cards */}
      <div className="space-y-3.5">
        {entries.map((entry, idx) => (
          <HallOfFameCard
            key={entry.owner_id}
            entry={entry}
            rank={idx + 1}
            accentColor={colorMap.get(entry.owner_id) ?? ""}
          />
        ))}
      </div>
    </div>
  );
}

function HallOfFameCard({
  entry,
  rank,
  accentColor,
}: {
  entry: HallOfFameEntry;
  rank: number;
  accentColor: string;
}) {
  const isWorst = entry.archetype === "THE LEAGUE'S WORST";
  const isFirst = rank === 1;

  return (
    <details className="group rounded-xl border border-stone-300/80 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xs overflow-hidden">
      <summary className="cursor-pointer select-none list-none">
        <div className="grid grid-cols-1 sm:grid-cols-[72px_1fr_196px_148px] bg-[#163024] text-white">
          {/* RANK */}
          <div className="flex sm:flex-col items-center justify-between sm:justify-center px-4 py-2.5 sm:py-4 bg-[#10241b] border-b sm:border-b-0 sm:border-r border-white/10 border-l-4 border-l-[#d4af37]">
            <span className="text-[10px] uppercase tracking-widest text-[#d4af37]/80 sm:hidden">
              Rank #{rank}
            </span>
            <span className="text-2xl sm:text-3xl font-extrabold tabular-nums text-[#d4af37]">
              {rank}
            </span>
            <span className="text-[11px] text-emerald-100/60 sm:hidden">
              Tap for breakdown ▾
            </span>
          </div>

          {/* MANAGER / CAREER */}
          <div className="flex flex-col justify-center px-5 py-4 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <span
                className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
                  isWorst
                    ? "border-amber-400/60 bg-amber-950/60 text-amber-300"
                    : isFirst
                      ? "border-[#d4af37] bg-[#d4af37]/20 text-[#f3d467]"
                      : "border-[#d4af37]/50 bg-[#10241b]/70 text-[#d4af37]"
                }`}
              >
                {entry.archetype}
              </span>
            </div>
            <div className="flex items-baseline gap-2.5 flex-wrap">
              <span className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white truncate">
                {entry.display_name}
              </span>
              <span className="text-xs sm:text-sm text-emerald-100/75 font-medium">
                {entry.seasons_played} {entry.seasons_played === 1 ? "season" : "seasons"}
              </span>
            </div>
            <div className="mt-1 text-xs text-emerald-100/65 tabular-nums">
              {entry.wins}–{entry.losses}
              {entry.ties > 0 ? `–${entry.ties}` : ""} ({fmt(entry.win_pct * 100, 1)}%)
              <span className="mx-1.5 opacity-40">·</span>
              {fmt(entry.avg_ppg, 1)} PPG
              <span className="mx-1.5 opacity-40">·</span>
              {entry.playoff_appearances}/{entry.completed_seasons} playoffs
            </div>
          </div>

          {/* HARDWARE (1st, 2nd, Last) */}
          <div className="flex items-center justify-around sm:justify-center gap-5 px-5 py-3.5 sm:py-4 border-t sm:border-t-0 border-white/10">
            <HardwareStat icon={<TrophyIcon gold />} count={entry.firsts} label="1st" />
            <HardwareStat icon={<TrophyIcon />} count={entry.seconds} label="2nd" />
            <HardwareStat icon={<ToiletIcon />} count={entry.lasts} label="Last" />
          </div>

          {/* LEGACY SCORE */}
          <div className="flex flex-col items-center justify-center px-4 py-4 bg-[#faf9f5] dark:bg-stone-100 text-[#163024] border-t sm:border-t-0 sm:border-l border-stone-200">
            <div className="text-4xl sm:text-[42px] leading-none font-black tabular-nums tracking-tight text-[#163024]">
              {entry.legacy_score.toFixed(1)}
            </div>
            <div className="mt-1.5 text-[10px] font-bold uppercase tracking-widest text-[#9a7b1c]">
              Legacy Score
            </div>
          </div>
        </div>
      </summary>

      {/* Expandable 5-Pillar Breakdown & Season History */}
      <div className="p-5 bg-stone-50/70 dark:bg-stone-900/90 border-t border-stone-200 dark:border-stone-800 space-y-5">
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Legacy Score Breakdown ({entry.legacy_score.toFixed(1)} / 100)
            </h3>
            <span className={`text-xs font-medium ${accentColor}`}>
              All-Play: {entry.unrealized_wins}–{entry.unrealized_losses} (
              {fmt(entry.all_play_pct * 100, 1)}%)
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            <BreakdownPill
              label="Hardware"
              points={entry.breakdown.hardware_pts}
              detail={`${entry.firsts}× 1st · ${entry.seconds}× 2nd · ${entry.thirds}× 3rd`}
            />
            <BreakdownPill
              label="Win Rate"
              points={entry.breakdown.win_rate_pts}
              detail={`${entry.wins}–${entry.losses} (${fmt(entry.win_pct * 100, 1)}%)`}
            />
            <BreakdownPill
              label="Dominance"
              points={entry.breakdown.dominance_pts}
              detail={`${fmt(entry.all_play_pct * 100, 1)}% All-Play · ${fmt(entry.avg_ppg, 1)} PPG`}
            />
            <BreakdownPill
              label="Playoffs"
              points={entry.breakdown.playoff_pts}
              detail={`${entry.playoff_appearances}/${entry.completed_seasons} apps · ${entry.playoff_wins}W`}
            />
            <BreakdownPill
              label="Toilet Penalty"
              points={-entry.breakdown.toilet_penalty_pts}
              detail={`${entry.lasts}× Last place`}
              isPenalty
            />
          </div>
        </div>

        {/* Season-by-Season Finishes */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-2">
            Season-by-Season Ledger
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {entry.season_finishes.map((sf) => (
              <div
                key={sf.season}
                className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 px-3 py-2 text-xs"
              >
                <div className="flex items-center justify-between font-semibold mb-1">
                  <span className="text-stone-700 dark:text-stone-300">{sf.season}</span>
                  <FinishBadge finish={sf.finish} />
                </div>
                <div className="tabular-nums text-stone-600 dark:text-stone-400">
                  {sf.wins}–{sf.losses}
                  {sf.ties > 0 ? `–${sf.ties}` : ""} · #{sf.reg_rank} reg
                </div>
                <div className="tabular-nums text-[11px] text-stone-400">
                  {fmt(sf.avg_ppg, 1)} PPG
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

function HardwareStat({
  icon,
  count,
  label,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center min-w-[38px]">
      <div className="h-5 flex items-center justify-center text-[#d4af37]">{icon}</div>
      <div className="mt-1 text-xl font-extrabold tabular-nums leading-none text-white">
        {count}
      </div>
      <div className="mt-1 text-[11px] text-emerald-100/70 font-medium">{label}</div>
    </div>
  );
}

function BreakdownPill({
  label,
  points,
  detail,
  isPenalty = false,
}: {
  label: string;
  points: number;
  detail: string;
  isPenalty?: boolean;
}) {
  const sign = points > 0 ? "+" : "";
  const colorClass = isPenalty
    ? points < 0
      ? "text-red-600 dark:text-red-400"
      : "text-stone-400"
    : "text-emerald-700 dark:text-emerald-400";

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">
          {label}
        </span>
        <span className={`text-sm font-bold tabular-nums ${colorClass}`}>
          {sign}
          {points.toFixed(1)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-stone-500 truncate" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function FinishBadge({ finish }: { finish: HallOfFameEntry["season_finishes"][number]["finish"] }) {
  if (finish === "1st") {
    return (
      <span className="rounded bg-amber-100 dark:bg-amber-950/80 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-300">
        🏆 1st
      </span>
    );
  }
  if (finish === "2nd") {
    return (
      <span className="rounded bg-stone-200 dark:bg-stone-800 px-1.5 py-0.5 text-[10px] font-semibold text-stone-700 dark:text-stone-300">
        🥈 2nd
      </span>
    );
  }
  if (finish === "3rd") {
    return (
      <span className="rounded bg-orange-100 dark:bg-orange-950/70 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800 dark:text-orange-300">
        🥉 3rd
      </span>
    );
  }
  if (finish === "Last") {
    return (
      <span className="rounded bg-red-100 dark:bg-red-950/70 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">
        🚽 Last
      </span>
    );
  }
  if (finish === "Playoffs") {
    return (
      <span className="rounded bg-emerald-100 dark:bg-emerald-950/70 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:text-emerald-300">
        Playoffs
      </span>
    );
  }
  if (finish === "In Progress") {
    return (
      <span className="rounded bg-sky-100 dark:bg-sky-950/70 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
        Live
      </span>
    );
  }
  return <span className="text-[10px] text-stone-400">Missed PO</span>;
}

function TrophyIcon({ gold = false }: { gold?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`w-4 h-4 ${gold ? "text-[#d4af37]" : "text-[#d4af37]/80"}`}
      aria-hidden="true"
    >
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

function ToiletIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4 text-[#d4af37]/80"
      aria-hidden="true"
    >
      <path d="M7 12h13a1 1 0 0 1 1 1 7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7v-8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v7Z" />
      <path d="M9 20v2h8v-2" />
    </svg>
  );
}
