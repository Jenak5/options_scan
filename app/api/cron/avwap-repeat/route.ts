import { NextRequest, NextResponse } from "next/server";
import { repeatPassDue, runAvwapRepeatPass } from "@/app/lib/avwapRepeatJob";
import { hasValidBearer } from "@/app/lib/auth";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Re-sends unacknowledged AVWAP trade-open alerts.
 * Vercel calls this every minute from 13:00 through 21:59 UTC on weekdays.
 * The route only sends while the New York cash session is open, 9:30am to 4:00pm.
 * After 4:00pm New York, a pass records the stop and does not send.
 */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => handleAvwapRepeat(request));
}

async function handleAvwapRepeat(request: NextRequest) {
  if (!(await hasValidBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const session = repeatPassDue(now);
  const result = await runAvwapRepeatPass();
  return NextResponse.json({ ok: true, session, sent: result.sent });
}
