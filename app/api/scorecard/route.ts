import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { emptyScanHealth, scanFreshness } from "@/app/lib/scanHealth";
import { readScanHealth } from "@/app/lib/schwabStore";
import { loadShadowPage, shadowCsv } from "@/app/lib/shadowStore";

export const dynamic = "force-dynamic";

/**
 * Shadow alert scorecard. Session required.
 * Read-only. Nothing here places an order or writes the trade log.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  if (request.nextUrl.searchParams.get("format") === "csv") {
    const csv = await shadowCsv();
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"alert-scorecard.csv\"",
      },
    });
  }

  const now = new Date();
  const [page, health] = await Promise.all([
    loadShadowPage(now),
    readScanHealth().catch(() => emptyScanHealth()),
  ]);
  return NextResponse.json({ ...page, freshness: scanFreshness(health) });
}
