import { newYorkDate } from "@/app/lib/flow";
import { isMarketDay, isNewYorkMinuteWindow } from "@/app/lib/marketHours";

/**
 * Repeat rules for one AVWAP trade-open Telegram alert.
 * Other alert types do not use this book.
 */

export const AVWAP_REPEAT_GAP_MS = 110_000;
export const AVWAP_REPEAT_MAX = 5;
export const AVWAP_REPEAT_OPEN_MINUTE = 9 * 60 + 30;
export const AVWAP_REPEAT_CLOSE_MINUTE = 16 * 60;

export type AvwapRepeatStop = "ack" | "repeats" | "closed" | "close";

export interface AvwapPendingAlert {
  id: string;
  tradeId: string | null;
  text: string;
  firstSentAt: number;
  repeatsSent: number;
  lastSentAt: number;
  acknowledged: boolean;
  messageIds: number[];
  stop: AvwapRepeatStop | null;
  /** Set while this process owns the next send. A second run with a different token does not send. */
  claimToken: string | null;
}

export interface AvwapRepeatBook {
  version: 1;
  alerts: AvwapPendingAlert[];
  lockUntil: number | null;
}

export interface RepeatClaim {
  id: string;
  text: string;
  repeatNumber: number;
  previousLastSentAt: number;
  claimedAt: number;
}

export function emptyAvwapRepeatBook(): AvwapRepeatBook {
  return { version: 1, alerts: [], lockUntil: null };
}

export function addOpenAlert(book: AvwapRepeatBook, alert: AvwapPendingAlert): AvwapRepeatBook {
  const alerts = book.alerts.filter((row) => row.id !== alert.id).concat(alert);
  const open = alerts.filter((row) => !row.acknowledged && row.stop == null);
  const done = alerts.filter((row) => row.acknowledged || row.stop != null);
  done.sort((a, b) => b.lastSentAt - a.lastSentAt);
  return { ...book, alerts: open.concat(done.slice(0, 40)) };
}

export function avwapRepeatSecretSet(env: Record<string, string | undefined> = process.env): boolean {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  return typeof secret === "string" && secret.trim().length > 0;
}

/** True from 9:30 AM through 4:00 PM New York on a market day. 4:00 PM is closed. */
export function avwapRepeatSessionOpen(now: Date): boolean {
  if (!isMarketDay(now)) return false;
  return isNewYorkMinuteWindow(now, AVWAP_REPEAT_OPEN_MINUTE, AVWAP_REPEAT_CLOSE_MINUTE);
}

export function repeatBanner(repeatNumber: number): string {
  return `<b>REPEAT ${repeatNumber} of ${AVWAP_REPEAT_MAX}</b>\n`;
}

export function acknowledgedText(text: string): string {
  if (text.includes("\nAcknowledged.")) return text;
  return `${text}\n\nAcknowledged.`;
}

export function callbackDataFor(id: string): string | null {
  const data = `ack:${id}`;
  if (data.length > 64) return null;
  if (!/^ack:[A-Za-z0-9]{4,40}$/.test(data)) return null;
  return data;
}

export function newAvwapAlertId(now: number = Date.now()): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36);
  const noise = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `a${stamp}${noise}`.slice(0, 40);
}

export function parseAvwapRepeatBook(text: string | null): AvwapRepeatBook | null {
  if (text == null || text.trim() === "") return emptyAvwapRepeatBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.alerts)) return null;
  const alerts: AvwapPendingAlert[] = [];
  for (let i = 0; i < record.alerts.length; i++) {
    const alert = parseAlert(record.alerts[i]);
    if (alert) alerts.push(alert);
  }
  const lockUntil = typeof record.lockUntil === "number" && Number.isFinite(record.lockUntil) ? record.lockUntil : null;
  return { version: 1, alerts, lockUntil };
}

/**
 * Mark alerts that should send now, and stop the ones that are done.
 * A second call on the returned book sends nothing until another gap has passed.
 */
