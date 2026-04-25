import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import SyncTradesButton from "@/components/sync-trades-button";

export const dynamic = "force-dynamic";

export default async function StonksAdminPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin" className="hover:underline">
          ← Admin
        </Link>
      </nav>

      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Stonks</h1>
        <p className="text-sm text-stone-500 mt-1">Manage trades from Tradier.</p>
      </div>

      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">Sync Trades</h2>
        <p className="text-sm text-stone-500 mb-4">
          Pull the latest options and equity trades from Tradier into the database.
        </p>
        <SyncTradesButton />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight mb-3">View</h2>
        <Link
          href="/options"
          className="text-sm hover:underline text-stone-600 dark:text-stone-400"
        >
          Options &amp; trades dashboard →
        </Link>
      </section>
    </div>
  );
}
