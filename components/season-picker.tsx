"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SeasonPicker({
  seasons,
  current,
  basePath,
}: {
  seasons: number[];
  current: number;
  basePath: string;
}) {
  const router = useRouter();
  const currentYear = new Date().getFullYear();
  const recent = seasons.filter((s) => s >= currentYear - 1);
  const older = seasons.filter((s) => s < currentYear - 1);
  const olderSelected = older.includes(current);

  return (
    <div className="flex items-center gap-2">
      {recent.map((s) => (
        <Link
          key={s}
          href={`${basePath}?season=${s}`}
          className={`px-3 py-1.5 rounded-md text-sm border transition ${
            s === current
              ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
              : "border-stone-200 dark:border-stone-800 text-stone-600 hover:border-stone-400"
          }`}
        >
          {s}
        </Link>
      ))}
      {older.length > 0 && (
        <select
          value={olderSelected ? current : ""}
          onChange={(e) => {
            if (e.target.value) router.push(`${basePath}?season=${e.target.value}`);
          }}
          className={`px-3 py-1.5 rounded-md text-sm border transition appearance-none cursor-pointer ${
            olderSelected
              ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
              : "border-stone-200 dark:border-stone-800 text-stone-600 hover:border-stone-400 bg-white dark:bg-stone-950"
          }`}
        >
          <option value="" disabled>
            {olderSelected ? current : "Older"}
          </option>
          {older.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
