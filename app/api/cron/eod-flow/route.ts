import { NextRequest, NextResponse } from "next/server";
import { hasValidBearer } from "@/app/lib/auth";
import { runEodFlowJob } from "@/app/lib/eodFlowJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * End-of-day SPY, QQQ, NDX, and VIX option flow.
 * Vercel calls this at 20:20, 20:30, 20:40, and 20:50 UTC, and again an hour
 * later, on weekdays. Only the times that are 4:20, 4:30, 4:40, and 4:50pm
 * America/New_York run. Later fires continue a pass that hit the time budget.
 * A finished day does not collect again. Weekends are not scheduled. A full-day
 * NYSE holiday returns before any fetch. An early close still runs and is flagged.
 * ?manual=true skips the clock check and still requires the bearer token.
 * It does not run on a holiday.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handleEodFlowCron(request));
}

async function handleEodFlowCron(request: NextRequest) {
  if (!(await hasValidBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const manual = request.nextUrl.searchParams.get("manual") === "true";
  const result = await runEodFlowJob({ now: new Date(), manual });
  if (result.skipped) {
    return NextResponse.json({ skipped: result.skipped === "market holiday" ? "market holiday" : true, reason: result.reason });
  }
  const status = result.reason === "The private store is not configured, so the end-of-day flow was not saved." ? 500 : 200;
  return NextResponse.json(result, { status });
}
