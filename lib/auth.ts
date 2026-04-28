import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

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

async function hasScope(scope: Scope): Promise<boolean> {
  const { cookie, envVar } = SCOPES[scope];
  const pw = process.env[envVar];
  if (!pw) return false;
  const jar = await cookies();
  const val = jar.get(cookie)?.value;
  if (!val) return false;
  try {
    return safeEqual(val, tokenFor(pw));
  } catch {
    return false;
  }
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
