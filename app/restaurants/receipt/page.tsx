import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { perDinerTotals, type ReceiptRow } from "@/lib/restaurant-receipts";
import ReceiptWizard from "./receipt-wizard";

export const dynamic = "force-dynamic";

type RecentReceiptRow = ReceiptRow & {
  parsed_merchant: string | null;
  restaurant: { id: number; name: string } | null;
};

/**
 * Receipt scanner & splitter landing page (`/restaurants/receipt`).
 * Renders the interactive 6-step receipt wizard along with recent saved receipts
 * so past splits are always easy to reopen and share.
 */
export default async function ReceiptPage() {
  const supabase = getSupabase();
  const admin = await isAdmin();

  const [restaurantsRes, recentReceiptsRes] = await Promise.all([
    admin
      ? supabase.from("restaurants").select("id, name, city").order("name")
      : Promise.resolve({ data: [] as { id: number; name: string; city: string }[] }),
    supabase
      .from("receipts")
      .select(
        "id, visited_on, subtotal, tax, tip, total, created_at, parsed_merchant, restaurant:restaurants(id, name), items:receipt_items(id, name, price, qty, assignments:receipt_item_diners(diner_id, share, diner:diners(name)))",
      )
      .order("visited_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const restaurants = (restaurantsRes.data ?? []) as { id: number; name: string; city: string }[];
  const recentReceipts = (recentReceiptsRes.data ?? []) as unknown as RecentReceiptRow[];

  return (
    <div className="max-w-3xl mx-auto">
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/restaurants" className="hover:underline">
          ← Restaurants
        </Link>
      </nav>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Split a Receipt</h1>
      <p className="text-sm text-stone-500 mb-6">
        Snap a picture, assign items, see who owes what.
      </p>
      <ReceiptWizard
        restaurants={restaurants}
        isAdmin={admin}
        googleMapsApiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
      />

      {recentReceipts.length > 0 && (
        <section className="mt-10">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm uppercase tracking-wide text-stone-500">
              Recent Splits
            </h2>
            {admin && (
              <Link href="/admin/receipts" className="text-xs text-stone-500 hover:underline">
                All receipt history →
              </Link>
            )}
          </div>
          <ul className="space-y-2">
            {recentReceipts.map((rc) => {
              const date = rc.visited_on ?? rc.created_at.slice(0, 10);
              const label = rc.restaurant?.name ?? rc.parsed_merchant ?? `Receipt #${rc.id}`;
              const diners = perDinerTotals(rc);
              return (
                <li key={rc.id}>
                  <Link
                    href={`/restaurants/receipt/${rc.id}`}
                    className="block rounded-md border border-stone-200 dark:border-stone-800 p-3.5 bg-white dark:bg-stone-900 hover:border-stone-400 dark:hover:border-stone-600 transition"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div>
                        <span className="font-medium text-sm">{label}</span>
                        <span className="text-xs text-stone-500 tabular-nums ml-2">{date}</span>
                      </div>
                      <span className="text-sm font-medium tabular-nums">
                        ${Number(rc.total).toFixed(2)} →
                      </span>
                    </div>
                    {diners.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500 tabular-nums">
                        {diners.map((d) => (
                          <span key={d.name}>
                            {d.name}: <strong className="font-medium text-stone-700 dark:text-stone-300">${d.total.toFixed(2)}</strong>
                          </span>
                        ))}
                      </div>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

