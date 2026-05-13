"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SyncTradesButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSync(full: boolean) {
    setState("loading");
    setMessage("");
    try {
      const res = await fetch("/api/options/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Unknown error");
      setMessage(
        `Synced ${json.synced_options} option${json.synced_options === 1 ? "" : "s"}, ` +
        `${json.synced_equity} equity trade${json.synced_equity === 1 ? "" : "s"}`,
      );
      setState("done");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
      setState("error");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => handleSync(false)}
        disabled={state === "loading"}
        className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition"
      >
        {state === "loading" ? "Syncing…" : "Sync new"}
      </button>

      <button
        onClick={() => handleSync(true)}
        disabled={state === "loading"}
        title="Re-fetch every order Tradier returns and upsert — slower but catches anything the incremental sync missed."
        className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition"
      >
        Sync all
      </button>

      {message && (
        <span className={`text-xs ${state === "error" ? "text-red-500" : "text-stone-500"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
