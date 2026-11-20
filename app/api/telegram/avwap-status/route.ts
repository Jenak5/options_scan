import { NextRequest, NextResponse } from "next/server";
import { avwapStatusRows, emptyAvwapRepeatBook, parseAvwapRepeatBook } from "@/app/lib/avwapRepeat";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { readAvwapRepeatText, withBlobReadCache } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/** Last 20 AVWAP repeat alerts. No message text. Session or bearer. */
export async function GET(request: NextRequest) {
  return withBlobReadCache(() => readStatus(request));
}

async function readStatus(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  const text = await readAvwapRepeatText();
  const book = parseAvwapRepeatBook(text);
  if (text != null && text.trim() !== "" && !book) {
    return NextResponse.json({ alerts: [], unreadable: true });
  }
  return NextResponse.json({ alerts: avwapStatusRows(book ?? emptyAvwapRepeatBook()), unreadable: false });
}
