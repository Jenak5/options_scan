import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { publicAppOrigin, setTelegramWebhook } from "@/app/lib/telegram";

export const dynamic = "force-dynamic";

/** One-time registration of the AVWAP acknowledgement webhook. Session or bearer. */
export async function POST(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (secret.length === 0) {
    return NextResponse.json({ ok: false, description: "TELEGRAM_WEBHOOK_SECRET is unset" }, { status: 400 });
  }
  const origin = publicAppOrigin();
  if (!origin.startsWith("https://")) {
    return NextResponse.json({ ok: false, description: "The deployment URL is not https" }, { status: 400 });
  }
  const result = await setTelegramWebhook(`${origin}/api/telegram/webhook`, secret);
  if (result.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, description: result.description ?? "Telegram did not accept the webhook" }, { status: 502 });
}
