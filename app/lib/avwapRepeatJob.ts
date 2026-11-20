import {
  acknowledgeAvwapAlert,
  acknowledgeByMessageId,
  acknowledgeOldestOpen,
  acknowledgedText,
  addOpenAlert,
  avwapLogPreview,
  avwapRepeatSecretSet,
  avwapStopReason,
  avwapRepeatSessionOpen,
  callbackDataFor,
  emptyAvwapRepeatBook,
  newAvwapAlertId,
  parseAvwapRepeatBook,
  planAvwapRepeats,
  recordRepeatMessage,
  repeatBanner,
  revertRepeatClaim,
  telegramAckIntent,
  updateChatId,
  type AvwapAckVia,
  type AvwapRepeatBook,
  type AvwapRepeatStop,
  type RepeatClaim,
} from "@/app/lib/avwapRepeat";
import { parseAvwapPaperBook } from "@/app/lib/avwapPaper";
import { timingSafeEqual } from "@/app/lib/auth";
import { readAvwapPaperBookText, readAvwapRepeatText, updateAvwapRepeat } from "@/app/lib/schwabStore";
import {
  answerTelegramCallback,
  editTelegramMessage,
  sendTelegramAlertWithButton,
  type TelegramSendResult,
} from "@/app/lib/telegram";

const LOCK_MS = 60_000;

export const AVWAP_TEST_ALERT_TEXT = "TEST - not a real alert, no trade\nAVWAP style reminder. No paper trade was opened.";

export interface AvwapRepeatIo {
  now: () => number;
  read: () => Promise<string | null>;
  write: (change: (current: string | null) => string | null) => Promise<boolean>;
  closedTradeIds: () => Promise<ReadonlySet<string>>;
  send: (message: string, callbackData: string) => Promise<TelegramSendResult>;
  edit: (messageId: number, text: string) => Promise<boolean>;
  answer: (callbackId: string) => Promise<boolean>;
}

export function avwapRepeatsEnabled(): boolean {
  return avwapRepeatSecretSet();
}

export async function deliverAvwapOpenAlert(
  text: string,
  tradeId: string | null,
  io: AvwapRepeatIo = defaultIo(),
): Promise<{ sent: boolean; saved: boolean }> {
  if (!avwapRepeatsEnabled()) return { sent: false, saved: false };
  const id = newAvwapAlertId(io.now());
  const callback = callbackDataFor(id);
  if (!callback) return { sent: false, saved: false };
  const sent = await io.send(text, callback);
  if (!sent.ok) return { sent: false, saved: false };
  const now = io.now();
  const saved = await io.write((current) => {
    const book = parseAvwapRepeatBook(current);
    if (!book) return null;
    const next = addOpenAlert(book, {
      id,
      tradeId,
      isTest: tradeId == null,
      text,
      firstSentAt: now,
      repeatsSent: 0,
      lastSentAt: now,
      acknowledged: false,
      acknowledgedAt: null,
      ackVia: null,
      messageIds: sent.messageId == null ? [] : [sent.messageId],
      stop: null,
      claimToken: null,
    }, now);
    return JSON.stringify(next);
  });
  if (saved) console.info(`AVWAP pending alert ${id} test=${tradeId == null ? "yes" : "no"} "${avwapLogPreview(text)}"`);
  return { sent: true, saved };
}

export async function runAvwapRepeatPass(io: AvwapRepeatIo = defaultIo()): Promise<{ sent: number; stopped: number }> {
  if (!avwapRepeatsEnabled()) return { sent: 0, stopped: 0 };
  const nowMs = io.now();
  const token = newAvwapAlertId(nowMs);
  let claims: RepeatClaim[] = [];
  let stopLogs: Array<{ id: string; reason: string }> = [];
  const closed = await io.closedTradeIds();
  const saved = await io.write((current) => {
    const book = parseAvwapRepeatBook(current);
    if (!book) return null;
    stopLogs = [];
    if (book.lockUntil != null && book.lockUntil > nowMs) {
      claims = claimsOwnedBy(book, token);
      return current ?? JSON.stringify(book);
    }
    const planned = planAvwapRepeats(book, nowMs, closed, token);
    planned.book.lockUntil = planned.claims.length > 0 ? nowMs + LOCK_MS : null;
    claims = planned.claims;
    stopLogs = freshStops(book, planned.book);
    return JSON.stringify(planned.book);
  });
  if (!saved) return { sent: 0, stopped: 0 };
  for (let i = 0; i < stopLogs.length; i++) {
    console.info(`AVWAP repeats stopped ${stopLogs[i].id} reason ${stopLogs[i].reason}`);
  }
  const storedText = await io.read();
  const stored = parseAvwapRepeatBook(storedText) ?? emptyAvwapRepeatBook();
  const mine = claims.filter((claim) => ownsClaim(stored, claim, token));
  let sent = 0;
  for (let i = 0; i < mine.length; i++) {
    const claim = mine[i];
    const callback = callbackDataFor(claim.id);
    const result = callback ? await io.send(claim.text, callback) : { ok: false, messageId: null };
    if (!result.ok) {
      await io.write((current) => {
        const book = parseAvwapRepeatBook(current);
        if (!book) return null;
        return JSON.stringify(clearLock(revertRepeatClaim(book, claim)));
      });
      continue;
    }
    sent += 1;
    console.info(`AVWAP repeat ${claim.repeatNumber} of 5 for ${claim.id} "${avwapLogPreview(claim.text)}"`);
    if (claim.repeatNumber >= 5) console.info(`AVWAP repeats stopped ${claim.id} reason 5 repeats sent`);
    await io.write((current) => {
      const book = parseAvwapRepeatBook(current);
      if (!book) return null;
      return JSON.stringify(clearLock(recordRepeatMessage(book, claim.id, result.messageId)));
    });
  }
  if (mine.length === 0) {
    await io.write((current) => {
      const book = parseAvwapRepeatBook(current);
      if (!book || book.lockUntil == null) return current;
      if (book.alerts.some((alert) => alert.claimToken === token)) return JSON.stringify(clearLock(book));
      return current;
    });
  }
  const stopped = stored.alerts.filter((alert) => alert.stop != null).length;
  return { sent, stopped };
}

