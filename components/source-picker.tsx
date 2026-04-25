"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { TradeSource } from "@/lib/types";

export default function SourcePicker({ current }: { current: TradeSource }) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function select(source: TradeSource) {
    const next = new URLSearchParams(params.toString());
    next.set("source", source);
    startTransition(() => router.replace(`/options?${next.toString()}`));
  }

  return (
    <div className="flex rounded-lg border border-stone-200 dark:border-stone-800 overflow-hidden text-sm">
      {(["prod", "sandbox"] as const).map((s) => (
        <button
          key={s}
          onClick={() => select(s)}
          className={`px-4 py-1.5 capitalize transition ${
            current === s
              ? "bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 font-medium"
              : "text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-50 dark:hover:bg-stone-900"
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
