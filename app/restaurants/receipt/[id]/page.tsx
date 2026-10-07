import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { splitSavedReceipt, type ReceiptRow } from "@/lib/restaurant-receipts";
import ReceiptDetailClient, { type SavedReceiptItemView } from "./receipt-detail-client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

type DetailedReceiptRow = ReceiptRow & {
  parsed_merchant: string | null;
  restaurant: { id: number; name: string; city: string | null } | null;
};

/**
 * Public shareable receipt breakdown page (`/restaurants/receipt/[id]`).
 * Displays who owes what (items, proportional tax & tip, and cent-reconciled
 * total) along with one-tap copy/share actions for group chats.
 */
export default async function ReceiptDetailPage({ params }: Props) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) notFound();

  const supabase = getSupabase();
  const [{ data, error }, admin] = await Promise.all([
    supabase
      .from("receipts")
      .select(
        "id, visited_on, subtotal, tax, tip, total, created_at, parsed_merchant, restaurant:restaurants(id, name, city), items:receipt_items(id, name, price, qty, position, assignments:receipt_item_diners(diner_id, share, diner:diners(name)))",
      )
      .eq("id", numericId)
      .single(),
    isAdmin(),
  ]);

  if (error || !data) notFound();

  const rc = data as unknown as DetailedReceiptRow;
  const date = rc.visited_on ?? rc.created_at.slice(0, 10);
  const title = rc.restaurant?.name ?? rc.parsed_merchant ?? `Receipt #${rc.id}`;
  const split = splitSavedReceipt(rc);

  const items: SavedReceiptItemView[] = (rc.items ?? []).map((it) => ({
    id: it.id,
    name: it.name,
    price: Number(it.price),
    qty: Number(it.qty),
    dinerNames: it.assignments
      .map((a) => a.diner?.name)
      .filter((n): n is string => Boolean(n)),
  }));

  return (
    <div className="max-w-3xl mx-auto">
      <nav className="text-sm text-stone-500 mb-4 flex items-center gap-3">
        <Link href="/restaurants/receipt" className="hover:underline">
          ← Split a Receipt
        </Link>
        {rc.restaurant && (
          <>
            <span>·</span>
            <Link href={`/restaurant/${rc.restaurant.id}`} className="hover:underline">
              {rc.restaurant.name}
            </Link>
          </>
        )}
      </nav>

      <div className="mb-6">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight">
            {rc.restaurant ? (
              <Link href={`/restaurant/${rc.restaurant.id}`} className="hover:underline">
                {rc.restaurant.name}
              </Link>
            ) : (
              title
            )}
          </h1>
          <span className="text-sm text-stone-500 tabular-nums">{date}</span>
        </div>
        <p className="text-sm text-stone-500 mt-1">
          Receipt #{rc.id}
          {rc.restaurant?.city ? ` · ${rc.restaurant.city}` : ""}
        </p>
      </div>

      <ReceiptDetailClient
        receiptId={rc.id}
        title={title}
        date={date}
        restaurant={rc.restaurant}
        parsedMerchant={rc.parsed_merchant}
        perDiner={split.per_diner}
        items={items}
        subtotal={split.subtotal}
        tax={split.tax}
        tip={split.tip}
        total={split.total}
        isAdmin={admin}
        googleMapsApiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}
      />
    </div>
  );
}
