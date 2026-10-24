import { NextResponse } from "next/server";
import { getAdminSessionToken, isAdmin, verifyAdminToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Verify whether the incoming request carries a valid admin session cookie
 * or `Authorization: Bearer <token>` header.
 *
 * @returns 200 `{ authenticated: true, token }` when valid, or 401 `{ authenticated: false }`.
 */
export async function GET() {
  const authenticated = await isAdmin();
  if (!authenticated) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    token: getAdminSessionToken(),
  });
}

/**
 * Verify an admin password or token submitted in the JSON body (`{ password, token }`)
 * or request headers, returning the canonical SHA-256 session token for iOS Keychain storage.
 *
 * @param req - Incoming HTTP request with optional `{ password?: string; token?: string }` body.
 * @returns 200 `{ authenticated: true, token }` when valid, or 401 `{ authenticated: false }`.
 */
export async function POST(req: Request) {
  let bodyToken: string | null = null;
  try {
    const body = (await req.json()) as { password?: string; token?: string } | null;
    bodyToken = body?.password ?? body?.token ?? null;
  } catch {
    // Allow empty body when caller passes Authorization header or cookie.
  }

  const authenticated =
    (bodyToken ? verifyAdminToken(bodyToken) : false) || (await isAdmin());

  if (!authenticated) {
    return NextResponse.json({ authenticated: false, error: "Invalid admin credentials" }, { status: 401 });
  }

  return NextResponse.json({
    authenticated: true,
    token: getAdminSessionToken(),
  });
}
