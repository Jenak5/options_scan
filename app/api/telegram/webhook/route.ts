import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "@/app/lib/auth";
import { acknowledgeFromTelegram } from "@/app/lib/avwapRepeatJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Public to the session middleware. Telegram must send X-Telegram-Bot-Api-Secret-Token.
 * If TELEGRAM_WEBHOOK_SECRET is unset, every update is rejected and repeats stay off.
 */
export async function POST(request: NextRequest) {
  return withBlobReadCache(() => handleWebhook(request));
}

async function handleWebhook(request: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (secret.length === 0 || !(await timingSafeEqual(header, secret))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (chatId.length === 0) return NextResponse.json({ ok: true });
  let update: unknown = null;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  await acknowledgeFromTelegram(update, chatId);
  return NextResponse.json({ ok: true });
}
