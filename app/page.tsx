import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import { fmt, ratingColorClass, slugify } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { data } = await getSupabase()
    .from("restaurants")
    .select("*")
    .order("overall", { ascending: false });
  const restaurants = (data ?? []) as Restaurant[];

  // Light stats for the hero — cheap to compute client-side from the existing rows.
  const total = restaurants.length;
  const cities = new Set(restaurants.map((r) => r.city)).size;
  const cuisines = new Set(restaurants.map((r) => r.cuisine)).size;
  const topThree = restaurants.slice(0, 3);

  return (
    <div className="flex flex-col items-center text-center pt-12 sm:pt-20">
      <h1 className="text-4xl sm:text-6xl font-bold tracking-tight max-w-3xl">
        A running log of every restaurant I've been to.
      </h1>
      <p className="mt-6 max-w-xl text-base sm:text-lg text-stone-600 dark:text-stone-400">
        Ratings, notes, and vegan-friendly takes on places across{" "}
        {cities > 0 ? cities : "a bunch of"} cities.
      </p>

      <div className="mt-10 flex flex-wrap gap-3 justify-center">
        <Link
          href="/restaurants"
          className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-base font-medium bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 transition"
        >
          Browse all restaurants
          <span aria-hidden>→</span>
        </Link>
      </div>

      {total > 0 ? (
        <>
          <dl className="mt-16 grid grid-cols-3 gap-6 sm:gap-12 text-left">
            <Stat label="Places" value={String(total)} />
            <Stat label="Cities" value={String(cities)} />
            <Stat label="Cuisines" value={String(cuisines)} />
          </dl>

          <section className="mt-20 w-full max-w-2xl text-left">
            <h2 className="text-sm uppercase tracking-wide text-stone-500 mb-4">
              Top rated
            </h2>
            <ul className="divide-y divide-stone-200 dark:divide-stone-800 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
              {topThree.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/restaurant/${r.id}`}
                    className="flex items-baseline justify-between gap-3 px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-900/50"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{r.name}</div>
                      <div className="text-xs text-stone-500 truncate">
                        {r.city} · {r.cuisine}
                      </div>
                    </div>
                    <div
                      className={`text-lg font-semibold tabular-nums ${ratingColorClass(r.overall)}`}
                    >
                      {fmt(r.overall, 2)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <p className="mt-16 text-sm text-stone-500">
          No restaurants yet — add one from the admin dashboard.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="text-3xl font-bold tabular-nums">{value}</dd>
      <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">
        {label}
      </dt>
    </div>
  );
}
