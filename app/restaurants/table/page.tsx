import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import RestaurantsTable from "@/components/restaurants-table";

export const dynamic = "force-dynamic";

export default async function RestaurantsTablePage() {
  const { data, error } = await getSupabase()
    .from("restaurants")
    .select("*")
    .order("overall", { ascending: false });

  if (error) {
    return (
      <div className="text-red-600">
        Failed to load restaurants: {error.message}
      </div>
    );
  }

  const restaurants = (data ?? []) as Restaurant[];

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4 flex gap-3">
        <Link href="/restaurants" className="hover:underline">← Restaurants</Link>
        <span>·</span>
        <Link href="/map" className="hover:underline">Map</Link>
      </nav>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">All restaurants</h1>
        <p className="text-sm text-stone-500 mt-1">
          {restaurants.length} places rated, sorted by overall score.
        </p>
      </div>
      <RestaurantsTable restaurants={restaurants} />
    </div>
  );
}
