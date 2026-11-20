import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { readScanPauseView, setScanPaused } from "@/app/lib/scanPause";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/** Read whether the 5-minute scan is limited to AVWAP. Session or bearer. */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => readPause(request));
}

/** Body: {"paused": true|false}. Session or bearer. The next cron uses it. */
export async function POST(request: NextRequest) {
  return withBlobReadCache(() => writePause(request));
}

async function readPause(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  return NextResponse.json(await readScanPauseView());
}

async function writePause(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "paused must be true or false" }, { status: 400 });
  }
  const paused = body && typeof body === "object" && !Array.isArray(body) ? (body as { paused?: unknown }).paused : undefined;
  if (paused !== true && paused !== false) {
    return NextResponse.json({ ok: false, error: "paused must be true or false" }, { status: 400 });
  }
  const saved = await setScanPaused(paused);
  if (!saved) return NextResponse.json({ ok: false, error: "The pause setting could not be saved" }, { status: 503 });
  const view = await readScanPauseView();
  return NextResponse.json({ ok: true, ...view });
}
