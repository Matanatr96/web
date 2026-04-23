import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import { fmt, ratingColorClass } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { data } = await getSupabase()
    .from("restaurants")
    .select("*")
    .order("overall", { ascending: false });
  const restaurants = (data ?? []) as Restaurant[];

  const total = restaurants.length;
  const cities = new Set(restaurants.map((r) => r.city)).size;
  const cuisines = new Set(restaurants.map((r) => r.cuisine)).size;
  const topThree = restaurants.slice(0, 3);

  return (
    <div className="flex flex-col gap-16 pt-10 sm:pt-16 max-w-2xl mx-auto">
      {/* Hero */}
      <section>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          Anush Mattapalli
        </h1>
        <p className="mt-3 text-base sm:text-lg text-stone-500 dark:text-stone-400">
          Software engineer · food enthusiast · photographer
        </p>
        <p className="mt-5 text-stone-600 dark:text-stone-400 leading-relaxed max-w-lg">
          Based in NYC. I build software, eat at too many restaurants, and
          photograph the world in between.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <SocialLink
            href="https://www.linkedin.com/in/anush96/"
            label="LinkedIn"
            icon={<LinkedInIcon />}
          />
          <SocialLink
            href="https://www.instagram.com/matanatr96/"
            label="@matanatr96"
            icon={<InstagramIcon />}
          />
          <SocialLink
            href="https://www.instagram.com/amphototography/"
            label="@amphototography"
            icon={<InstagramIcon />}
          />
        </div>
      </section>

      <div className="border-t border-stone-200 dark:border-stone-800" />

      {/* Restaurant journal */}
      <section>
        <div className="flex items-baseline justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold">Restaurant Journal</h2>
            <p className="mt-1 text-sm text-stone-500">
              Every place I&apos;ve eaten, rated.
            </p>
          </div>
          <Link
            href="/restaurants"
            className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition"
          >
            View all →
          </Link>
        </div>

        {total > 0 ? (
          <>
            <dl className="grid grid-cols-3 gap-3 mb-8">
              <Stat label="Places" value={String(total)} />
              <Stat label="Cities" value={String(cities)} />
              <Stat label="Cuisines" value={String(cuisines)} />
            </dl>

            <p className="text-xs uppercase tracking-wide text-stone-500 mb-3">
              Top rated
            </p>
            <ul className="divide-y divide-stone-200 dark:divide-stone-800 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
              {topThree.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/restaurant/${r.id}`}
                    className="flex items-baseline justify-between gap-3 px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-800/50 transition"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{r.name}</div>
                      <div className="text-xs text-stone-500 truncate">
                        {r.city} · {r.cuisine}
                      </div>
                    </div>
                    <div
                      className={`text-lg font-semibold tabular-nums shrink-0 ${ratingColorClass(r.overall)}`}
                    >
                      {fmt(r.overall, 2)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-stone-500">No restaurants yet.</p>
        )}
      </section>
    </div>
  );
}

function SocialLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-stone-200 dark:border-stone-800 text-sm text-stone-700 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-500 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
    >
      {icon}
      {label}
    </a>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-3">
      <dd className="text-2xl font-bold tabular-nums">{value}</dd>
      <dt className="text-xs uppercase tracking-wide text-stone-500 mt-1">
        {label}
      </dt>
    </div>
  );
}

function InstagramIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}