export async function acknowledgeFromTelegram(update: unknown, chatId: string, io: AvwapRepeatIo = defaultIo()): Promise<"ack" | "ignore" | "reject"> {
  const incoming = updateChatId(update);
  if (!incoming || !(await timingSafeEqual(incoming, chatId))) return "reject";
  const intent = telegramAckIntent(update);
  if (intent.type === "ignore") return "ignore";
  if (intent.type === "callback") await io.answer(intent.callbackId);
  let edited: { text: string; messageIds: number[]; id: string; via: AvwapAckVia } | null = null;
  const nowMs = io.now();
  await io.write((current) => {
    const book = parseAvwapRepeatBook(current);
    if (!book) return null;
    const result = applyIntent(book, intent, nowMs);
    if (!result.alert) return current ?? JSON.stringify(book);
    edited = {
      text: acknowledgedText(result.alert.text),
      messageIds: result.alert.messageIds.slice(),
      id: result.alert.id,
      via: result.alert.ackVia ?? "button",
    };
    return JSON.stringify(result.book);
  });
  if (!edited) return "ignore";
  const note = edited as { text: string; messageIds: number[]; id: string; via: AvwapAckVia };
  console.info(`AVWAP ack ${note.id} via ${note.via}`);
  console.info(`AVWAP repeats stopped ${note.id} reason acknowledged`);
  for (let i = 0; i < note.messageIds.length; i++) {
    await io.edit(note.messageIds[i], note.text);
  }
  return "ack";
}

function applyIntent(book: AvwapRepeatBook, intent: ReturnType<typeof telegramAckIntent>, nowMs: number) {
  if (intent.type === "callback") return acknowledgeAvwapAlert(book, intent.alertId, nowMs, "button");
  if (intent.type === "reply") return acknowledgeByMessageId(book, intent.messageId, nowMs, "reply");
  if (intent.type === "word") return acknowledgeOldestOpen(book, nowMs);
  return { book, alert: null };
}

function freshStops(before: AvwapRepeatBook, after: AvwapRepeatBook): Array<{ id: string; reason: string }> {
  const logs: Array<{ id: string; reason: string }> = [];
  for (let i = 0; i < after.alerts.length; i++) {
    const alert = after.alerts[i];
    if (alert.stop !== "closed" && alert.stop !== "close") continue;
    const prior = before.alerts.find((row) => row.id === alert.id);
    if (prior?.stop === alert.stop) continue;
    const reason = avwapStopReason(alert.stop as AvwapRepeatStop);
    if (reason) logs.push({ id: alert.id, reason });
  }
  return logs;
}

function claimsOwnedBy(book: AvwapRepeatBook, token: string): RepeatClaim[] {
  return book.alerts
    .filter((alert) => alert.claimToken === token)
    .map((alert) => ({
      id: alert.id,
      text: `${repeatBanner(alert.repeatsSent)}${alert.text}`,
      repeatNumber: alert.repeatsSent,
      previousLastSentAt: alert.lastSentAt,
      claimedAt: alert.lastSentAt,
    }));
}

function ownsClaim(book: AvwapRepeatBook, claim: RepeatClaim, token: string): boolean {
  const alert = book.alerts.find((row) => row.id === claim.id);
  return Boolean(alert && alert.claimToken === token && alert.lastSentAt === claim.claimedAt && alert.repeatsSent === claim.repeatNumber);
}

function clearLock(book: AvwapRepeatBook): AvwapRepeatBook {
  if (!book.alerts.some((alert) => alert.claimToken)) return { ...book, lockUntil: null };
  return book;
}

function defaultIo(): AvwapRepeatIo {
  return {
    now: () => Date.now(),
    read: readAvwapRepeatText,
    write: updateAvwapRepeat,
    closedTradeIds: closedAvwapTradeIds,
    send: sendTelegramAlertWithButton,
    edit: editTelegramMessage,
    answer: answerTelegramCallback,
  };
}

async function closedAvwapTradeIds(): Promise<ReadonlySet<string>> {
  const book = parseAvwapPaperBook(await readAvwapPaperBookText());
  const ids = new Set<string>();
  for (let i = 0; i < book.trades.length; i++) {
    if (book.trades[i].status === "closed") ids.add(book.trades[i].id);
  }
  return ids;
}

export function repeatPassDue(now: Date): boolean {
  return avwapRepeatSessionOpen(now);
}
