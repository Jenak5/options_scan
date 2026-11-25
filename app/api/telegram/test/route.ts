import { NextRequest, NextResponse } from "next/server";
import { hasHealthBearer, isAuthorized } from "@/app/lib/auth";
import { deliverTelegramProbe } from "@/app/lib/avwapRepeatJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";
import { getTelegramWebhookSummary } from "@/app/lib/telegram";

export const dynamic = "force-dynamic";

/**
 * Admin check of the Got it path. Bearer HEALTH_TOKEN (same as /api/health), CRON_SECRET, or a session.
 * action=webhookinfo returns safe getWebhookInfo fields only.
 * action=send sends one TEST ONLY alert with the real button. It never repeats and opens no trade.
 */
export async function POST(request: NextRequest) {
  return withBlobReadCache(() => handleTest(request));
}

async function handleTest(request: NextRequest) {
  const allowed = (await hasHealthBearer(request)) || (await isAuthorized(request));
  if (!allowed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const action = await readAction(request);
  if (action === "webhookinfo") {
    const info = await getTelegramWebhookSummary();
    return NextResponse.json(info, { status: info.ok ? 200 : 502 });
  }
  if (action === "send") {
    const probe = await deliverTelegramProbe();
    if (!probe.sent) return NextResponse.json({ ok: false, error: "The test alert was not sent" }, { status: 502 });
    return NextResponse.json({
      ok: true,
      id: probe.id,
      saved: probe.saved,
      sentAt: probe.sentAt == null ? null : new Date(probe.sentAt).toISOString(),
    });
  }
  return NextResponse.json({ ok: false, error: "action must be send or webhookinfo" }, { status: 400 });
}

async function readAction(request: NextRequest): Promise<string | null> {
  const fromQuery = request.nextUrl.searchParams.get("action");
  if (fromQuery) return fromQuery;
  try {
    const body = (await request.json()) as { action?: unknown };
    return typeof body.action === "string" ? body.action : null;
  } catch {
    return null;
  }
}
