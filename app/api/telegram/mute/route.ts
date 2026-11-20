import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { readMuteView, setTelegramMuted } from "@/app/lib/telegramMuteJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/** Read whether non-AVWAP Telegram alerts are muted. Session or bearer. */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => readMute(request));
}

/** Body: {"muted": true|false}. Session or bearer. Takes effect on the next send. */
export async function POST(request: NextRequest) {
  return withBlobReadCache(() => writeMute(request));
}

async function readMute(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const view = await readMuteView();
  return NextResponse.json(view);
}

async function writeMute(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "muted must be true or false" }, { status: 400 });
  }
  const muted = body && typeof body === "object" && !Array.isArray(body) ? (body as { muted?: unknown }).muted : undefined;
  if (muted !== true && muted !== false) {
    return NextResponse.json({ ok: false, error: "muted must be true or false" }, { status: 400 });
  }
  const saved = await setTelegramMuted(muted);
  if (!saved) return NextResponse.json({ ok: false, error: "The mute setting could not be saved" }, { status: 503 });
  const view = await readMuteView();
  return NextResponse.json({ ok: true, ...view });
}
