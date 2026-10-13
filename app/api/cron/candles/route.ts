import { NextRequest, NextResponse } from "next/server";
import { hasValidBearer } from "@/app/lib/auth";
import { runCandleJob } from "@/app/lib/candleJob";
import { candleCronDecision } from "@/app/lib/candleTargets";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * After-close 1-minute option candles.
 * Vercel calls this at 20:30 UTC and 21:30 UTC on weekdays. Only one of those
 * is 3:30pm America/Chicago, depending on daylight time. The other returns
 * before any Tastytrade or Blob write. A market holiday returns before both.
 * ?manual=true skips the clock check and still requires the bearer token.
 * One call stores at most 50 contracts, or stops after about 240 seconds, and
 * returns processed and remaining. Live scorecard exits are not recomputed here.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handleCandleCron(request));
}

async function handleCandleCron(request: NextRequest) {
  if (!(await hasValidBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const manual = request.nextUrl.searchParams.get("manual") === "true";
  const decision = candleCronDecision(now, manual);
  if (!decision.run) {
    return NextResponse.json({ skipped: decision.reason === "market holiday" ? "market holiday" : true, reason: decision.reason });
  }
  const result = await runCandleJob({ mode: "daily", now });
  return NextResponse.json(result, { status: result.reason === "Blob storage is not configured" ? 500 : 200 });
}
