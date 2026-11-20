import { readScanPauseState, readScanPauseText, updateScanPause } from "@/app/lib/schwabStore";

/**
 * Pause switch for the 5-minute scan.
 * Null or a missing document means paused: only AVWAP work runs.
 * SCAN_PAUSE_NON_AVWAP=0 forces the full scan on.
 */

export interface ScanPauseBook {
  version: 1;
  /** null means the default, which is paused. */
  paused: boolean | null;
}

export interface ScanPauseView {
  paused: boolean;
  forced: boolean;
  storeUnreadable: boolean;
}

export function emptyScanPauseBook(): ScanPauseBook {
  return { version: 1, paused: null };
}

export function scanPauseForcedOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.SCAN_PAUSE_NON_AVWAP === "0";
}

export function effectiveScanPaused(book: ScanPauseBook | null, forcedOff: boolean): boolean {
  if (forcedOff) return false;
  if (!book || book.paused == null) return true;
  return book.paused;
}

export function parseScanPauseBook(text: string | null): ScanPauseBook | null {
  if (text == null || text.trim() === "") return emptyScanPauseBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  return {
    version: 1,
    paused: row.paused === true ? true : row.paused === false ? false : null,
  };
}

export async function nonAvwapScanPaused(): Promise<boolean> {
  const view = await readScanPauseView();
  return view.paused;
}

export async function readScanPauseView(): Promise<ScanPauseView> {
  const forced = scanPauseForcedOff();
  const state = await readScanPauseState();
  if (state === "unreadable") return { paused: !forced, forced, storeUnreadable: true };
  const book = parseScanPauseBook(await readScanPauseText());
  if (!book) return { paused: !forced, forced, storeUnreadable: true };
  return { paused: effectiveScanPaused(book, forced), forced, storeUnreadable: false };
}

export async function setScanPaused(paused: boolean): Promise<boolean> {
  return updateScanPause((current) => {
    const book = parseScanPauseBook(current) ?? emptyScanPauseBook();
    return JSON.stringify({ ...book, paused });
  });
}
