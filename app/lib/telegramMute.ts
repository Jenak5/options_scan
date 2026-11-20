/**
 * Which Telegram messages still go out, and when a scanner failure is worth one warning.
 * AVWAP trade-open alerts and scanner warnings are never muted.
 */

export type TelegramCategory = "avwap" | "system" | "other";

export type FailureKind = "feed" | "scan" | "avwap" | "store" | "mute-store";

export const TELEGRAM_WARN_GAP_MS = 60 * 60 * 1000;
export const TELEGRAM_MUTE_LOG_LIMIT = 50;

export const FAILURE_KINDS: readonly FailureKind[] = ["feed", "scan", "avwap", "store", "mute-store"];

export interface MuteLogEntry {
  at: number;
  text: string;
}

export interface WarningMark {
  lastSentAt: number;
  open: boolean;
}

export interface MuteBook {
  version: 1;
  /** null means the default, which is muted. */
  muted: boolean | null;
  log: MuteLogEntry[];
  warnings: Partial<Record<FailureKind, WarningMark>>;
}

export interface ScannerWarningInput {
  outcome: "success" | "partial" | "skipped" | "failed";
  reason: string | null;
  rowsScanned: number;
  preferred: "tastytrade" | "schwab";
  /** Schwab is the only source and this run could not use it. */
  schwabOnlyFailure: boolean;
  bothSourcesFailed: boolean;
  avwapFailed: boolean;
  storeUnsaved: boolean;
}

export interface FailureNotice {
  kind: FailureKind;
  text: string;
  /** Previous mark, so a failed send can put it back. */
  previous: WarningMark | null;
}

export function emptyMuteBook(): MuteBook {
  return { version: 1, muted: null, log: [], warnings: {} };
}

/** TELEGRAM_MUTE_OTHER=0 forces every category on. Any other value keeps the stored default. */
export function telegramMuteForcedOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.TELEGRAM_MUTE_OTHER === "0";
}

export function categorySends(category: TelegramCategory, muted: boolean): boolean {
  if (category === "avwap" || category === "system") return true;
  return !muted;
}

/** First line only, tags removed, capped so a log line cannot carry a long body. */
export function telegramLogLine(message: string): string {
  const plain = message.replace(/<[^>]*>/g, " ");
  const line = plain.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.replace(/\s+/g, " ").slice(0, 180);
}

export function parseMuteBook(text: string | null): MuteBook | null {
  if (text == null || text.trim() === "") return emptyMuteBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.log)) return null;
  const log: MuteLogEntry[] = [];
  for (let i = 0; i < record.log.length; i++) {
    const row = record.log[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    if (typeof item.at !== "number" || typeof item.text !== "string") continue;
    log.push({ at: item.at, text: item.text.slice(0, 180) });
  }
  const warnings: Partial<Record<FailureKind, WarningMark>> = {};
  const rawWarnings = record.warnings;
  if (rawWarnings && typeof rawWarnings === "object" && !Array.isArray(rawWarnings)) {
    const bag = rawWarnings as Record<string, unknown>;
    for (let i = 0; i < FAILURE_KINDS.length; i++) {
      const kind = FAILURE_KINDS[i];
      const mark = bag[kind];
      if (!mark || typeof mark !== "object" || Array.isArray(mark)) continue;
      const row = mark as Record<string, unknown>;
      if (typeof row.lastSentAt !== "number") continue;
      warnings[kind] = { lastSentAt: row.lastSentAt, open: row.open === true };
    }
  }
  return {
    version: 1,
    muted: record.muted === true ? true : record.muted === false ? false : null,
    log: log.slice(-TELEGRAM_MUTE_LOG_LIMIT),
    warnings,
  };
}

export function withMutedLine(book: MuteBook, at: number, message: string): MuteBook {
  const log = book.log.concat({ at, text: telegramLogLine(message) }).slice(-TELEGRAM_MUTE_LOG_LIMIT);
  return { ...book, log };
}

