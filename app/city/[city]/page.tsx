import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import { slugify } from "@/lib/utils";
import RestaurantsTable from "@/components/restaurants-table";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ city: string }> };

export default async function CityPage({ params }: Props) {
  const { city: citySlug } = await params;

  // Fetch everything, then match by slug — avoids trying to URL-decode
  // and handles any city in the DB regardless of special characters.
  const { data, error } = await getSupabase()
    .from("restaurants")
    .select("*")
    .order("overall", { ascending: false });

  if (error) {
    return <div className="text-red-600">Failed to load: {error.message}</div>;
  }

  const all = (data ?? []) as Restaurant[];
  const matching = all.filter((r) => slugify(r.city) === citySlug);
  if (matching.length === 0) notFound();

  const cityName = matching[0].city;

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/restaurants" className="hover:underline">
          ← All restaurants
        </Link>
      </nav>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{cityName}</h1>
        <p className="text-sm text-stone-500 mt-1">
          {matching.length} place{matching.length === 1 ? "" : "s"} in {cityName}.
        </p>
      </div>
      <RestaurantsTable
        restaurants={matching}
        fixedFilter={{ field: "city", value: cityName }}
      />
    </div>
  );
}
