import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { logoutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
        <form action={logoutAction}>
          <button
            type="submit"
            className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Sign out
          </button>
        </form>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
        <Link
          href="/admin/restaurants"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Restaurants</span>
          <span className="text-sm text-stone-500">Manage restaurants &amp; cuisines</span>
        </Link>

        <Link
          href="/admin/stonks"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Stonks</span>
          <span className="text-sm text-stone-500">Sync &amp; manage trades</span>
        </Link>

        <Link
          href="/admin/watchlist"
          className="flex flex-col gap-1 rounded-lg border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
        >
          <span className="font-semibold">Watchlist</span>
          <span className="text-sm text-stone-500">Wheel strategy tickers</span>
        </Link>
      </div>
    </div>
  );
}
