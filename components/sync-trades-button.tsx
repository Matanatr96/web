"use client";

import { useState } from "react";

export default function SyncTradesButton() {
  const [source, setSource] = useState<"prod" | "sandbox">("sandbox");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSync() {
    setState("loading");
    setMessage("");
    try {
      const res = await fetch("/api/options/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandbox: source === "sandbox" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Unknown error");
      setMessage(
        `Synced ${json.synced_options} option${json.synced_options === 1 ? "" : "s"}, ` +
        `${json.synced_equity} equity trade${json.synced_equity === 1 ? "" : "s"}`,
      );
      setState("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
      setState("error");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {/* Prod / Sandbox pill toggle */}
      <div className="flex rounded-md border border-stone-300 dark:border-stone-700 overflow-hidden text-sm">
        {(["prod", "sandbox"] as const).map((s) => (
          <button
            key={s}
            onClick={() => { setSource(s); setState("idle"); setMessage(""); }}
            className={`px-3 py-2 capitalize transition ${
              source === s
                ? "bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900"
                : "hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-400"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <button
        onClick={handleSync}
        disabled={state === "loading"}
        className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition"
      >
        {state === "loading" ? "Syncing…" : "Sync trades"}
      </button>

      {message && (
        <span className={`text-xs ${state === "error" ? "text-red-500" : "text-stone-500"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
