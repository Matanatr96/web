import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import { slugify } from "@/lib/utils";
import RestaurantsTable from "@/components/restaurants-table";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ cuisine: string }> };

export default async function CuisinePage({ params }: Props) {
  const { cuisine: cuisineSlug } = await params;

  const { data, error } = await getSupabase()
    .from("restaurants")
    .select("*")
    .order("overall", { ascending: false });

  if (error) {
    return <div className="text-red-600">Failed to load: {error.message}</div>;
  }

  const all = (data ?? []) as Restaurant[];
  const matching = all.filter((r) => slugify(r.cuisine) === cuisineSlug);
  if (matching.length === 0) notFound();

  const cuisineName = matching[0].cuisine;

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
