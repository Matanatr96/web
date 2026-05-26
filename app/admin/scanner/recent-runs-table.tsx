import type { ScannerRun } from "@/lib/scanner-config";

const OUTCOME_STYLES: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  no_picks: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  daily_cap: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  market_closed: "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400",
  disabled: "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400",
  interval_skip: "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400",
  error: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export default function RecentRunsTable({ runs }: { runs: ScannerRun[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-stone-500">No runs logged yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
      <table className="w-full text-sm">
        <thead className="bg-stone-50 dark:bg-stone-900 text-stone-600 dark:text-stone-400">
          <tr>
            <th className="text-left px-3 py-2 font-medium">When</th>
            <th className="text-left px-3 py-2 font-medium">Outcome</th>
            <th className="text-right px-3 py-2 font-medium">CSPs</th>
            <th className="text-right px-3 py-2 font-medium">CCs</th>
            <th className="text-left px-3 py-2 font-medium">Trigger</th>
            <th className="text-left px-3 py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-stone-200 dark:border-stone-800">
              <td className="px-3 py-2 whitespace-nowrap text-stone-600 dark:text-stone-400">
                {new Date(r.ran_at).toLocaleString()}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${
                    OUTCOME_STYLES[r.outcome] ?? OUTCOME_STYLES.no_picks
                  }`}
                >
                  {r.outcome}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.csps || ""}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.ccs || ""}</td>
              <td className="px-3 py-2 text-xs text-stone-500">
                {r.forced ? "manual" : "cron"}
              </td>
              <td className="px-3 py-2 text-xs text-stone-500">{r.detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
