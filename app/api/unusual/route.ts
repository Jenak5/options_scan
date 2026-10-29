import { NextResponse } from "next/server";
import { chicagoDate } from "@/app/lib/marketHours";
import {
  UNUSUAL_PAGE_NOTE,
  unusualFlowHealth,
  unusualThresholds,
} from "@/app/lib/unusualFlow";
import { readUnusualBook } from "@/app/lib/unusualFlowStore";

export const dynamic = "force-dynamic";

/**
 * Flags the scan already stored. Session cookie, same as the other pages.
 * This route does not fetch a chain, place an order, or send Telegram.
 */
export async function GET() {
  const now = new Date();
  const book = await readUnusualBook();
  return NextResponse.json({
    note: UNUSUAL_PAGE_NOTE,
    tradingDay: chicagoDate(now),
    thresholds: unusualThresholds(),
    health: unusualFlowHealth(book, now),
    flags: book.flags,
  });
}
