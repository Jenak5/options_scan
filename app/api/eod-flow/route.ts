import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { loadEodPage } from "@/app/lib/eodFlowJob";
import { withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/** Stored end-of-day QQQ and NDX flow. Session required. Read-only. */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  return withBlobReadCache(async () => {
    const page = await loadEodPage();
    return NextResponse.json(page);
  });
}
