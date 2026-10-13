import { NextRequest, NextResponse } from "next/server";
import { hasHealthBearer } from "@/app/lib/auth";
import { runCandleJob } from "@/app/lib/candleJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One-time candle backfill from 2026-09-01.
 * Same bearer as /api/health: HEALTH_TOKEN, or CRON_SECRET when that is unset.
 * One call stores at most 50 contracts, or stops after about 240 seconds.
 * The JSON processed and remaining say how far this call got. Call again until remaining is 0.
 * A contract already backfilled is not fetched or rewritten.
 * Live scorecard exits are not recomputed.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handleBackfill(request));
}

export async function POST(request: NextRequest) {
  return withBlobReadCache(() => handleBackfill(request));
}

async function handleBackfill(request: NextRequest) {
  if (!(await hasHealthBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runCandleJob({ mode: "backfill", now: new Date() });
  const status = result.reason === "Blob storage is not configured" ? 500 : 200;
  return NextResponse.json(result, { status });
}
