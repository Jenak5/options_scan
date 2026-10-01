import { NextRequest, NextResponse } from "next/server";
import { loadAlertReport } from "@/app/lib/alertStore";
import { denyIfUnauthorized } from "@/app/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Saved alerts, checkpoint mids, and the checklist grade.
 * Session required. Read-only. No broker order endpoint.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const report = await loadAlertReport();
  return NextResponse.json(report);
}
