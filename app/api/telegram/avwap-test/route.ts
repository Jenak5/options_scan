import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { AVWAP_TEST_ALERT_TEXT, avwapRepeatsEnabled, deliverAvwapOpenAlert } from "@/app/lib/avwapRepeatJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Sends one labeled AVWAP-style test through the repeat path.
 * Does not open a paper trade and does not write the AVWAP book.
 */
export async function POST(request: NextRequest) {
  return withBlobReadCache(() => handleAvwapTest(request));
}

async function handleAvwapTest(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  if (!avwapRepeatsEnabled()) {
    return NextResponse.json({ ok: false, error: "AVWAP repeats are off until TELEGRAM_WEBHOOK_SECRET is set" }, { status: 400 });
  }
  const sent = await deliverAvwapOpenAlert(AVWAP_TEST_ALERT_TEXT, null);
  if (!sent.sent) return NextResponse.json({ ok: false, error: "The test alert was not sent" }, { status: 502 });
  if (!sent.saved) return NextResponse.json({ ok: false, error: "The test alert was sent once and was not saved, so it will not repeat" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
