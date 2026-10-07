"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildGoogleCalendarUrl,
  formatTagLabel,
  rankSfEvents,
  SF_CATEGORY_META,
  type SfEvent,
  type SfEventCategory,
  type SfEventFeedback,
  type SfVoteSignal,
} from "@/lib/sf-events";

const LOCAL_STORAGE_KEY = "sf-events-feedback-v1";

type FeedViewMode = "for-you" | "chronological" | "saved" | "dismissed";
type TimeWindowFilter = "all" | "today" | "weekend";

const TIER_1_CATEGORIES: SfEventCategory[] = ["food", "nightlife", "outdoors"];
const TIER_2_CATEGORIES: SfEventCategory[] = ["music", "comedy", "arts", "sports"];

interface SfEventsBoardProps {
  initialEvents: SfEvent[];
  initialFeedbackMap: Record<string, SfEventFeedback>;
}

function formatEventDateBadge(startsAtIso: string, endsAtIso: string | null): string {
  const start = new Date(startsAtIso);
  if (Number.isNaN(start.getTime())) return "";
  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);

  const timePart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(start);

  if (!endsAtIso) return `${datePart} · ${timePart}`;
  const end = new Date(endsAtIso);
  if (Number.isNaN(end.getTime())) return `${datePart} · ${timePart}`;

  const endTimePart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(end);

  return `${datePart} · ${timePart} – ${endTimePart}`;
}

function isSamePacificDay(isoA: string, isoB: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(isoA)) === fmt.format(new Date(isoB));
}

function isUpcomingWeekendInPacific(startsAtIso: string, now: Date): boolean {
  const dt = new Date(startsAtIso);
  const diffDays = (dt.getTime() - now.getTime()) / (24 * 3600 * 1000);
  if (diffDays < -0.5 || diffDays > 6.5) return false;
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(dt);
  return weekday === "Fri" || weekday === "Sat" || weekday === "Sun";
}

/**
 * Interactive SF Events discovery and personalized recommendation board.
 * Supports thumbs-up (`up`), busy/bad-timing (`busy`), and thumbs-down (`down`) signals
 * with instant client-side re-ranking, `localStorage` durability, and Supabase persistence.
 *
 * @param props - Initial server-loaded events and feedback map.
 * @returns Rendered interactive SF events board.
 */
