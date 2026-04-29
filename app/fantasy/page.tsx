import Link from "next/link";

export default function FantasyPage() {
  return (
    <div className="max-w-5xl mx-auto pt-10">
      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Fantasy Football</h1>
        <p className="mt-1 text-sm text-stone-500">
          KFL — standings, records, and trades from Sleeper.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
        <Link
          href="/fantasy/matchups"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Matchups</span>
          <span className="text-sm text-stone-500">Standings, weekly averages, and playoffs</span>
        </Link>

        <Link
          href="/fantasy/trades"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Trades</span>
          <span className="text-sm text-stone-500">All completed trades and trade leaderboard</span>
        </Link>

        <Link
          href="/fantasy/records"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Records</span>
          <span className="text-sm text-stone-500">Top scoring, lowest scoring, biggest blowouts</span>
        </Link>
      </div>
    </div>
  );
}
