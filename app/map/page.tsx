import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import RestaurantsMap from "@/components/restaurants-map";

export const dynamic = "force-dynamic";

export default async function MapPage() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return (
      <div className="text-red-600">
        Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.
      </div>
    );
  }

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
  const withCoords = restaurants.filter((r) => r.lat !== null && r.lng !== null);
  const missing = restaurants.length - withCoords.length;

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/" className="hover:underline">← Home</Link>
        <span className="mx-2">·</span>
        <Link href="/restaurants" className="hover:underline">Table view</Link>
      </nav>
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Map</h1>
        <p className="text-sm text-stone-500 mt-1">
          {withCoords.length} of {restaurants.length} restaurants pinned
          {missing > 0 ? ` · ${missing} missing coordinates` : ""}.
        </p>
      </div>
      <RestaurantsMap restaurants={restaurants} apiKey={apiKey} />
    </div>
  );
}
