import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import ReceiptWizard from "./receipt-wizard";

export const dynamic = "force-dynamic";

export default async function ReceiptPage() {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("restaurants")
    .select("id, name, city")
    .order("name");

  const restaurants = (data ?? []) as { id: number; name: string; city: string }[];

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
      <ReceiptWizard restaurants={restaurants} />
    </div>
  );
}
