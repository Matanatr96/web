"use client";

import { useState } from "react";
import type { WeeklySummary } from "@/lib/types";

type Props = {
  season: number;
  week: number;
  hasSummary: boolean;
  onGenerated: (summary: WeeklySummary) => void;
};

export default function GenerateSummaryButton({ season, week, hasSummary, onGenerated }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(regenerate = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fantasy/generate-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season, week, regenerate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      onGenerated(data.summary as WeeklySummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {!hasSummary && (
          <button
            onClick={() => generate(false)}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 rounded-lg hover:opacity-80 disabled:opacity-40 transition"
          >
            {loading ? "Generating…" : "Generate Weekly Summary"}
          </button>
        )}
        {hasSummary && (
          <button
            onClick={() => generate(true)}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium border border-stone-300 dark:border-stone-700 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 transition"
          >
            {loading ? "Regenerating…" : "Regenerate"}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