export function planAvwapRepeats(
  book: AvwapRepeatBook,
  nowMs: number,
  closedTradeIds: ReadonlySet<string>,
  claimToken: string,
): { book: AvwapRepeatBook; claims: RepeatClaim[] } {
  const now = new Date(nowMs);
  const alerts = book.alerts.map((alert) => ({ ...alert, messageIds: alert.messageIds.slice() }));
  const claims: RepeatClaim[] = [];
  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    if (alert.acknowledged || alert.stop) continue;
    if (alert.claimToken && book.lockUntil != null && book.lockUntil > nowMs) continue;
    if (alert.tradeId && closedTradeIds.has(alert.tradeId)) {
      alert.stop = "closed";
      continue;
    }
    if (!sameOpenSession(alert.firstSentAt, now)) {
      alert.stop = "close";
      continue;
    }
    if (alert.repeatsSent >= AVWAP_REPEAT_MAX) {
      alert.stop = "repeats";
      continue;
    }
    if (nowMs - alert.lastSentAt < AVWAP_REPEAT_GAP_MS) continue;
    const previousLastSentAt = alert.lastSentAt;
    alert.repeatsSent += 1;
    alert.lastSentAt = nowMs;
    alert.claimToken = claimToken;
    if (alert.repeatsSent >= AVWAP_REPEAT_MAX) alert.stop = "repeats";
    claims.push({
      id: alert.id,
      text: `${repeatBanner(alert.repeatsSent)}${alert.text}`,
      repeatNumber: alert.repeatsSent,
      previousLastSentAt,
      claimedAt: nowMs,
    });
  }
  return { book: { version: 1, alerts: trimAlerts(alerts), lockUntil: book.lockUntil }, claims };
}

export function revertRepeatClaim(book: AvwapRepeatBook, claim: RepeatClaim): AvwapRepeatBook {
  const alerts = book.alerts.map((alert) => {
    if (alert.id !== claim.id) return alert;
    if (alert.acknowledged || alert.stop === "ack" || alert.stop === "closed" || alert.stop === "close") return alert;
    if (alert.lastSentAt !== claim.claimedAt || alert.repeatsSent !== claim.repeatNumber) return alert;
    return {
      ...alert,
      repeatsSent: claim.repeatNumber - 1,
      lastSentAt: claim.previousLastSentAt,
      stop: null,
      claimToken: null,
    };
  });
  return { ...book, alerts };
}

export function recordRepeatMessage(book: AvwapRepeatBook, id: string, messageId: number | null): AvwapRepeatBook {
  if (messageId == null) return book;
  const alerts = book.alerts.map((alert) => {
    if (alert.id !== id) return alert;
    if (alert.messageIds.includes(messageId)) return { ...alert, claimToken: null };
    return { ...alert, messageIds: alert.messageIds.concat(messageId), claimToken: null };
  });
  return { ...book, alerts };
}

export function acknowledgeAvwapAlert(book: AvwapRepeatBook, id: string): { book: AvwapRepeatBook; alert: AvwapPendingAlert | null } {
  let found: AvwapPendingAlert | null = null;
  const alerts = book.alerts.map((alert) => {
    if (alert.id !== id) return alert;
    found = { ...alert, acknowledged: true, stop: "ack", claimToken: null };
    return found;
  });
  return { book: { ...book, alerts }, alert: found };
}

export function acknowledgeByMessageId(book: AvwapRepeatBook, messageId: number): { book: AvwapRepeatBook; alert: AvwapPendingAlert | null } {
  const match = book.alerts.find((alert) => !alert.acknowledged && alert.messageIds.includes(messageId));
  if (!match) return { book, alert: null };
  return acknowledgeAvwapAlert(book, match.id);
}