export function mutedOnDay(book: MuteBook, day: string | null, dayOf: (at: number) => string | null): number {
  if (!day) return 0;
  let count = 0;
  for (let i = 0; i < book.log.length; i++) {
    if (dayOf(book.log[i].at) === day) count += 1;
  }
  return count;
}

export function effectiveMuted(book: MuteBook | null, forcedOff: boolean): boolean {
  if (forcedOff) return false;
  if (!book || book.muted == null) return true;
  return book.muted;
}

/**
 * Feed is down only when the primary source cannot be used and the backup cannot cover it.
 * A Schwab outage while Tastytrade is primary does not count.
 * A failed scan, a skip, a time budget that scored nothing, a thrown AVWAP check, or a missed save do count.
 */
export function classifyScannerWarnings(input: ScannerWarningInput): Partial<Record<FailureKind, boolean>> {
  const schwabBackupNoise = input.preferred === "tastytrade" && input.schwabOnlyFailure && !input.bothSourcesFailed;
  const dataText = /market data|tastytrade/i.test(input.reason ?? "");
  const feed = schwabBackupNoise
    ? false
    : input.bothSourcesFailed
      || (input.preferred === "schwab" && input.schwabOnlyFailure)
      || (input.outcome === "failed" && input.preferred === "tastytrade" && dataText);
  const scan = input.outcome === "failed"
    || input.outcome === "skipped"
    || input.bothSourcesFailed
    || (input.reason === "time budget" && input.rowsScanned === 0);
  return {
    feed,
    scan,
    avwap: input.avwapFailed,
    store: input.storeUnsaved,
  };
}

export function warningText(kind: FailureKind): string {
  if (kind === "feed") return "Scanner warning: market data is not reading. AVWAP alerts may have stopped.";
  if (kind === "scan") return "Scanner warning: the scan did not finish. AVWAP alerts may have stopped.";
  if (kind === "avwap") return "Scanner warning: the AVWAP paper check failed. AVWAP alerts may have stopped.";
  if (kind === "store") return "Scanner warning: the scanner could not save. AVWAP alerts may have stopped.";
  return "Scanner warning: alert settings could not be read. Non-AVWAP Telegram alerts stay off.";
}

export function recoveredText(kind: FailureKind): string {
  if (kind === "feed") return "Scanner recovered: market data is reading again.";
  if (kind === "scan") return "Scanner recovered: the scan is finishing again.";
  if (kind === "avwap") return "Scanner recovered: the AVWAP paper check is running again.";
  if (kind === "store") return "Scanner recovered: the scanner can save again.";
  return "Scanner recovered: alert settings can be read again.";
}

/** One warning per kind per hour, and one recovered message when that kind clears. */
export function planFailureNotices(
  book: MuteBook,
  nowMs: number,
  states: Partial<Record<FailureKind, boolean>>,
): { book: MuteBook; notices: FailureNotice[] } {
  const warnings: Partial<Record<FailureKind, WarningMark>> = { ...book.warnings };
  const notices: FailureNotice[] = [];
  for (let i = 0; i < FAILURE_KINDS.length; i++) {
    const kind = FAILURE_KINDS[i];
    if (states[kind] === undefined) continue;
    const previous = warnings[kind] ?? null;
    const active = states[kind] === true;
    if (active) {
      const due = !previous?.open || nowMs - previous.lastSentAt >= TELEGRAM_WARN_GAP_MS;
      if (!due) continue;
      warnings[kind] = { lastSentAt: nowMs, open: true };
      notices.push({ kind, text: warningText(kind), previous });
      continue;
    }
    if (previous?.open) {
      warnings[kind] = { lastSentAt: previous.lastSentAt, open: false };
      notices.push({ kind, text: recoveredText(kind), previous });
    }
  }
  return { book: { ...book, warnings }, notices };
}

export function revertFailureNotice(book: MuteBook, notice: FailureNotice): MuteBook {
  const warnings = { ...book.warnings };
  if (notice.previous) warnings[notice.kind] = notice.previous;
  else delete warnings[notice.kind];
  return { ...book, warnings };
}
