import { NextRequest, NextResponse } from "next/server";
import { hasValidBearer } from "@/app/lib/auth";
import { runGexJob } from "@/app/lib/gexJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Pre-market QQQ and SPY gamma levels.
 * Vercel calls this at 13:05 and 13:15 UTC, and again at 14:05 and 14:15 UTC,
 * on weekdays. Only the pair that is 9:05am and 9:15am America/New_York runs.
 * That is 8:05am and 8:15am Chicago. The later fire continues a pass that
 * hit the time budget. A finished morning does not collect again.
 * A full-day NYSE holiday returns before any fetch.
 * ?manual=true skips the clock check and still requires the bearer token.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handleGexCron(request));
}

async function handleGexCron(request: NextRequest) {
  if (!(await hasValidBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const manual = request.nextUrl.searchParams.get("manual") === "true";
  const result = await runGexJob({ now: new Date(), manual });
  if (result.skipped) {
    return NextResponse.json({ skipped: result.skipped === "market holiday" ? "market holiday" : true, reason: result.reason });
  }
  const status = result.reason === "The private store is not configured, so the gamma levels were not saved." ? 500 : 200;
  return NextResponse.json(result, { status });
}
