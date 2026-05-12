"use client";

import { useState } from "react";
import type { WeeklySummary } from "@/lib/types";

type Props = {
  season: number;
  week: number;
  postedAt: string | null;
  onPosted: (summary: WeeklySummary) => void;
};

export default function PostToSignalButton({ season, week, postedAt, onPosted }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(force = false) {
    if (!force && postedAt) {
      const confirmed = window.confirm(
        `Already posted on ${new Date(postedAt).toLocaleDateString()}. Post again?`
      );
      if (!confirmed) return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fantasy/post-to-signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season, week, force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      onPosted(data.summary as WeeklySummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => post(false)}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-medium border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 rounded-lg hover:bg-violet-50 dark:hover:bg-violet-950 disabled:opacity-40 transition"
      >
        {loading
          ? "Posting…"
          : postedAt
          ? `Posted ${new Date(postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · Post again`
          : "Post to Signal"}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
