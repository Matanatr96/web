import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { createRestaurant } from "../actions";
import RestaurantForm from "../restaurant-form";

export const dynamic = "force-dynamic";

export default async function NewRestaurantPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const { data } = await getSupabase()
    .from("restaurants")
    .select("name");
  const existingNames = (data ?? []).map((r) => r.name);

  return (
    <div className="max-w-3xl">
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin" className="hover:underline">
          ← Admin
        </Link>
      </nav>
      <h1 className="text-2xl font-bold tracking-tight mb-6">Add restaurant</h1>
      <RestaurantForm
        action={createRestaurant}
        submitLabel="Create"
        existingNames={existingNames}
      />
    </div>
  );
}
