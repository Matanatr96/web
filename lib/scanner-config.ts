// Read/write helpers for the singleton `scanner_config` row plus the
// `scanner_runs` ledger. The cron route reads config every invocation so
// changes from the UI take effect on the next heartbeat.

import { getServiceClient } from "@/lib/supabase";

export type ScannerConfig = {
  enabled: boolean;
  scan_interval_min: number;
  dedup_hours: number;
  daily_email_cap: number;
  max_per_type: number;
  updated_at: string;
};

export const DEFAULT_CONFIG: ScannerConfig = {
  enabled: true,
  scan_interval_min: 30,
  dedup_hours: 4,
  daily_email_cap: 5,
  max_per_type: 8,
  updated_at: new Date(0).toISOString(),
};

export type ScannerRunOutcome =
  | "sent"
  | "no_picks"
  | "daily_cap"
  | "market_closed"
  | "disabled"
  | "interval_skip"
  | "error";

export type ScannerRun = {
  id: number;
  ran_at: string;
  outcome: ScannerRunOutcome;
  csps: number;
  ccs: number;
  forced: boolean;
  detail: string | null;
};

export async function getScannerConfig(): Promise<ScannerConfig> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("scanner_config")
    .select("enabled,scan_interval_min,dedup_hours,daily_email_cap,max_per_type,updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.error("[scanner-config] fetch failed", error);
    return DEFAULT_CONFIG;
  }
  if (!data) return DEFAULT_CONFIG;
  return data as ScannerConfig;
}

export type ScannerConfigPatch = Partial<Omit<ScannerConfig, "updated_at">>;

export function validateConfigPatch(patch: ScannerConfigPatch): string | null {
  if (patch.scan_interval_min != null) {
    if (!Number.isInteger(patch.scan_interval_min) ||
        patch.scan_interval_min < 15 ||
        patch.scan_interval_min > 240) {
      return "scan_interval_min must be an integer between 15 and 240";
    }
  }
  if (patch.dedup_hours != null) {
    if (!Number.isInteger(patch.dedup_hours) ||
        patch.dedup_hours < 1 ||
        patch.dedup_hours > 24) {
      return "dedup_hours must be an integer between 1 and 24";
    }
  }
  if (patch.daily_email_cap != null) {
    if (!Number.isInteger(patch.daily_email_cap) ||
        patch.daily_email_cap < 1 ||
        patch.daily_email_cap > 20) {
      return "daily_email_cap must be an integer between 1 and 20";
    }
  }
  if (patch.max_per_type != null) {
    if (!Number.isInteger(patch.max_per_type) ||
        patch.max_per_type < 1 ||
        patch.max_per_type > 20) {
      return "max_per_type must be an integer between 1 and 20";
    }
  }
  return null;
}

export async function updateScannerConfig(patch: ScannerConfigPatch): Promise<ScannerConfig> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("scanner_config")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("enabled,scan_interval_min,dedup_hours,daily_email_cap,max_per_type,updated_at")
    .single();
  if (error) throw new Error(`update failed: ${error.message}`);
  return data as ScannerConfig;
}

export async function logScannerRun(args: {
  outcome: ScannerRunOutcome;
  csps?: number;
  ccs?: number;
  forced?: boolean;
  detail?: string | null;
}): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.from("scanner_runs").insert({
    outcome: args.outcome,
    csps: args.csps ?? 0,
    ccs: args.ccs ?? 0,
    forced: args.forced ?? false,
    detail: args.detail ?? null,
  });
  if (error) console.error("[scanner-config] logScannerRun failed", error);
}

export async function getLastSuccessfulRun(): Promise<ScannerRun | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("scanner_runs")
    .select("id,ran_at,outcome,csps,ccs,forced,detail")
    .in("outcome", ["sent", "no_picks"])
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[scanner-config] getLastSuccessfulRun failed", error);
    return null;
  }
  return (data as ScannerRun | null) ?? null;
}

export async function getRecentRuns(limit = 20): Promise<ScannerRun[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("scanner_runs")
    .select("id,ran_at,outcome,csps,ccs,forced,detail")
    .order("ran_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[scanner-config] getRecentRuns failed", error);
    return [];
  }
  return (data ?? []) as ScannerRun[];
}
