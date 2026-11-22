import {
  advanceAvwapShadows,
  avwapShadowSection,
  parseAvwapShadowBook,
  serializeAvwapShadowBook,
  type AvwapShadowAdvance,
  type AvwapShadowSection,
} from "@/app/lib/avwapShadow";
import { avwapSessionOpen, type AvwapPaperBook, type AvwapSnapshot } from "@/app/lib/avwapPaper";
import { readAvwapShadowText, resolveStoreKind, updateAvwapShadowBook } from "@/app/lib/schwabStore";

/**
 * Saves the two AVWAP shadow books on the same store as the live book.
 * It does not fetch quotes, call Schwab, or send Telegram. The live pass
 * hands it the snapshots it already built.
 */

export interface AvwapShadowRunResult {
  opened: number;
  closed: number;
  saved: boolean;
  byBook: AvwapShadowAdvance["byBook"];
}

export function formatAvwapShadowLog(result: AvwapShadowRunResult): string {
  const parts = (["skip-monday", "skip-before-945"] as const).map((id) => {
    const row = result.byBook[id];
    const noun = row.opened === 1 ? "entry" : "entries";
    return `${id} ${row.opened} new ${noun}, ${row.closed} closed`;
  });
  const saved = result.saved ? "saved" : "not saved";
  return `AVWAP shadow: ${parts.join("; ")} (${saved}, PAPER ONLY, no Telegram).`;
}

export async function loadAvwapShadowSection(): Promise<AvwapShadowSection> {
  const text = await readAvwapShadowText();
  const stored = resolveStoreKind() !== "unconfigured";
  return avwapShadowSection(parseAvwapShadowBook(text), stored);
}

/** One blob write. A failure here does not throw, so the live book and its alert still finish. */
export async function recordAvwapShadows(
  now: Date,
  snapshots: readonly AvwapSnapshot[],
  mainBook: AvwapPaperBook,
): Promise<string> {
  if (!avwapSessionOpen(now)) return "";
  try {
    let opened = 0;
    let closed = 0;
    let byBook: AvwapShadowAdvance["byBook"] = {
      "skip-monday": { opened: 0, closed: 0 },
      "skip-before-945": { opened: 0, closed: 0 },
    };
    const saved = await updateAvwapShadowBook((text) => {
      const advanced = advanceAvwapShadows(parseAvwapShadowBook(text), snapshots, mainBook, now);
      opened = advanced.opened;
      closed = advanced.closed;
      byBook = advanced.byBook;
      return serializeAvwapShadowBook(advanced.book);
    });
    return formatAvwapShadowLog({ opened, closed, saved, byBook });
  } catch {
    return "AVWAP shadow update failed";
  }
}
