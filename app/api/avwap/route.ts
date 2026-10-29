import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { loadAvwapPaperSection } from "@/app/lib/avwapPaperRun";

export const dynamic = "force-dynamic";

/**
 * Gap-day anchored VWAP paper log.
 * Session required. Read-only. Nothing here places an order or calls a broker.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const section = await loadAvwapPaperSection();
  return NextResponse.json(section);
}
