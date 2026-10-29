import type { FlowRow } from "@/app/lib/flow";
import { isMarketDay } from "@/app/lib/marketHours";
import {
  applyUnusualScan,
  emptyUnusualBook,
  intervalsFromFlowRows,
  parseUnusualBook,
  serializeUnusualBook,
  type UnusualBook,
} from "@/app/lib/unusualFlow";
import { readUnusualBookText, updateUnusualBook } from "@/app/lib/schwabStore";

/**
 * Saved unusual-flow flags. The cron passes rows from the chain it already
 * scored. This module does not fetch, and it does not send Telegram.
 */

export async function readUnusualBook(): Promise<UnusualBook> {
  const text = await readUnusualBookText().catch(() => null);
  return parseUnusualBook(text);
}

export async function writeUnusualBook(book: UnusualBook): Promise<boolean> {
  const next = serializeUnusualBook(book);
  return updateUnusualBook(() => next);
}

/**
 * Score the contracts this cron already read, store new flags, and fill
 * 1, 3, and 5 trading-day marks when that symbol is in the same scan.
 * A holiday does not read or write. No chain or quote call is made here.
 */
export async function runUnusualFlowPass(input: {
  rows: readonly FlowRow[];
  watchlist: readonly string[];
  now: Date;
}): Promise<{ newFlags: number; outcomes: number; saved: boolean; skipped: "holiday" | null }> {
  if (!isMarketDay(input.now)) {
    return { newFlags: 0, outcomes: 0, saved: true, skipped: "holiday" };
  }
  const current = await readUnusualBook();
  const applied = applyUnusualScan({
    intervals: intervalsFromFlowRows(input.rows),
    watchlist: input.watchlist,
    book: current,
    now: input.now,
  });
  if (applied.skipped === "holiday") {
    return { newFlags: 0, outcomes: 0, saved: true, skipped: "holiday" };
  }
  if (!applied.changed) {
    return { newFlags: 0, outcomes: 0, saved: true, skipped: null };
  }
  const saved = await writeUnusualBook(applied.book);
  return { newFlags: applied.newFlags, outcomes: applied.outcomes, saved, skipped: null };
}

export function emptyBook(): UnusualBook {
  return emptyUnusualBook();
}
