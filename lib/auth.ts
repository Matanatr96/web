import { createHash, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

type Scope = "admin" | "stonks";

const SCOPES: Record<Scope, { cookie: string; envVar: string }> = {
  admin:  { cookie: "admin_session",  envVar: "ADMIN_PASSWORD" },
  stonks: { cookie: "stonks_session", envVar: "STONKS_PASSWORD" },
};

function tokenFor(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a candidate admin token or raw password against a target scope's
 * configured password environment variable using constant-time comparison.
 *
 * @param candidate - Either the SHA-256 hex token or raw password string.
 * @param scope - Permission scope to check ("admin" or "stonks").
 * @returns True if `candidate` matches either the hashed token or raw password.
 */
export function verifyScopeToken(candidate: string, scope: Scope = "admin"): boolean {
  const { envVar } = SCOPES[scope];
  const pw = process.env[envVar];
  if (!pw || !candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  try {
    return safeEqual(trimmed, tokenFor(pw)) || safeEqual(trimmed, pw);
  } catch {
    return false;
  }
}

/**
 * Verify an admin token or password string directly.
 *
 * @param token - Candidate SHA-256 token or raw `ADMIN_PASSWORD`.
 * @returns True when valid.
 */
export function verifyAdminToken(token: string): boolean {
  return verifyScopeToken(token, "admin");
}

/**
 * Return the canonical SHA-256 hex token for the configured `ADMIN_PASSWORD`,
 * or null if `ADMIN_PASSWORD` is not set.
 *
 * @returns SHA-256 hex string or null.
 */
export function getAdminSessionToken(): string | null {
  const pw = process.env[SCOPES.admin.envVar];
  if (!pw) return null;
  return tokenFor(pw);
}

async function hasScope(scope: Scope): Promise<boolean> {
  const { cookie, envVar } = SCOPES[scope];
  const pw = process.env[envVar];
  if (!pw) return false;

  try {
    const jar = await cookies();
    const cookieVal = jar.get(cookie)?.value;
    if (cookieVal && verifyScopeToken(cookieVal, scope)) {
      return true;
    }
  } catch {
    // Ignore cookie read errors outside request contexts.
  }

  try {
    const hdrs = await headers();
    const authHeader = hdrs.get("authorization");
    if (authHeader) {
      const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (bearer && verifyScopeToken(bearer, scope)) {
        return true;
      }
    }
    const customHeader = hdrs.get("x-admin-token");
    if (customHeader && verifyScopeToken(customHeader, scope)) {
      return true;
    }
  } catch {
    // Ignore header read errors outside request contexts.
  }

  return false;
}

export async function isAdmin(): Promise<boolean> {
  return hasScope("admin");
}

/** Admin always implies stonks access. */
export async function hasStonksAccess(): Promise<boolean> {
  if (await hasScope("admin")) return true;
  return hasScope("stonks");
}

async function logInScope(scope: Scope, password: string): Promise<boolean> {
  const { cookie, envVar } = SCOPES[scope];
  const pw = process.env[envVar];
  if (!pw) return false;
  if (!safeEqual(password, pw)) return false;
  const jar = await cookies();
  jar.set(cookie, tokenFor(pw), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return true;
}

async function logOutScope(scope: Scope): Promise<void> {
  const jar = await cookies();
  jar.delete(SCOPES[scope].cookie);
}

export async function logIn(password: string): Promise<boolean> {
  return logInScope("admin", password);
}

export async function logOut(): Promise<void> {
  return logOutScope("admin");
}

export async function logInStonks(password: string): Promise<boolean> {
  return logInScope("stonks", password);
}

export async function logOutStonks(): Promise<void> {
  return logOutScope("stonks");
}
