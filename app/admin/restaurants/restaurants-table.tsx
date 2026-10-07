"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Restaurant } from "@/lib/types";
import { fmt } from "@/lib/utils";
import { deleteRestaurant } from "../actions";
import DeleteButton from "../delete-button";
import LogVisitButton from "@/components/log-visit-modal";

import {
  filterAdminRestaurants,
  type AdminSortKey,
  type AdminStatusFilter,
  type SortDir,
} from "@/lib/restaurants-query";

/**
 * Interactive admin restaurants table with search, city, cuisine, category,
 * and status filtering plus sortable columns.
 */
export default function RestaurantsTable({
  restaurants,
}: {
  restaurants: Restaurant[];
}) {
  const [query, setQuery] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [cuisineFilter, setCuisineFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<AdminStatusFilter>("");
  const [sortKey, setSortKey] = useState<AdminSortKey>("overall");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const cities = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.city))).sort(),
    [restaurants],
  );
  const cuisines = useMemo(
    () => Array.from(new Set(restaurants.flatMap((r) => r.cuisines))).sort(),
    [restaurants],
  );
  const categories = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.category).filter(Boolean))).sort(),
    [restaurants],
  );

  const filtered = useMemo(
    () =>
      filterAdminRestaurants(restaurants, {
        query,
        city: cityFilter,
        cuisine: cuisineFilter,
        category: categoryFilter,
        status: statusFilter,
        sortKey,
        sortDir,
      }),
    [restaurants, query, cityFilter, cuisineFilter, categoryFilter, statusFilter, sortKey, sortDir],
  );

  const hasActiveFilters = Boolean(
    query.trim() || cityFilter || cuisineFilter || categoryFilter || statusFilter,
  );

  function clearFilters() {
    setQuery("");
    setCityFilter("");
    setCuisineFilter("");
    setCategoryFilter("");
    setStatusFilter("");
  }

  function onSort(key: AdminSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "overall" || key === "last_visited" ? "desc" : "asc");
    }
  }

  const arrow = (key: AdminSortKey) =>
    key === sortKey ? (sortDir === "asc" ? "↑" : "↓") : "";

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, city, or cuisine…"
          className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-400 dark:focus:ring-stone-600"
        />
        <select
          aria-label="Filter by city"
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        >
          <option value="">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by cuisine"
          value={cuisineFilter}
          onChange={(e) => setCuisineFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        >
          <option value="">All cuisines</option>
          {cuisines.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by category"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as AdminStatusFilter)}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        >
          <option value="">All statuses</option>
          <option value="unrated">Unrated</option>
          <option value="rated">Rated</option>
          <option value="missing_coords">Missing map pin</option>
          <option value="missing_cuisine">Missing cuisine</option>
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="px-3 py-2 text-xs rounded-md border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-stone-500 tabular-nums">
          Showing {filtered.length} of {restaurants.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 dark:bg-stone-900 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th
                onClick={() => onSort("name")}
                className="px-3 py-2 cursor-pointer select-none"
              >
                Place {arrow("name")}
              </th>
              <th
                onClick={() => onSort("city")}
                className="px-3 py-2 cursor-pointer select-none"
              >
                City {arrow("city")}
              </th>
              <th
                onClick={() => onSort("cuisines")}
                className="px-3 py-2 cursor-pointer select-none"
              >
                Cuisine {arrow("cuisines")}
              </th>
              <th
                onClick={() => onSort("category")}
                className="px-3 py-2 cursor-pointer select-none"
              >
                Category {arrow("category")}
              </th>
              <th
                onClick={() => onSort("overall")}
                className="px-3 py-2 text-right cursor-pointer select-none"
              >
                Overall {arrow("overall")}
              </th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-stone-500"
                >
                  No restaurants match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const deleteAction = deleteRestaurant.bind(null, r.id);
                const unrated = r.food === null;
                return (
                  <tr
                    key={r.id}
                    className="border-t border-stone-200 dark:border-stone-800"
                  >
                    <td className="px-3 py-2 font-medium">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link href={`/restaurant/${r.id}`} className="hover:underline">
                          {r.name}
                        </Link>
                        {unrated && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 font-normal">
                            unrated
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                      {r.city}
                    </td>
                    <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                      {r.cuisines.join(", ")}
                    </td>
                    <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                      {r.category}
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

