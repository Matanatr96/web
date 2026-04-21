import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "admin_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Hash the admin password into the value we store in the cookie.
 * Keeps the literal password out of the cookie jar + any access logs.
 */
function tokenFor(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function expected(): string {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw new Error("Missing ADMIN_PASSWORD env var.");
  return tokenFor(pw);
}

/**
 * Constant-time string compare to avoid timing attacks on the cookie check.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Check the request's admin cookie against the expected token.
 * Must be called from a Server Component, route handler, or server action.
 */
export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  const val = jar.get(COOKIE_NAME)?.value;
  if (!val) return false;
  try {
    return safeEqual(val, expected());
  } catch {
    return false;
  }
}

/**
 * Validate a password submission and, if correct, set the session cookie.
 * Returns true on success.
 */
export async function logIn(password: string): Promise<boolean> {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false;
  if (!safeEqual(password, pw)) return false;
  const jar = await cookies();
  jar.set(COOKIE_NAME, tokenFor(pw), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return true;
}

export async function logOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}
