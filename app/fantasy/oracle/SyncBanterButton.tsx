"use client";

import { useState } from "react";

type Props = {
  onSynced: (imported: number) => void;
};

export default function SyncBanterButton({ onSynced }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/signal/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      onSynced(data.imported as number);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={sync}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-medium border border-stone-300 dark:border-stone-700 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 transition"
      >
        {loading ? "Syncing…" : "Sync Signal messages"}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
