import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { perDinerTotals, type ReceiptRow } from "@/lib/restaurant-receipts";
import ReceiptRowActions from "./receipt-row-actions";

export const dynamic = "force-dynamic";

type Row = ReceiptRow & {
  parsed_merchant: string | null;
  restaurant: { id: number; name: string; food: number | null } | null;
};

export default async function ReceiptsHistoryPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("receipts")
    .select(
      "id, visited_on, subtotal, tax, tip, total, created_at, parsed_merchant, restaurant:restaurants(id, name, food), items:receipt_items(id, name, price, qty, assignments:receipt_item_diners(diner_id, share, diner:diners(name)))",
    )
    .order("visited_on", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    return <div className="text-red-600">Failed to load: {error.message}</div>;
  }

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const receipts = (data ?? []) as unknown as Row[];

  return (
    <div className="max-w-4xl">
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin" className="hover:underline">
          ← Admin
        </Link>
      </nav>
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Receipts</h1>
        <Link href="/restaurants/receipt" className="text-sm text-stone-500 hover:underline">
          + new receipt
        </Link>
      </div>

      {receipts.length === 0 ? (
        <p className="text-sm text-stone-500">No receipts yet.</p>
      ) : (
        <ul className="space-y-3">
          {receipts.map((rc) => {
            const date = rc.visited_on ?? rc.created_at.slice(0, 10);
            const diners = perDinerTotals(rc);
            const linked = rc.restaurant;
            const unrated = linked && linked.food === null;
            return (
              <li
                key={rc.id}
                className="rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4"
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium tabular-nums">{date}</span>
                      {linked ? (
                        <Link
                          href={`/restaurant/${linked.id}`}
                          className="text-sm text-stone-700 dark:text-stone-300 hover:underline"
                        >
                          {linked.name}
                        </Link>
                      ) : (
                        <span className="text-sm text-stone-500 italic">
                          {rc.parsed_merchant ?? "unlinked"}
                        </span>
                      )}
                      {unrated && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200">
                          unrated
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular-nums text-stone-700 dark:text-stone-300 font-medium">
                      ${Number(rc.total).toFixed(2)}
                    </span>
                  </div>
                </div>

                {diners.length > 0 && (
                  <ul className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                    {diners.map((d) => (
                      <li
                        key={d.name}
                        className="flex justify-between text-stone-600 dark:text-stone-400 tabular-nums"
                      >
                        <span>{d.name}</span>
                        <span>${d.total.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/restaurants/receipt/${rc.id}`}
                    className="text-xs px-2.5 py-1 rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300"
                  >
                    View / share split →
                  </Link>
                  {!linked && apiKey && (
                    <ReceiptRowActions
                      receiptId={rc.id}
                      parsedMerchant={rc.parsed_merchant}
                      apiKey={apiKey}
                    />
                  )}
                  {unrated && (
                    <Link
                      href={`/admin/${linked!.id}/edit`}
                      className="text-xs px-2.5 py-1 rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-300"
                    >
                      Rate restaurant →
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
