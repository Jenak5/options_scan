import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { getSchwabStatus, noteRefreshWindow } from "@/app/lib/schwab";

export const dynamic = "force-dynamic";

/** Connected / expired / days left. Never returns a token. */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  const status = await getSchwabStatus();
  await noteRefreshWindow(status);
  return NextResponse.json({
    configured: status.configured,
    storage: status.storage,
    connected: status.connected,
    accessExpired: status.accessExpired,
    refreshExpired: status.refreshExpired,
    refreshDaysLeft: status.refreshDaysLeft,
    warnRefreshSoon: status.warnRefreshSoon,
    message: status.message,
  });
}
