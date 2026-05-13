import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { ParsedReceipt } from "@/lib/receipts";

export const runtime = "nodejs";
export const maxDuration = 60;

const client = new Anthropic();

const HAIKU = "claude-haiku-4-5-20251001";
const OPUS = "claude-opus-4-7";

const SYSTEM_PROMPT = `You are a receipt-parsing assistant. The user will send a photo of a restaurant receipt. Extract the line items and totals as JSON.

Return ONLY a JSON object — no markdown, no commentary — with this exact shape:
{
  "merchant": string | null,
  "items": [{ "name": string, "price": number, "qty": number }],
  "subtotal": number | null,
  "tax": number | null,
  "tip": number | null,
  "total": number | null,
  "confidence": number
}

Rules:
- Each item must be a single food/drink line. Do NOT include subtotal, tax, tip, service charge, discount, or total as items.
- "price" is the per-unit price. If only the line total is visible and qty is 1, use the line total.
- If quantity isn't shown, qty = 1.
- Use null for tip if no tip line appears on the receipt (do not infer).
- "confidence" is your 0.0–1.0 self-assessment of how cleanly you could read the receipt. Lower it when the image is blurry, partial, handwritten, or you skipped items.
- Numbers are decimals (e.g. 12.50), not strings.`;

type Body = { image_base64: string; media_type?: string };

export async function POST(req: Request) {
  try {
    const { image_base64, media_type = "image/jpeg" } = (await req.json()) as Body;
    if (!image_base64) {
      return NextResponse.json({ error: "image_base64 is required" }, { status: 400 });
    }

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: media_type as "image/jpeg", data: image_base64 },
          },
          { type: "text", text: "Parse this receipt. JSON only." },
        ],
      },
    ];

    let model = HAIKU;
    let parsed = await callModel(model, messages);

    // Fall back to Opus if Haiku flubbed it.
    if (!parsed || parsed.confidence < 0.7 || parsed.items.length === 0) {
      model = OPUS;
      const retry = await callModel(model, messages);
      if (retry) parsed = retry;
    }

    if (!parsed) {
      return NextResponse.json({ error: "Could not parse receipt." }, { status: 422 });
    }

    return NextResponse.json({ parsed, model });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("receipts/parse error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function callModel(model: string, messages: Anthropic.MessageParam[]): Promise<ParsedReceipt | null> {
  const resp = await client.messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages,
  });
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  return extractJson(text);
}

function extractJson(text: string): ParsedReceipt | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      merchant: typeof obj.merchant === "string" ? obj.merchant : null,
      items: Array.isArray(obj.items)
        ? (obj.items as unknown[])
            .filter((i): i is { name: string; price: number; qty?: number } => {
              const r = i as { name?: unknown; price?: unknown };
              return typeof r.name === "string" && typeof r.price === "number";
            })
            .map((i) => ({ name: i.name, price: i.price, qty: typeof i.qty === "number" && i.qty > 0 ? i.qty : 1 }))
        : [],
      subtotal: typeof obj.subtotal === "number" ? obj.subtotal : null,
      tax: typeof obj.tax === "number" ? obj.tax : null,
      tip: typeof obj.tip === "number" ? obj.tip : null,
      total: typeof obj.total === "number" ? obj.total : null,
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
    };
  } catch {
    return null;
  }
}