/** Oldest open alert. A bare ack is specific only when one alert is open. */
export function acknowledgeOldestOpen(book: AvwapRepeatBook): { book: AvwapRepeatBook; alert: AvwapPendingAlert | null } {
  const open = book.alerts.filter((alert) => !alert.acknowledged && alert.stop !== "ack");
  open.sort((a, b) => a.firstSentAt - b.firstSentAt);
  if (open.length === 0) return { book, alert: null };
  return acknowledgeAvwapAlert(book, open[0].id);
}

export function isAckWord(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  return text.trim().toLowerCase().replace(/[.!]+$/, "") === "ack";
}

export type TelegramAckIntent =
  | { type: "ignore" }
  | { type: "callback"; callbackId: string; alertId: string; messageId: number | null }
  | { type: "reply"; messageId: number }
  | { type: "word" };

/** What a Telegram update is asking, before the chat id is checked. */
export function telegramAckIntent(update: unknown): TelegramAckIntent {
  if (!update || typeof update !== "object") return { type: "ignore" };
  const record = update as Record<string, unknown>;
  const callback = asRecord(record.callback_query);
  if (callback) {
    const data = typeof callback.data === "string" ? callback.data : "";
    const match = /^ack:([A-Za-z0-9]{4,40})$/.exec(data);
    const callbackId = typeof callback.id === "string" ? callback.id : "";
    if (!match || callbackId === "") return { type: "ignore" };
    const message = asRecord(callback.message);
    const messageId = typeof message?.message_id === "number" ? message.message_id : null;
    return { type: "callback", callbackId, alertId: match[1], messageId };
  }
  const message = asRecord(record.message);
  if (!message) return { type: "ignore" };
  const reply = asRecord(message.reply_to_message);
  const replyId = typeof reply?.message_id === "number" ? reply.message_id : null;
  if (replyId != null) return { type: "reply", messageId: replyId };
  if (isAckWord(typeof message.text === "string" ? message.text : null)) return { type: "word" };
  return { type: "ignore" };
}

export function updateChatId(update: unknown): string | null {
  if (!update || typeof update !== "object") return null;
  const record = update as Record<string, unknown>;
  const callback = asRecord(record.callback_query);
  const message = asRecord(callback?.message) ?? asRecord(record.message);
  const chat = asRecord(message?.chat);
  const id = chat?.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.trim() !== "") return id.trim();
  return null;
}

function sameOpenSession(firstSentAt: number, now: Date): boolean {
  if (!avwapRepeatSessionOpen(now)) return false;
  return newYorkDate(new Date(firstSentAt)) === newYorkDate(now);
}

function trimAlerts(alerts: AvwapPendingAlert[]): AvwapPendingAlert[] {
  const open = alerts.filter((alert) => !alert.acknowledged && alert.stop == null);
  const done = alerts.filter((alert) => alert.acknowledged || alert.stop != null);
  done.sort((a, b) => b.lastSentAt - a.lastSentAt);
  return open.concat(done.slice(0, 40));
}

function parseAlert(value: unknown): AvwapPendingAlert | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[A-Za-z0-9]{4,40}$/.test(row.id)) return null;
  if (typeof row.text !== "string" || row.text.length === 0) return null;
  if (typeof row.firstSentAt !== "number" || typeof row.lastSentAt !== "number") return null;
  if (typeof row.repeatsSent !== "number" || row.repeatsSent < 0) return null;
  const messageIds = Array.isArray(row.messageIds)
    ? row.messageIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id))
    : [];
  const stop = row.stop === "ack" || row.stop === "repeats" || row.stop === "closed" || row.stop === "close" ? row.stop : null;
  return {
    id: row.id,
    tradeId: typeof row.tradeId === "string" && row.tradeId.length > 0 ? row.tradeId : null,
    text: row.text,
    firstSentAt: row.firstSentAt,
    repeatsSent: Math.floor(row.repeatsSent),
    lastSentAt: row.lastSentAt,
    acknowledged: row.acknowledged === true,
    messageIds,
    stop,
    claimToken: typeof row.claimToken === "string" && row.claimToken.length > 0 ? row.claimToken : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
