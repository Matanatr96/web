import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { RESTAURANT_SELECT, mapRestaurantRow } from "@/lib/restaurants-query";
import { fmt, ratingColorClass, slugify } from "@/lib/utils";
import { computeSelfAverage, type ReceiptRow } from "@/lib/restaurant-receipts";
import type { RestaurantVisit } from "@/lib/types";
import { isAdmin } from "@/lib/auth";
import LogVisitButton from "@/components/log-visit-modal";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function RestaurantDetail({ params }: Props) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) notFound();

  const supabase = getSupabase();
  const [{ data, error }, { data: receiptData }, { data: visitData }, admin] = await Promise.all([
    supabase
      .from("restaurants")
      .select(RESTAURANT_SELECT)
      .eq("id", numericId)
      .single(),
    supabase
      .from("receipts")
      .select(
        "id, visited_on, subtotal, tax, tip, total, created_at, items:receipt_items(id, name, price, qty, assignments:receipt_item_diners(diner_id, share, diner:diners(name)))",
      )
      .eq("restaurant_id", numericId)
      .order("visited_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("restaurant_visits")
      .select("id, restaurant_id, visited_on, comment, food, value, service, ambiance, vegan_options, overall, created_at")
      .eq("restaurant_id", numericId)
      .order("visited_on", { ascending: false })
      .order("created_at", { ascending: false }),
    isAdmin(),
  ]);

  if (error || !data) notFound();
  const r = mapRestaurantRow(data);
  const receipts = (receiptData ?? []) as ReceiptRow[];
  const visits = (visitData ?? []) as RestaurantVisit[];
  const anushSpend = computeSelfAverage(receipts, "Anush");

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
          {r.cuisines.length > 0 ? (
            <>
              {r.cuisines.map((c, i) => (
                <Fragment key={c}>
                  {i > 0 && ", "}
                  <Link href={`/cuisine/${slugify(c)}`} className="hover:underline">
                    {c}
                  </Link>
                </Fragment>
              ))}
              {" · "}
            </>
          ) : null}
          <span>{r.category}</span>
        </p>
      </header>

      <div className="rounded-md border border-stone-200 dark:border-stone-800 p-6 mb-6 bg-white dark:bg-stone-900">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span className="text-sm uppercase tracking-wide text-stone-500">
              Overall
            </span>
            <span
              className={`text-4xl font-bold tabular-nums ${ratingColorClass(r.overall)}`}
            >
              {fmt(r.overall, 2)}
            </span>
            <span className="text-sm text-stone-400">
              · {r.visit_count ?? 0} visit{(r.visit_count ?? 0) === 1 ? "" : "s"}
            </span>
          </div>
          {admin && (
            <LogVisitButton
              restaurantId={r.id}
              restaurantName={r.name}
              currentRatings={{
                food: r.food,
                value: r.value,
                service: r.service,
                ambiance: r.ambiance,
                vegan_options: r.vegan_options,
              }}
            />
          )}
        </div>
        {anushSpend && (
          <div className="mt-3 text-sm text-stone-500">
            Avg spend per visit:{" "}
            <span className="font-medium text-stone-700 dark:text-stone-300 tabular-nums">
              ${anushSpend.avg.toFixed(2)}
            </span>{" "}
            <span className="text-stone-400">
              · {anushSpend.count} receipt{anushSpend.count === 1 ? "" : "s"}
            </span>
          </div>
        )}
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

      {visits.length > 0 && (
        <div className="rounded-md border border-stone-200 dark:border-stone-800 p-6 bg-white dark:bg-stone-900 mb-6">
          <h2 className="text-sm uppercase tracking-wide text-stone-500 mb-3">
            Visit Log
          </h2>
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {visits.map((v) => (
              <li key={v.id} className="py-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium tabular-nums">
                    {new Date(v.visited_on + "T00:00:00").toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                  {v.overall !== null && (
                    <span className={`tabular-nums font-medium ${ratingColorClass(v.overall)}`}>
                      {fmt(v.overall, 2)}
                    </span>
                  )}
                </div>
                {v.comment && (
                  <p className="text-sm text-stone-600 dark:text-stone-400 mt-1 whitespace-pre-wrap">
                    {v.comment}
                  </p>
                )}
                {(v.food !== null || v.value !== null || v.service !== null || v.ambiance !== null || v.vegan_options !== null) && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-stone-500 tabular-nums">
                    {v.food !== null && <span>Food <span className={ratingColorClass(v.food)}>{fmt(v.food)}</span></span>}
                    {v.value !== null && <span>Value <span className={ratingColorClass(v.value)}>{fmt(v.value)}</span></span>}
                    {v.service !== null && <span>Service <span className={ratingColorClass(v.service)}>{fmt(v.service)}</span></span>}
                    {v.ambiance !== null && <span>Ambiance <span className={ratingColorClass(v.ambiance)}>{fmt(v.ambiance)}</span></span>}
                    {v.vegan_options !== null && <span>Vegan <span className={ratingColorClass(v.vegan_options)}>{fmt(v.vegan_options)}</span></span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {receipts.length > 0 && (
        <div className="rounded-md border border-stone-200 dark:border-stone-800 p-6 bg-white dark:bg-stone-900 mb-6">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm uppercase tracking-wide text-stone-500">Receipts</h2>
            <Link
              href="/restaurants/receipt"
              className="text-xs text-stone-500 hover:underline"
            >
              + new receipt
            </Link>
          </div>
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {receipts.map((rc) => {
              const date = rc.visited_on ?? rc.created_at.slice(0, 10);
              const diners = uniqueDinerNames(rc);
              return (
                <li key={rc.id} className="py-2 flex items-baseline justify-between text-sm">
                  <div>
                    <span className="font-medium tabular-nums">{date}</span>
                    {diners.length > 0 && (
                      <span className="text-stone-500"> · {diners.join(", ")}</span>
                    )}
                  </div>
                  <span className="tabular-nums text-stone-700 dark:text-stone-300">
                    ${Number(rc.total).toFixed(2)}
                  </span>
                </li>
              );
            })}
          </ul>
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

function uniqueDinerNames(rc: ReceiptRow): string[] {
  const set = new Set<string>();
  for (const it of rc.items) {
    for (const a of it.assignments) {
      if (a.diner?.name) set.add(a.diner.name);
    }
  }
  return Array.from(set);
}
