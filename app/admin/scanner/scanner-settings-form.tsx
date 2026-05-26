"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ScannerConfig } from "@/lib/scanner-config";

type Props = { initial: ScannerConfig };

const INTERVAL_OPTIONS = [15, 30, 45, 60, 120, 240];
const DEDUP_OPTIONS = [1, 2, 4, 6, 8, 12, 24];

export default function ScannerSettingsForm({ initial }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [interval, setInterval] = useState(initial.scan_interval_min);
  const [dedup, setDedup] = useState(initial.dedup_hours);
  const [cap, setCap] = useState(initial.daily_email_cap);
  const [maxPer, setMaxPer] = useState(initial.max_per_type);
  const [savedAt, setSavedAt] = useState<string>(initial.updated_at);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [triggering, startTrigger] = useTransition();
  const [triggerResult, setTriggerResult] = useState<string | null>(null);

  const dirty =
    enabled !== initial.enabled ||
    interval !== initial.scan_interval_min ||
    dedup !== initial.dedup_hours ||
    cap !== initial.daily_email_cap ||
    maxPer !== initial.max_per_type;

  function save() {
    setSaveErr(null);
    startSave(async () => {
      const resp = await fetch("/api/scanner/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          scan_interval_min: interval,
          dedup_hours: dedup,
          daily_email_cap: cap,
          max_per_type: maxPer,
        }),
      });
      const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      if (!resp.ok) {
        setSaveErr(typeof json.error === "string" ? json.error : "save failed");
        return;
      }
      setSavedAt(String(json.updated_at ?? new Date().toISOString()));
      router.refresh();
    });
  }

  function triggerScan() {
    setTriggerResult(null);
    startTrigger(async () => {
      const resp = await fetch("/api/scanner/trigger", { method: "POST" });
      const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      if (!resp.ok) {
        setTriggerResult(`error: ${typeof json.error === "string" ? json.error : resp.status}`);
        return;
      }
      const parts: string[] = [];
      if (typeof json.skipped === "string") parts.push(`skipped (${json.skipped})`);
      if (typeof json.csps === "number") parts.push(`${json.csps} CSPs`);
      if (typeof json.ccs === "number") parts.push(`${json.ccs} CCs`);
      if (typeof json.email_id === "string") parts.push("email sent");
      setTriggerResult(parts.length > 0 ? parts.join(" · ") : "ok");
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-5 space-y-5 max-w-2xl">
      {/* Enabled toggle */}
      <Row label="Enabled" hint="Master switch — when off, heartbeat skips everything.">
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
            enabled ? "bg-emerald-600" : "bg-stone-300 dark:bg-stone-700"
          }`}
          aria-pressed={enabled}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </Row>

      <Row label="Scan interval" hint="Minimum minutes between scans. The heartbeat fires every 15 min.">
        <Select value={interval} setValue={setInterval} options={INTERVAL_OPTIONS} suffix="min" />
      </Row>

      <Row label="Dedup window" hint="Don't re-alert the same (ticker, strike, expiry) within this window.">
        <Select value={dedup} setValue={setDedup} options={DEDUP_OPTIONS} suffix="hr" />
      </Row>

      <Row label="Daily email cap" hint="Maximum distinct send-times per UTC day.">
        <NumberInput value={cap} setValue={setCap} min={1} max={20} />
      </Row>

      <Row label="Max picks per type" hint="Cap on CSP rows and CC rows in each email.">
        <NumberInput value={maxPer} setValue={setMaxPer} min={1} max={20} />
      </Row>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-stone-200 dark:border-stone-800">
        <div className="text-xs text-stone-500">
          Last saved: {new Date(savedAt).toLocaleString()}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={triggerScan}
            disabled={triggering}
            className="px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
            title="Run a scan now, bypassing interval/market-hours/daily-cap checks."
          >
            {triggering ? "Triggering…" : "Run scan now"}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="px-3 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {saveErr && <p className="text-xs text-red-600">{saveErr}</p>}
      {triggerResult && (
        <p className="text-xs text-stone-600 dark:text-stone-400">
          Trigger result: {triggerResult}
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-stone-500 mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Select({
  value,
  setValue,
  options,
  suffix,
}: {
  value: number;
  setValue: (n: number) => void;
  options: number[];
  suffix: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => setValue(Number(e.target.value))}
      className="px-3 py-1.5 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-transparent focus:outline-none focus:ring-1 focus:ring-stone-400"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt} {suffix}</option>
      ))}
    </select>
  );
}

function NumberInput({
  value,
  setValue,
  min,
  max,
}: {
  value: number;
  setValue: (n: number) => void;
  min: number;
  max: number;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) setValue(n);
      }}
      className="w-20 px-3 py-1.5 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-transparent focus:outline-none focus:ring-1 focus:ring-stone-400"
    />
  );
}
