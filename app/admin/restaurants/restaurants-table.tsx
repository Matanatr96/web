"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Restaurant } from "@/lib/types";
import { fmt } from "@/lib/utils";
import { deleteRestaurant } from "../actions";
import DeleteButton from "../delete-button";
import LogVisitButton from "@/components/log-visit-modal";

export default function RestaurantsTable({
  restaurants,
}: {
  restaurants: Restaurant[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return restaurants;
    return restaurants.filter((r) => {
      const haystack = [r.name, r.city, ...r.cuisines]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query, restaurants]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, city, or cuisine…"
          className="w-full sm:w-80 px-3 py-2 text-sm rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950 focus:outline-none focus:ring-2 focus:ring-stone-400 dark:focus:ring-stone-600"
        />
        <span className="text-sm text-stone-500 tabular-nums">
          {filtered.length} of {restaurants.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 dark:bg-stone-900 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="px-3 py-2">Place</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Cuisine</th>
              <th className="px-3 py-2 text-right">Overall</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-stone-500"
                >
                  No restaurants match “{query}”.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const deleteAction = deleteRestaurant.bind(null, r.id);
                return (
                  <tr
                    key={r.id}
                    className="border-t border-stone-200 dark:border-stone-800"
                  >
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                      {r.city}
                    </td>
                    <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                      {r.cuisines.join(", ")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmt(r.overall, 2)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
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
                        <Link
                          href={`/admin/${r.id}/edit`}
                          className="text-sm hover:underline"
                        >
                          Edit
                        </Link>
                        <form action={deleteAction}>
                          <DeleteButton name={r.name} />
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
