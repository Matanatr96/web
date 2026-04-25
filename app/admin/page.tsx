import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import type { Restaurant } from "@/lib/types";
import { fmt } from "@/lib/utils";
import { deleteRestaurant, logoutAction } from "./actions";
import DeleteButton from "./delete-button";
import CuisineManager from "./add-cuisine-form";
import SyncTradesButton from "@/components/sync-trades-button";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const supabase = getSupabase();

  const [{ data, error }, { data: cuisineData }] = await Promise.all([
    supabase.from("restaurants").select("*").order("overall", { ascending: false }),
    supabase.from("cuisines").select("id, name").order("name"),
  ]);

  if (error) {
    return (
      <div className="text-red-600">Failed to load: {error.message}</div>
    );
  }
  const restaurants = (data ?? []) as Restaurant[];
  const cuisines = (cuisineData ?? []) as { id: number; name: string }[];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
          <p className="text-sm text-stone-500 mt-1">
            {restaurants.length} restaurants.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SyncTradesButton />
          <Link
            href="/admin/new"
            className="px-3 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90"
          >
            + Add restaurant
          </Link>
          <form action={logoutAction}>
            <button
              type="submit"
              className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight mb-3">Cuisines</h2>
        <CuisineManager cuisines={cuisines} />
      </section>

      <h2 className="text-lg font-semibold tracking-tight mt-10 mb-3">Restaurants</h2>
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
            {restaurants.map((r) => {
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
                    {r.cuisine}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmt(r.overall, 2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
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
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

