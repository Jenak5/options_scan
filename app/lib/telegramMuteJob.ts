import { chicagoDate } from "@/app/lib/marketHours";
import { readTelegramMute, updateTelegramMute } from "@/app/lib/schwabStore";
import { sendTelegramAlert } from "@/app/lib/telegram";
import {
  effectiveMuted,
  emptyMuteBook,
  parseMuteBook,
  planFailureNotices,
  revertFailureNotice,
  telegramLogLine,
  telegramMuteForcedOff,
  withMutedLine,
  mutedOnDay,
  type FailureKind,
  type FailureNotice,
  type MuteBook,
} from "@/app/lib/telegramMute";

const memoryWarnings = new Map<FailureKind, { lastSentAt: number; open: boolean }>();

export function clearTelegramWarningMemoryForTests(): void {
  memoryWarnings.clear();
}

export interface MuteView {
  muted: boolean;
  forced: boolean;
  storeUnreadable: boolean;
  mutedToday: number;
}

export async function allowOtherTelegram(message: string, nowMs: number = Date.now()): Promise<boolean> {
  if (telegramMuteForcedOff()) return true;
  const read = await readTelegramMute();
  if (read.state === "unreadable") {
    console.info(`Telegram muted: ${telegramLogLine(message)}`);
    await noteScannerFlags({ "mute-store": true }, nowMs);
    return false;
  }
  const book = parseMuteBook(read.text);
  if (!book) {
    console.info(`Telegram muted: ${telegramLogLine(message)}`);
    await noteScannerFlags({ "mute-store": true }, nowMs);
    return false;
  }
  if (effectiveMuted(book, false)) {
    console.info(`Telegram muted: ${telegramLogLine(message)}`);
    await updateTelegramMute((current) => {
      const parsed = parseMuteBook(current);
      if (!parsed) return null;
      return JSON.stringify(withMutedLine(parsed, nowMs, message));
    });
    await noteScannerFlags({ "mute-store": false }, nowMs);
    return false;
  }
  await noteScannerFlags({ "mute-store": false }, nowMs);
  return true;
}

export async function readMuteView(now: Date = new Date()): Promise<MuteView> {
  const forced = telegramMuteForcedOff();
  const read = await readTelegramMute();
  if (read.state === "unreadable") {
    return { muted: !forced, forced, storeUnreadable: true, mutedToday: 0 };
  }
  const book = parseMuteBook(read.text);
  if (!book) return { muted: !forced, forced, storeUnreadable: true, mutedToday: 0 };
  return {
    muted: effectiveMuted(book, forced),
    forced,
    storeUnreadable: false,
    mutedToday: mutedOnDay(book, chicagoDate(now), (at) => chicagoDate(new Date(at))),
  };
}

export async function setTelegramMuted(muted: boolean): Promise<boolean> {
  return updateTelegramMute((current) => {
    const book = parseMuteBook(current) ?? emptyMuteBook();
    return JSON.stringify({ ...book, muted });
  });
}

export async function noteScannerFlags(
  states: Partial<Record<FailureKind, boolean>>,
  nowMs: number = Date.now(),
): Promise<void> {
  const read = await readTelegramMute();
  if (read.state === "unreadable" || !parseMuteBook(read.state === "ok" ? read.text : null)) {
    await sendMemoryNotices(states, nowMs);
    return;
  }
  let notices: FailureNotice[] = [];
  const saved = await updateTelegramMute((current) => {
    const book = parseMuteBook(current);
    if (!book) return null;
    const planned = planFailureNotices(book, nowMs, states);
    notices = planned.notices;
    return JSON.stringify(planned.book);
  });
  if (!saved) {
    await sendMemoryNotices(states, nowMs);
    return;
  }
  for (let i = 0; i < notices.length; i++) {
    const notice = notices[i];
    const sent = await sendTelegramAlert(notice.text, "system");
    if (sent) continue;
    await updateTelegramMute((current) => {
      const book = parseMuteBook(current);
      if (!book) return null;
      return JSON.stringify(revertFailureNotice(book, notice));
    });
  }
}

async function sendMemoryNotices(states: Partial<Record<FailureKind, boolean>>, nowMs: number): Promise<void> {
  const kinds = Object.keys(states) as FailureKind[];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const active = states[kind] === true;
    const book = memoryBook();
    const planned = planFailureNotices(book, nowMs, { [kind]: active });
    if (planned.notices.length === 0) continue;
    const sent = await sendTelegramAlert(planned.notices[0].text, "system");
    if (!sent) continue;
    const mark = planned.book.warnings[kind];
    if (mark) memoryWarnings.set(kind, mark);
    else memoryWarnings.delete(kind);
  }
}

function memoryBook(): MuteBook {
  const warnings: MuteBook["warnings"] = {};
  memoryWarnings.forEach((mark, kind) => {
    warnings[kind] = mark;
  });
  return { version: 1, muted: null, log: [], warnings };
}

