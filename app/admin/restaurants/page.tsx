import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { RESTAURANT_SELECT, mapRestaurantRow } from "@/lib/restaurants-query";
import CuisineManager from "../add-cuisine-form";
import RestaurantsTable from "./restaurants-table";

export const dynamic = "force-dynamic";

export default async function RestaurantsAdminPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const supabase = getSupabase();

  const [{ data, error }, { data: cuisineData }] = await Promise.all([
    supabase.from("restaurants").select(RESTAURANT_SELECT).order("overall", { ascending: false }),
    supabase.from("cuisines").select("id, name").order("name"),
  ]);

  if (error) {
    return (
      <div className="text-red-600">Failed to load: {error.message}</div>
    );
  }
  const restaurants = (data ?? []).map(mapRestaurantRow);
  const cuisines = (cuisineData ?? []) as { id: number; name: string }[];

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin" className="hover:underline">
          ← Admin
        </Link>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Restaurants</h1>
          <p className="text-sm text-stone-500 mt-1">
            {restaurants.length} restaurants.
          </p>
        </div>
        <Link
          href="/admin/new"
          className="px-3 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90"
        >
          + Add restaurant
        </Link>
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight mb-3">Cuisines</h2>
        <CuisineManager cuisines={cuisines} />
      </section>

      <h2 className="text-lg font-semibold tracking-tight mt-10 mb-3">Restaurants</h2>
      <RestaurantsTable restaurants={restaurants} />
    </div>
  );
}
