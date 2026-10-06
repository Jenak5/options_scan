import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { learnCsv, loadLearnPage } from "@/app/lib/learnStore";
import { emptyScanHealth, scanFreshness } from "@/app/lib/scanHealth";
import { readScanHealth } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Learning mode. Session required.
 * Read-only. Nothing here places an order, reads a chain, or changes a rule.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  const now = new Date();
  if (request.nextUrl.searchParams.get("format") === "csv") {
    const csv = await learnCsv(now);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"learning-features.csv\"",
      },
    });
  }

  const [page, health] = await Promise.all([
    loadLearnPage(now),
    readScanHealth().catch(() => emptyScanHealth()),
  ]);
  return NextResponse.json({ ...page, freshness: scanFreshness(health) });
}
