import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { RESTAURANT_SELECT, mapRestaurantRow } from "@/lib/restaurants-query";
import { slugify } from "@/lib/utils";
import RestaurantsTable from "@/components/restaurants-table";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ cuisine: string }> };

export default async function CuisinePage({ params }: Props) {
  const { cuisine: cuisineSlug } = await params;

  const { data, error } = await getSupabase()
    .from("restaurants")
    .select(RESTAURANT_SELECT)
    .order("overall", { ascending: false });

  if (error) {
    return <div className="text-red-600">Failed to load: {error.message}</div>;
  }

  const all = (data ?? []).map(mapRestaurantRow);
  // Inclusive match: a restaurant shows up under each of its cuisines.
  const matching = all.filter((r) =>
    r.cuisines.some((c) => slugify(c) === cuisineSlug),
  );
  if (matching.length === 0) notFound();

  const cuisineName =
    matching[0].cuisines.find((c) => slugify(c) === cuisineSlug) ?? cuisineSlug;

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/restaurants" className="hover:underline">
          ← All restaurants
        </Link>
      </nav>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{cuisineName}</h1>
        <p className="text-sm text-stone-500 mt-1">
          {matching.length} place{matching.length === 1 ? "" : "s"} serving{" "}
          {cuisineName}.
        </p>
      </div>
      <RestaurantsTable
        restaurants={matching}
        fixedFilter={{ field: "cuisine", value: cuisineName }}
      />
    </div>
  );
}
