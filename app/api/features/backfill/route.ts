import { NextRequest, NextResponse } from "next/server";
import { hasHealthBearer } from "@/app/lib/auth";
import { parseTickerParam, runFeatureBackfill } from "@/app/lib/featureBackfillStore";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Fill unknown grading inputs on past alerts from Tastytrade price history.
 * ?tickers=AAPL,NVDA limits a run to those alerts (SPY and QQQ are always read).
 * Same bearer as /api/health. Dry run unless ?apply=1 is passed, and apply only works on POST.
 * Fields saved at send time are never replaced. Filled fields are listed in features.backfilled.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handle(request, false));
}

export async function POST(request: NextRequest) {
  return withBlobReadCache(() => handle(request, request.nextUrl.searchParams.get("apply") === "1"));
}

async function handle(request: NextRequest, apply: boolean) {
  if (!(await hasHealthBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tickers = parseTickerParam(request.nextUrl.searchParams.get("tickers"));
  const result = await runFeatureBackfill({ apply, now: new Date(), tickers });
  return NextResponse.json(result);
}
