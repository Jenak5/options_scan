import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { loadAvwapTrialSection } from "@/app/lib/avwapTrialRun";

export const dynamic = "force-dynamic";

/**
 * AMD, MSFT, and AMZN paper trial.
 * Session or bearer. Read-only. Nothing here places an order.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const section = await loadAvwapTrialSection();
  return NextResponse.json(section);
}
