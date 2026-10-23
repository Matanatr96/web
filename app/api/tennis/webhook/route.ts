import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { applyWebhookEvent, parseWebhookEvent, type TennisWebhookEvent, verifyWebhookAuth } from "@/lib/tennis";

/**
 * `POST /api/tennis/webhook`: the single Postgres writer for the Modal `tennis-rally` app.
 * Fails closed on auth (500 when `TENNIS_WEBHOOK_SECRET` is unset, 401 on a bad Bearer token),
 * returns 400 for malformed events, applies the event with idempotent upserts (so Modal's retries
 * with the same `Idempotency-Key` are no-ops), and revalidates the `/tennis` pages.
 *
 * @param req - Webhook request from Modal.
 * @returns `{ ok, matchId, type }` on success, otherwise `{ error }` with 400 / 401 / 500.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const auth = verifyWebhookAuth(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error ?? "unauthorized" }, { status: auth.status });
  }

  let event: TennisWebhookEvent;
  try {
    event = parseWebhookEvent(await req.json());
  } catch (err) {
    const message = err instanceof SyntaxError ? "Invalid JSON body." : err instanceof Error ? err.message : "Invalid payload.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    await applyWebhookEvent(event);
  } catch (err) {
    console.error("[tennis/webhook] apply failed", event.type, event.matchId, err);
    return NextResponse.json({ error: "Database write failed." }, { status: 500 });
  }

  revalidatePath("/tennis");
  revalidatePath(`/tennis/${event.matchId}`);
  return NextResponse.json({ ok: true, matchId: event.matchId, type: event.type });
}
