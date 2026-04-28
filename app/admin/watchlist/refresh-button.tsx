"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { revalidateWatchlist } from "./actions";

type Props = {
  marketOpen: boolean;
  hasItems: boolean;
};

export default function RefreshButton({ marketOpen, hasItems }: Props) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const disabled = !marketOpen || !hasItems || pending;

  const title = !hasItems
    ? "No tickers to refresh"
    : !marketOpen
    ? "Market is closed — prices won't change until next session"
    : pending
    ? "Refreshing…"
    : "Fetch latest prices and options data";

  function handleClick() {
    startTransition(async () => {
      await revalidateWatchlist();
      router.refresh();
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      title={title}
      className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
    >
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
