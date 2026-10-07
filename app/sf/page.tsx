import type { Metadata } from "next";
import { SfEventsBoard } from "@/components/sf-events-board";
import { loadSfEventsAndFeedback } from "@/lib/sf-events";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "What's Going On in SF · Anush Mattapalli",
  description:
    "Live San Francisco food, nightlife, outdoors, music, and comedy radar with personalized tag-affinity ranking.",
};

/**
 * Public "What's Going On in SF" page (`/sf`).
 * Loads upcoming SF events and saved taste feedback (from Supabase or live zero-key feeds)
 * and renders the interactive recommendation board.
 */
export default async function SfEventsPage() {
  const { events, feedbackMap } = await loadSfEventsAndFeedback();

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
          What&apos;s Going On in SF
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Live San Francisco food, nightlife, and outdoor events ranked by your taste signals.
        </p>
      </div>

      <SfEventsBoard
        initialEvents={events}
        initialFeedbackMap={feedbackMap}
      />
    </div>
  );
}
