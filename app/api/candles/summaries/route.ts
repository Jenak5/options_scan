import { NextRequest, NextResponse } from "next/server";
import { hasHealthBearer } from "@/app/lib/auth";
import { buildCandleSummaries } from "@/app/lib/candleStore";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Build one compact series file per contract from day blobs already stored.
 * Same bearer as /api/health. Safe to call again. A finished contract is not read again.
 * One call stays inside a 240s budget. Call again until remaining is 0.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handleSummaries(request));
}

export async function POST(request: NextRequest) {
  return withBlobReadCache(() => handleSummaries(request));
}

async function handleSummaries(request: NextRequest) {
  if (!(await hasHealthBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return NextResponse.json({ ok: false, reason: "Blob storage is not configured", processed: 0, remaining: 0 }, { status: 500 });
  }
  const result = await buildCandleSummaries();
  return NextResponse.json({ ok: !result.rateLimited, ...result });
}
