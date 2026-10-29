import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { loadCallsPaperSection } from "@/app/lib/callsPaperRun";

export const dynamic = "force-dynamic";

/**
 * Flush-then-reclaim call paper log.
 * Session required. Read-only. Nothing here places an order or calls a broker.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const section = await loadCallsPaperSection();
  return NextResponse.json(section);
}
