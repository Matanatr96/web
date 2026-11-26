"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteTennisMatch } from "@/app/tennis/actions";

export interface DeleteTennisSessionButtonProps {
  /** Session UUID to delete from the database. */
  matchId: string;
  /** Optional route to navigate to after deletion (e.g. `"/tennis"` from the detail page). */
  redirectTo?: string;
  /** Compact styling for list cards. */
  compact?: boolean;
}

/**
 * Admin-only two-step delete control for permanently removing a tennis session
 * from Postgres (and best-effort cleaning up its Modal clips).
 */
export default function DeleteTennisSessionButton({
  matchId,
  redirectTo,
  compact = false,
}: DeleteTennisSessionButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirmDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteTennisMatch(matchId);
      if (redirectTo) {
        router.push(redirectTo);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete session.");
      setIsDeleting(false);
    }
  }

  return (
    <div
      className="inline-flex flex-wrap items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      {confirming ? (
        <>
          <span className="text-xs text-rose-700 dark:text-rose-300 font-medium">
            Delete from database?
          </span>
          <button
            type="button"
            disabled={isDeleting}
            onClick={handleConfirmDelete}
            className={`rounded-md bg-rose-600 text-white font-medium hover:bg-rose-700 disabled:opacity-50 transition cursor-pointer ${
              compact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs"
            }`}
          >
            {isDeleting ? "Deleting..." : "Confirm Delete"}
          </button>
          <button
            type="button"
            disabled={isDeleting}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setConfirming(false);
              setError(null);
            }}
            className={`rounded-md border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-400 disabled:opacity-50 transition cursor-pointer ${
              compact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs"
            }`}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setConfirming(true);
            setError(null);
          }}
          className={`rounded-md border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 font-medium transition cursor-pointer ${
            compact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs"
          }`}
        >
          Delete Session
        </button>
      )}
      {error && (
        <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>
      )}
    </div>
  );
}
