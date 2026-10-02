import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { readAlertBookNotice } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Last alert-book failure, for the Trade Log and Alert Report.
 * Session required. The payload has no token and no blob pathname.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  return NextResponse.json(await readAlertBookNotice());
}
