"use client";

import { useState } from "react";

export default function RefreshMatchupsButton() {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleRefresh() {
    setState("loading");
    setMessage("");
    try {
      const res = await fetch("/api/fantasy/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Unknown error");
      setMessage(`Week ${json.week}: ${json.synced} row${json.synced === 1 ? "" : "s"} synced`);
      setState("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
      setState("error");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleRefresh}
        disabled={state === "loading"}
        className="px-3 py-1.5 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition"
      >
        {state === "loading" ? "Refreshing…" : "Refresh Matchups"}
      </button>
      {message && (
        <span className={`text-xs ${state === "error" ? "text-red-500" : "text-stone-500"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
