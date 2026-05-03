import Link from "next/link";

export default function RestaurantsPage() {
  return (
    <div className="max-w-5xl mx-auto pt-10">
      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Restaurants</h1>
        <p className="mt-1 text-sm text-stone-500">
          Restaurants, maps, and recommendations.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
        <Link
          href="/restaurants/table"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Table</span>
          <span className="text-sm text-stone-500">All rated restaurants sorted by score</span>
        </Link>

        <Link
          href="/map"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Map</span>
          <span className="text-sm text-stone-500">Browse restaurants on an interactive map</span>
        </Link>

        <Link
          href="/restaurants/suggestions"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Suggestions</span>
          <span className="text-sm text-stone-500">Answer a few questions, get a pick</span>
        </Link>
      </div>
    </div>
  );
}
