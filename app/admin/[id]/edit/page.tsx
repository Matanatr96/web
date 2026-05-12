import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { RESTAURANT_SELECT, mapRestaurantRow } from "@/lib/restaurants-query";
import { updateRestaurant } from "../../actions";
import RestaurantForm from "../../restaurant-form";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function EditRestaurantPage({ params }: Props) {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) notFound();

  const supabase = getSupabase();
  const [{ data, error }, { data: cuisineData }] = await Promise.all([
    supabase.from("restaurants").select(RESTAURANT_SELECT).eq("id", numericId).single(),
    supabase.from("cuisines").select("name").order("name"),
  ]);
  if (error || !data) notFound();
  const r = mapRestaurantRow(data);
  const cuisines = (cuisineData ?? []).map((c: { name: string }) => c.name);

  // Bind the row id into the server action so the form only carries the fields.
  const action = updateRestaurant.bind(null, r.id);

  return (
    <div className="max-w-3xl">
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin/restaurants" className="hover:underline">
          ← Restaurants
        </Link>
      </nav>
      <h1 className="text-2xl font-bold tracking-tight mb-6">
        Edit: {r.name}
      </h1>
      <RestaurantForm
        initial={r}
        action={action}
        submitLabel="Save changes"
        cuisines={cuisines.length ? cuisines : undefined}
        googleMapsApiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
      />
    </div>
  );
}
