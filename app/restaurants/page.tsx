import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import RestaurantsTable from "@/components/restaurants-table";

// Always render from fresh data — simpler mental model while the dataset is small.
// If we ever scale up, swap this to revalidate on a timer or on admin writes.
export const dynamic = "force-dynamic";

export default async function RestaurantsPage() {
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
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/" className="hover:underline">
          ← Home
        </Link>
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
