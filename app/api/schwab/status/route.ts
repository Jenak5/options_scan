import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { connectionNotice, emptyScanHealth } from "@/app/lib/scanHealth";
import { getSchwabStatus, noteRefreshWindow } from "@/app/lib/schwab";
import { readScanHealth } from "@/app/lib/schwabStore";
import { tastytradeEnabled } from "@/app/lib/tastytrade";

export const dynamic = "force-dynamic";

/** Connected / expired / days left. Never returns a token. */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  const status = await getSchwabStatus();
  await noteRefreshWindow(status);
  const health = await readScanHealth().catch(() => emptyScanHealth());
  const now = Date.now();
  const notice = connectionNotice({
    configured: status.configured,
    connected: status.connected,
    refreshExpired: status.refreshExpired,
    warnRefreshSoon: status.warnRefreshSoon,
    refreshDaysLeft: status.refreshDaysLeft,
    now,
    health,
    showTastytrade: tastytradeEnabled(),
  });
  return NextResponse.json({
    configured: status.configured,
    storage: status.storage,
    storageWarning: status.storageWarning,
    connected: status.connected,
    accessExpired: status.accessExpired,
    refreshExpired: status.refreshExpired,
    refreshDaysLeft: status.refreshDaysLeft,
    warnRefreshSoon: status.warnRefreshSoon,
    message: status.message,
    notice,
    scan: {
      lastSuccessAt: health.lastSuccessAt,
      lastRunAt: health.lastRunAt,
      lastOutcome: health.lastOutcome,
      lastReason: health.lastReason,
      tastytradeOk: health.tastytradeOk,
      tastytradeStatus: health.tastytradeStatus,
      tastytradeMessage: health.tastytradeMessage,
    },
  });
}
