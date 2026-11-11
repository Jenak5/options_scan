import { NextRequest, NextResponse } from "next/server";
import { hasValidBearer } from "@/app/lib/auth";
import { deliverDailyNote } from "@/app/lib/dayTally";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Once-per-weekday Telegram note, about 3:05pm America/Chicago.
 * Vercel calls this at 20:05 UTC and 21:05 UTC on weekdays. Only one of those
 * is 3:05pm Central, depending on daylight time. The other returns before
 * any send. A market holiday returns before both. The note reads the day's
 * scan tally and does not call Schwab, so a dead Schwab login cannot block it.
 * A second call the same Chicago day does not send again.
 * ?manual=true skips the clock check and still requires the bearer token.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handleDailyNote(request));
}

async function handleDailyNote(request: NextRequest) {
  if (!(await hasValidBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const manual = request.nextUrl.searchParams.get("manual") === "true";
  const result = await deliverDailyNote(new Date(), manual);
  if (result.sent) return NextResponse.json(result);
  const status = result.reason === "Telegram did not accept the note" ? 502 : 200;
  return NextResponse.json({ skipped: true, reason: result.reason, note: result.note ?? null }, { status });
}
