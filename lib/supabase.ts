import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy-init singletons. We defer env var checks to the first actual call so
// that `next build` can load modules without crashing when env vars aren't set
// (e.g. in CI without secrets) or during Next.js's static analysis phase.

let _pub: SupabaseClient | null = null;
let _svc: SupabaseClient | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment.`);
  return v;
}

/**
 * Public client — used for anonymous reads from the browser and server.
 * Uses the publishable key (sb_publishable_…); respects Row Level Security.
 */
export function getSupabase(): SupabaseClient {
  if (_pub) return _pub;
  _pub = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { persistSession: false } },
  );
  return _pub;
}

/**
 * Privileged client — uses the secret key (sb_secret_…). Bypasses RLS.
 * Only call from server code (route handlers, server actions, scripts).
 * Never import this from a Client Component.
 */
export function getServiceClient(): SupabaseClient {
  if (_svc) return _svc;
  _svc = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SECRET_KEY"),
    { auth: { persistSession: false } },
  );
  return _svc;
}
