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
  if (secret.length === 0) {
    console.warn("Telegram webhook rejected: TELEGRAM_WEBHOOK_SECRET is unset");
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (!(await timingSafeEqual(header, secret))) {
    console.warn(`Telegram webhook rejected: secret header ${header.length === 0 ? "missing" : "does not match"}`);
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (chatId.length === 0) {
    console.warn("Telegram webhook ignored: TELEGRAM_CHAT_ID is unset");
    return NextResponse.json({ ok: true });
  }
  let update: unknown = null;
  try {
    update = await request.json();
  } catch {
    console.warn("Telegram webhook ignored: body is not JSON");
    return NextResponse.json({ ok: true });
  }
  const result = await acknowledgeFromTelegram(update, chatId);
  console.info(`Telegram webhook ${updateKind(update)} result ${result}`);
  return NextResponse.json({ ok: true });
}

function updateKind(update: unknown): string {
  if (!update || typeof update !== "object") return "unknown";
  const record = update as Record<string, unknown>;
  if (record.callback_query) return "callback_query";
  if (record.message) return "message";
  return "other";
}