export function SfEventsBoard({
  initialEvents,
  initialFeedbackMap,
}: SfEventsBoardProps) {
  const router = useRouter();
  const [feedbackMap, setFeedbackMap] =
    useState<Record<string, SfEventFeedback>>(initialFeedbackMap);
  const [viewMode, setViewMode] = useState<FeedViewMode>("for-you");
  const [timeFilter, setTimeFilter] = useState<TimeWindowFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<SfEventCategory | "all">("all");
  const [neighborhoodFilter, setNeighborhoodFilter] = useState<string>("all");
  const [freeOnly, setFreeOnly] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Merge server feedback with localStorage feedback on mount so votes persist even pre-migration
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return;
      const localParsed = JSON.parse(raw) as Record<string, SfEventFeedback>;
      if (localParsed && typeof localParsed === "object") {
        setFeedbackMap((prev) => ({ ...localParsed, ...prev }));
      }
    } catch {
      // Ignore storage parse errors
    }
  }, []);

  const persistLocalFeedback = (nextMap: Record<string, SfEventFeedback>) => {
    try {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextMap));
    } catch {
      // Ignore quota errors
    }
  };

  const handleVote = async (event: SfEvent, clickedSignal: SfVoteSignal) => {
    const existing = feedbackMap[event.id]?.signal ?? null;
    const nextSignal: SfVoteSignal | null =
      existing === clickedSignal ? null : clickedSignal;

    const nextMap = { ...feedbackMap };
    if (nextSignal === null) {
      delete nextMap[event.id];
    } else {
      nextMap[event.id] = {
        eventId: event.id,
        signal: nextSignal,
        tagsSnapshot: event.tags,
        eventTitle: event.title,
        updatedAt: new Date().toISOString(),
      };
    }

    setFeedbackMap(nextMap);
    persistLocalFeedback(nextMap);

    try {
      await fetch("/api/sf/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          signal: nextSignal,
          tagsSnapshot: event.tags,
          eventTitle: event.title,
        }),
      });
    } catch {
      // Optimistic localStorage state is already saved
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/sf/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setSyncMessage(`Sync failed: ${data.error ?? res.statusText}`);
      } else {
        setSyncMessage(`Synced ${data.deduped ?? 0} upcoming SF events`);
        router.refresh();
      }
    } catch (e) {
      setSyncMessage(`Sync error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const neighborhoods = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of initialEvents) {
      if (ev.neighborhood) {
        counts.set(ev.neighborhood, (counts.get(ev.neighborhood) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([hood, count]) => ({ hood, count }));
  }, [initialEvents]);

  const { ranked, profile } = useMemo(
    () => rankSfEvents(initialEvents, feedbackMap),
    [initialEvents, feedbackMap],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    for (const item of ranked) {
      if (
        viewMode === "for-you" &&
        (item.userSignal === "down" || item.userSignal === "busy")
      ) {
        continue;
      }
      counts.all = (counts.all ?? 0) + 1;
      counts[item.event.category] = (counts[item.event.category] ?? 0) + 1;
    }
    return counts;
  }, [ranked, viewMode]);

  const filteredItems = useMemo(() => {
    const now = new Date();
    const nowIso = now.toISOString();
    const q = searchQuery.trim().toLowerCase();

    const list = ranked.filter((item) => {
      const { event, userSignal } = item;

      if (viewMode === "saved") {
        if (userSignal !== "up") return false;
      } else if (viewMode === "dismissed") {
        if (userSignal !== "busy" && userSignal !== "down") return false;
      } else {
        // Default "for-you" and "chronological" views hide passed/busy events
        if (userSignal === "busy" || userSignal === "down") return false;
      }

      if (categoryFilter !== "all" && event.category !== categoryFilter) {
        return false;
      }

      if (neighborhoodFilter !== "all" && event.neighborhood !== neighborhoodFilter) {
        return false;
      }

      if (freeOnly && !event.isFree) {
        return false;
      }

      if (timeFilter === "today" && !isSamePacificDay(event.startsAt, nowIso)) {
        return false;
      }
      if (timeFilter === "weekend" && !isUpcomingWeekendInPacific(event.startsAt, now)) {
        return false;
      }

      if (q) {
        const haystack =
          `${event.title} ${event.description ?? ""} ${event.venue ?? ""} ${event.neighborhood ?? ""} ${event.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });

    if (viewMode === "chronological") {
      return [...list].sort(
        (a, b) =>
          new Date(a.event.startsAt).getTime() - new Date(b.event.startsAt).getTime(),
      );
    }

    return list;
  }, [
    ranked,
    viewMode,
    categoryFilter,
    neighborhoodFilter,
    freeOnly,
    timeFilter,
    searchQuery,
  ]);

  const totalVotes = profile.upCount + profile.busyCount + profile.downCount;

  return (
    <div className="space-y-6">
      {/* Taste Profile & Controls Card */}
      <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50/70 dark:bg-stone-900/50 p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                Taste Engine v1
              </span>
              <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-950/70 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                Food · Nightlife · Outdoors prioritized
              </span>
            </div>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Tap <strong className="text-stone-700 dark:text-stone-200">👍 Interested</strong> to boost similar vibes,{" "}
              <strong className="text-stone-700 dark:text-stone-200">🗓️ Busy</strong> if you can&apos;t make that time (hides the event without penalizing its tags), or{" "}
              <strong className="text-stone-700 dark:text-stone-200">👎 Pass</strong> to down-rank similar events.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {syncMessage && (
              <span className="text-xs text-stone-500">{syncMessage}</span>
            )}
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-1.5 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition"
            >
              {syncing ? "Syncing…" : "↻ Sync Feeds"}
            </button>
          </div>
        </div>

        {/* Learned Taste Pills */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-stone-200/70 dark:border-stone-800/70 text-xs">
          <span className="text-stone-500">
            Signals:{" "}
            <strong className="text-stone-800 dark:text-stone-200">
              {profile.upCount} 👍
            </strong>{" "}
            ·{" "}
            <strong className="text-stone-800 dark:text-stone-200">
              {profile.busyCount} 🗓️
            </strong>{" "}
            ·{" "}
            <strong className="text-stone-800 dark:text-stone-200">
              {profile.downCount} 👎
            </strong>
          </span>

          {totalVotes === 0 ? (
            <span className="text-stone-400">
              Vote on a few events below to personalize your tag weights.
            </span>
          ) : (
            <>
              {profile.topLikedTags.map((t) => (
                <span
                  key={t.tag}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-100/80 dark:bg-emerald-950/60 px-2.5 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-300"
                >
                  ↑ {t.label}
                </span>
              ))}
              {profile.topAvoidedTags.map((t) => (
                <span
                  key={t.tag}
                  className="inline-flex items-center gap-1 rounded-full bg-rose-100/80 dark:bg-rose-950/60 px-2.5 py-0.5 text-[11px] font-medium text-rose-800 dark:text-rose-300"
                >
                  ↓ {t.label}
                </span>
              ))}
            </>
          )}
        </div>
      </div>

      {/* View Mode Tabs + Time Window Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="inline-flex flex-wrap rounded-lg border border-stone-200 dark:border-stone-800 p-1 bg-stone-50 dark:bg-stone-900/60">
          {(
            [
              { id: "for-you", label: "✨ For You" },
              { id: "chronological", label: "📅 Soonest" },
              { id: "saved", label: `👍 Interested (${profile.upCount})` },
              {
                id: "dismissed",
                label: `🗓️ Busy / Passed (${profile.busyCount + profile.downCount})`,
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setViewMode(tab.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                viewMode === tab.id
                  ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 shadow-xs"
                  : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { id: "all", label: "All Dates" },
              { id: "today", label: "Today" },
              { id: "weekend", label: "This Weekend" },
            ] as const
          ).map((tf) => (
            <button
              key={tf.id}
              type="button"
              onClick={() => setTimeFilter(tf.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition ${
                timeFilter === tf.id
                  ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                  : "border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:border-stone-400"
              }`}
            >
              {tf.label}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setFreeOnly((v) => !v)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition ${
              freeOnly
                ? "border-emerald-700 bg-emerald-700 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-stone-950"
                : "border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:border-stone-400"
            }`}
          >
            Free Only
          </button>
        </div>
      </div>

      {/* Category Filter Pills (Tier 1 Top-3 first, then Tier 2) + Neighborhood + Search */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setCategoryFilter("all")}
            className={`rounded-full px-3 py-1.5 text-xs font-medium border transition ${
              categoryFilter === "all"
                ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                : "border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:border-stone-400"
            }`}
          >
            All ({categoryCounts.all ?? 0})
          </button>

          {TIER_1_CATEGORIES.map((cat) => {
            const meta = SF_CATEGORY_META[cat];
            const count = categoryCounts[cat] ?? 0;
            const active = categoryFilter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(active ? "all" : cat)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold border transition ${
                  active
                    ? "border-amber-600 bg-amber-600 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-stone-950"
                    : "border-amber-300/80 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 text-stone-800 dark:text-stone-200 hover:border-amber-500"
                }`}
              >
                {meta.emoji} {meta.label} ({count})
              </button>
            );
          })}

          {TIER_2_CATEGORIES.map((cat) => {
            const meta = SF_CATEGORY_META[cat];
            const count = categoryCounts[cat] ?? 0;
            const active = categoryFilter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(active ? "all" : cat)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium border transition ${
                  active
                    ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                    : "border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:border-stone-400"
                }`}
              >
                {meta.emoji} {meta.label} ({count})
              </button>
            );
          })}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search SF events, venues, DJs, tacos, parks…"
            className="flex-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-3 py-2 text-sm placeholder:text-stone-400 focus:outline-none focus:border-stone-400"
          />
          <select
            value={neighborhoodFilter}
            onChange={(e) => setNeighborhoodFilter(e.target.value)}
            aria-label="Filter by SF neighborhood"
            className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-3 py-2 text-sm text-stone-700 dark:text-stone-200"
          >
            <option value="all">All SF Neighborhoods</option>
            {neighborhoods.map(({ hood, count }) => (
              <option key={hood} value={hood}>
                {hood} ({count})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Results count */}
      <div className="flex items-center justify-between text-xs text-stone-500">
        <span>
          Showing <strong className="text-stone-800 dark:text-stone-200">{filteredItems.length}</strong>{" "}
          {filteredItems.length === 1 ? "event" : "events"}
        </span>
        {(categoryFilter !== "all" ||
          neighborhoodFilter !== "all" ||
          freeOnly ||
          timeFilter !== "all" ||
          searchQuery.trim() !== "") && (
          <button
            type="button"
            onClick={() => {
              setCategoryFilter("all");
              setNeighborhoodFilter("all");
              setFreeOnly(false);
              setTimeFilter("all");
              setSearchQuery("");
            }}
            className="underline hover:text-stone-800 dark:hover:text-stone-200"
          >
            Reset filters
          </button>
        )}
      </div>

      {/* Event Cards Grid */}
      {filteredItems.length === 0 ? (
        <div className="rounded-xl border border-stone-200 dark:border-stone-800 p-8 text-center text-sm text-stone-500">
          No SF events match the current filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredItems.map(({ event, score, reasons, userSignal, isWildcard }) => {
            const catMeta = SF_CATEGORY_META[event.category];
            const dateLabel = formatEventDateBadge(event.startsAt, event.endsAt);
            const displayTags = event.tags
              .filter((t) => t.startsWith("vibe:") || t.startsWith("genre:"))
              .slice(0, 4);

            return (
              <article
                key={event.id}
                className={`flex flex-col justify-between rounded-xl border p-4 sm:p-5 transition ${
                  userSignal === "up"
                    ? "border-emerald-500/70 bg-emerald-50/20 dark:bg-emerald-950/15"
                    : "border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700"
                }`}
              >
                <div className="space-y-2.5">
                  {/* Top metadata row */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          event.tier === 1
                            ? "bg-amber-100/90 text-amber-900 dark:bg-amber-950/80 dark:text-amber-200"
                            : "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300"
                        }`}
                      >
                        {catMeta.emoji} {catMeta.label}
                      </span>

                      {event.neighborhood && (
                        <button
                          type="button"
                          onClick={() =>
                            setNeighborhoodFilter((prev) =>
                              prev === event.neighborhood ? "all" : event.neighborhood!,
                            )
                          }
                          className="inline-flex items-center rounded-full bg-stone-100 dark:bg-stone-800 px-2.5 py-0.5 text-xs text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-700 transition"
                        >
                          📍 {event.neighborhood}
                        </button>
                      )}

                      {event.isFree ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-950/80 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
                          FREE
                        </span>
                      ) : event.priceText ? (
                        <span className="inline-flex items-center rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-[11px] text-stone-600 dark:text-stone-400">
                          {event.priceText.slice(0, 28)}
                        </span>
                      ) : null}

                      {isWildcard && (
                        <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-950/80 px-2 py-0.5 text-[11px] font-medium text-purple-800 dark:text-purple-300">
                          ✨ Wildcard
                        </span>
                      )}
                    </div>

                    <span
                      title={reasons.join(" · ")}
                      className="text-[11px] font-mono text-stone-400"
                    >
                      {score.toFixed(1)} pts
                    </span>
                  </div>

                  {/* Title & Date/Venue */}
                  <div>
                    <a
                      href={event.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-base font-semibold leading-snug hover:underline"
                    >
                      {event.title}
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-stone-500 dark:text-stone-400">
                      <span className="font-medium text-stone-700 dark:text-stone-300">
                        {dateLabel}
                      </span>
                      {event.venue && <span>· {event.venue}</span>}
                      <span className="text-stone-400">· via {event.source}</span>
                    </div>
                  </div>

                  {/* Description */}
                  {event.description && (
                    <p className="text-xs text-stone-600 dark:text-stone-400 line-clamp-3 leading-relaxed">
                      {event.description}
                    </p>
                  )}

                  {/* Vibe tags & Ranker explanation chips */}
                  {(displayTags.length > 0 || reasons.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {reasons
                        .filter((r) => r.startsWith("Matches liked:"))
                        .map((r) => (
                          <span
                            key={r}
                            className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300"
                          >
                            {r}
                          </span>
                        ))}
                      {displayTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setSearchQuery(formatTagLabel(tag))}
                          className="inline-flex items-center rounded-md bg-stone-100 dark:bg-stone-800/80 px-2 py-0.5 text-[11px] text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700 transition"
                        >
                          #{formatTagLabel(tag)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Bottom Action Bar: 👍 Interested / 🗓️ Busy / 👎 Pass + 📅 Add to GCal */}
                <div className="mt-4 pt-3 border-t border-stone-100 dark:border-stone-800/80 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleVote(event, "up")}
                      title="Interested — boosts events with similar tags & saves to Interested"
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition ${
                        userSignal === "up"
                          ? "border-emerald-600 bg-emerald-600 text-white"
                          : "border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:border-emerald-400"
                      }`}
                    >
                      👍 <span>Interested</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleVote(event, "busy")}
                      title="Good vibe, bad timing — hides this event without down-ranking similar events"
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition ${
                        userSignal === "busy"
                          ? "border-amber-600 bg-amber-600 text-white"
                          : "border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 hover:border-amber-400"
                      }`}
                    >
                      🗓️ <span>Busy</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleVote(event, "down")}
                      title="Not for me — down-ranks events with these tags & hides this event"
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition ${
                        userSignal === "down"
                          ? "border-rose-600 bg-rose-600 text-white"
                          : "border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:border-rose-400"
                      }`}
                    >
                      👎 <span>Pass</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <a
                      href={buildGoogleCalendarUrl(event)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => {
                        if (userSignal !== "up") {
                          void handleVote(event, "up");
                        }
                      }}
                      title="Add to Anush's Google Calendar (matanatr96@gmail.com) and mark Interested"
                      className="inline-flex items-center gap-1 rounded-lg border border-stone-200 dark:border-stone-800 px-2.5 py-1.5 text-xs font-medium text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 hover:border-stone-400 transition"
                    >
                      📅 <span>+ GCal</span>
                    </a>

                    <a
                      href={event.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition"
                    >
                      Details →
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
