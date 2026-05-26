import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getScannerConfig, getRecentRuns } from "@/lib/scanner-config";
import ScannerSettingsForm from "./scanner-settings-form";
import RecentRunsTable from "./recent-runs-table";
import PreviewPicks from "./preview-picks";

export const dynamic = "force-dynamic";

export default async function ScannerSettingsPage() {
  if (!(await isAdmin())) {
    redirect("/admin/login");
  }

  const [config, runs] = await Promise.all([
    getScannerConfig(),
    getRecentRuns(20),
  ]);

  return (
    <div>
      <nav className="text-sm text-stone-500 mb-4">
        <Link href="/admin" className="hover:underline">← Admin</Link>
      </nav>

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Scanner</h1>
        <p className="text-sm text-stone-500 mt-1">
          Tune how often the CSP/CC scanner runs and how aggressively it emails alerts.
          A GitHub Actions heartbeat hits the cron endpoint every 15 min; this row decides
          whether each heartbeat actually scans.
        </p>
      </div>

      <ScannerSettingsForm initial={config} />

      <div className="mt-10">
        <PreviewPicks />
      </div>

      <div className="mt-10">
        <h2 className="text-lg font-semibold mb-3">Recent runs</h2>
        <RecentRunsTable runs={runs} />
      </div>
    </div>
  );
}
