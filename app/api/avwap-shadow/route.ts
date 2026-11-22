import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { loadAvwapShadowSection } from "@/app/lib/avwapShadowRun";

export const dynamic = "force-dynamic";

/**
 * Shadow AVWAP paper books. Session or bearer. Read-only.
 * Nothing here places an order or sends Telegram.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const section = await loadAvwapShadowSection();
  return NextResponse.json(section);
}
