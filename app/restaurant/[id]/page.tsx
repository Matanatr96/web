import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import { fmt, ratingColorClass, slugify } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function RestaurantDetail({ params }: Props) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) notFound();

  const { data, error } = await getSupabase()
    .from("restaurants")
    .select("*")
    .eq("id", numericId)
    .single();

  if (error || !data) notFound();
  const r = data as Restaurant;

  const rows: { label: string; value: number | null }[] = [
    { label: "Food", value: r.food },
    { label: "Value for Money", value: r.value },
    { label: "Service", value: r.service },
    { label: "Ambiance", value: r.ambiance },
    { label: "Vegan Options", value: r.vegan_options },
  ];

  return (
    <article>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/restaurants" className="hover:underline">
          ← All restaurants
        </Link>
      </nav>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{r.name}</h1>
        <p className="mt-1 text-stone-500 text-sm">
          <Link href={`/city/${slugify(r.city)}`} className="hover:underline">
            {r.city}
          </Link>
          {" · "}
          <Link href={`/cuisine/${slugify(r.cuisine)}`} className="hover:underline">
            {r.cuisine}
          </Link>
          {" · "}
          <span>{r.category}</span>
        </p>
      </header>

      <div className="rounded-md border border-stone-200 dark:border-stone-800 p-6 mb-6 bg-white dark:bg-stone-900">
        <div className="flex items-baseline gap-3">
          <span className="text-sm uppercase tracking-wide text-stone-500">
            Overall
          </span>
          <span
            className={`text-4xl font-bold tabular-nums ${ratingColorClass(r.overall)}`}
          >
            {fmt(r.overall, 2)}
          </span>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
          {rows.map(({ label, value }) => (
            <div
              key={label}
              className="flex items-baseline justify-between border-b border-stone-100 dark:border-stone-800 py-2"
            >
              <dt className="text-sm text-stone-500">{label}</dt>
              <dd
                className={`text-base font-medium tabular-nums ${ratingColorClass(value)}`}
              >
                {fmt(value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {r.photos && r.photos.length > 0 && (
        <div className="mb-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {r.photos.map((url) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={r.name}
                  className="w-full aspect-square object-cover rounded-md border border-stone-200 dark:border-stone-800 hover:opacity-90 transition-opacity"
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {r.note ? (
        <div className="rounded-md border border-stone-200 dark:border-stone-800 p-6 bg-white dark:bg-stone-900">
          <h2 className="text-sm uppercase tracking-wide text-stone-500 mb-2">
            Note
          </h2>
          <p className="text-base leading-relaxed whitespace-pre-wrap">
            {r.note}
          </p>
        </div>
      ) : (
        <p className="text-sm text-stone-500 italic">No note for this one.</p>
      )}
    </article>
  );
}
