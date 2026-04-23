"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Restaurant } from "@/lib/types";
import { fmt, lastVisitedColorClass, ratingColorClass, slugify } from "@/lib/utils";

type SortKey =
  | "name"
  | "city"
  | "cuisine"
  | "category"
  | "overall"
  | "food"
  | "value"
  | "service"
  | "ambiance"
  | "vegan_options"
  | "last_visited";

type SortDir = "asc" | "desc";

type Props = {
  restaurants: Restaurant[];
  /** Optionally pre-filter to a single city or cuisine (used on /city/[city] etc). */
  fixedFilter?: { field: "city" | "cuisine" | "category"; value: string };
};

export default function RestaurantsTable({ restaurants, fixedFilter }: Props) {
  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [cuisineFilter, setCuisineFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const cities = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.city))).sort(),
    [restaurants],
  );
  const cuisines = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.cuisine))).sort(),
    [restaurants],
  );
  const categories = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.category))).sort(),
    [restaurants],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = restaurants.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (cityFilter && r.city !== cityFilter) return false;
      if (cuisineFilter && r.cuisine !== cuisineFilter) return false;
      if (categoryFilter && r.category !== categoryFilter) return false;
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
    return list;
  }, [
    restaurants,
    search,
    cityFilter,
    cuisineFilter,
    categoryFilter,
    sortKey,
    sortDir,
  ]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Numeric columns default to descending (high scores first); text columns ascending.
      const numeric: SortKey[] = [
        "overall",
        "food",
        "value",
        "service",
        "ambiance",
        "vegan_options",
      ];
      setSortDir(numeric.includes(key) ? "desc" : "asc");
    }
  };

  const arrow = (key: SortKey) =>
    key === sortKey ? (sortDir === "asc" ? "↑" : "↓") : "";

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
        />
        {!fixedFilter || fixedFilter.field !== "city" ? (
          <select
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
        ) : null}
        {!fixedFilter || fixedFilter.field !== "cuisine" ? (
          <select
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
        ) : null}
        {!fixedFilter || fixedFilter.field !== "category" ? (
          <select
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
        ) : null}
      </div>

      <p className="text-xs text-stone-500 mb-2">
        Showing {visible.length} of {restaurants.length}
      </p>

      <div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 dark:bg-stone-900 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <Th onClick={() => onSort("name")} label={`Place ${arrow("name")}`} />
              <Th onClick={() => onSort("city")} label={`City ${arrow("city")}`} />
              <Th onClick={() => onSort("cuisine")} label={`Cuisine ${arrow("cuisine")}`} />
              <Th
                onClick={() => onSort("overall")}
                label={`Overall ${arrow("overall")}`}
                align="right"
              />
              <Th onClick={() => onSort("food")} label={`Food ${arrow("food")}`} align="right" />
              <Th
                onClick={() => onSort("value")}
                label={`Value ${arrow("value")}`}
                align="right"
              />
              <Th
                onClick={() => onSort("service")}
                label={`Service ${arrow("service")}`}
                align="right"
              />
              <Th
                onClick={() => onSort("ambiance")}
                label={`Ambiance ${arrow("ambiance")}`}
                align="right"
              />
              <Th
                onClick={() => onSort("vegan_options")}
                label={`Vegan ${arrow("vegan_options")}`}
                align="right"
              />
              <Th
                onClick={() => onSort("last_visited")}
                label={`Last Visited ${arrow("last_visited")}`}
                align="right"
              />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className="border-t border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900/50"
              >
                <td className="px-3 py-2 font-medium">
                  <Link href={`/restaurant/${r.id}`} className="hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                  <Link
                    href={`/city/${slugify(r.city)}`}
                    className="hover:underline"
                  >
                    {r.city}
                  </Link>
                </td>
                <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                  <Link
                    href={`/cuisine/${slugify(r.cuisine)}`}
                    className="hover:underline"
                  >
                    {r.cuisine}
                  </Link>
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${ratingColorClass(r.overall)}`}>
                  {fmt(r.overall, 2)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${ratingColorClass(r.food)}`}>
                  {fmt(r.food)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${ratingColorClass(r.value)}`}>
                  {fmt(r.value)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${ratingColorClass(r.service)}`}>
                  {fmt(r.service)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${ratingColorClass(r.ambiance)}`}
                >
                  {fmt(r.ambiance)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${ratingColorClass(r.vegan_options)}`}
                >
                  {fmt(r.vegan_options)}
                </td>
                <td className={`px-3 py-2 text-right whitespace-nowrap ${lastVisitedColorClass(r.last_visited)}`}>
                  {r.last_visited
                    ? new Date(r.last_visited + "T00:00:00").toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "—"}
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="px-3 py-8 text-center text-stone-500"
                >
                  No restaurants match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  onClick,
  label,
  align = "left",
}: {
  onClick: () => void;
  label: string;
  align?: "left" | "right";
}) {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 cursor-pointer select-none ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {label}
    </th>
  );
}
