import { head as blobHead, put, BlobNotFoundError, BlobPreconditionFailedError, get } from "@vercel/blob";
import { chicagoDate, isChicagoMinuteWindow, isMarketDay } from "@/app/lib/marketHours";
import { namedSource } from "@/app/lib/providerCopy";
import { sendTelegramAlert } from "@/app/lib/telegram";

/**
 * One Chicago trading day's scan counts, and the close-of-day Telegram note.
 * The note is claimed before it is sent so a second cron cannot send it again.
 * Nothing here reads Schwab.
 */

export const DAY_TALLY_BLOB = "scan/day-tally.json";
/** 3:05pm America/Chicago, with room for a late cron. */
export const DAILY_NOTE_START_MINUTE = 15 * 60 + 5;
export const DAILY_NOTE_END_MINUTE = 15 * 60 + 20;
const NOTE_CLAIM_MS = 2 * 60 * 1000;
const MAX_QUALIFIED_KEYS = 80;

export interface DayTally {
  date: string;
  scans: number;
  schwabScans: number;
  timedOut: number;
  failed: number;
  qualifiedKeys: string[];
  alertsSent: number;
  noteSentAt: number | null;
  noteClaimAt: number | null;
  /** runStartedAt of an abandoned scan already counted, so a retry does not count it twice. */
  abandonedAt: number | null;
}

export interface ScanDayEvent {
  at: number;
  outcome: "success" | "partial" | "failed" | "skipped";
  reason: string | null;
  usedSchwab: boolean;
  qualifiedKeys: readonly string[];
  alertsSent: number;
}

export type DailyNoteResult =
  | { sent: true; note: string; date: string }
  | { sent: false; skipped: true; reason: string; note?: string };

let memory: DayTally | null = null;
let chain: Promise<void> = Promise.resolve();

export function resetDayTallyForTests(): void {
  memory = null;
  chain = Promise.resolve();
}

export function emptyDayTally(date: string): DayTally {
  return {
    date,
    scans: 0,
    schwabScans: 0,
    timedOut: 0,
    failed: 0,
    qualifiedKeys: [],
    alertsSent: 0,
    noteSentAt: null,
    noteClaimAt: null,
    abandonedAt: null,
  };
}

export function isTimeoutReason(reason: string | null): boolean {
  if (!reason) return false;
  return reason === "time budget" || /timed out|timeout/i.test(reason);
}

export function applyScanDay(current: DayTally, date: string, event: ScanDayEvent): DayTally {
  const base = current.date === date ? current : emptyDayTally(date);
  const timeout = isTimeoutReason(event.reason);
  const failed = !timeout && (event.outcome === "failed" || event.outcome === "skipped");
  const keys = base.qualifiedKeys.slice();
  for (let i = 0; i < event.qualifiedKeys.length && keys.length < MAX_QUALIFIED_KEYS; i++) {
    const key = event.qualifiedKeys[i];
    if (typeof key !== "string" || !key || keys.indexOf(key) !== -1) continue;
    keys.push(key);
  }
  const sent = Number.isFinite(event.alertsSent) && event.alertsSent > 0 ? Math.floor(event.alertsSent) : 0;
  return {
    ...base,
    scans: base.scans + 1,
    schwabScans: base.schwabScans + (event.usedSchwab ? 1 : 0),
    timedOut: base.timedOut + (timeout ? 1 : 0),
    failed: base.failed + (failed ? 1 : 0),
    qualifiedKeys: keys,
    alertsSent: base.alertsSent + sent,
  };
}

export function formatDailyNote(tally: DayTally, primary: "Tastytrade" | "Schwab" = "Tastytrade"): string {
  const scans = tally.scans;
  const scanWord = scans === 1 ? "scan" : "scans";
  const qualified = qualifiedSentence(tally.qualifiedKeys.length, tally.alertsSent);
  if (primary === "Schwab") {
    const parts = [`${tally.timedOut} timed out`];
    if (tally.failed > 0) parts.push(`${tally.failed} failed`);
    return `Options scanner today: ${scans} ${scanWord} ran on Schwab (${parts.join(", ")}). ${qualified}`;
  }
  const source = scans > 0 && tally.schwabScans === scans ? "Schwab" : "Tastytrade";
  const parts = [`${tally.schwabScans} used Schwab`, `${tally.timedOut} timed out`];
  if (tally.failed > 0) parts.push(`${tally.failed} failed`);
  return `Options scanner today: ${scans} ${scanWord} ran on ${source} (${parts.join(", ")}). ${qualified}`;
}

function qualifiedSentence(qualified: number, alertsSent: number): string {
  if (qualified <= 0) return "0 setups qualified, so no alerts were sent.";
  const setups = qualified === 1 ? "1 setup qualified (A/B)" : `${qualified} setups qualified (A/B)`;
  if (alertsSent <= 0) return `${setups}, but no alerts were sent.`;
  if (alertsSent === 1) return `${setups}, 1 alert was sent.`;
  return `${setups}, ${alertsSent} alerts were sent.`;
}

export function dailyNoteDecision(now: Date, manual: boolean): { run: boolean; reason: string | null } {
  if (!isMarketDay(now)) return { run: false, reason: "market holiday" };
  if (manual) return { run: true, reason: null };
  if (!isChicagoMinuteWindow(now, DAILY_NOTE_START_MINUTE, DAILY_NOTE_END_MINUTE)) {
    return { run: false, reason: "Outside the 3:05pm America/Chicago note window" };
  }
  return { run: true, reason: null };
}

export async function recordScanDay(event: ScanDayEvent): Promise<void> {
  const date = chicagoDate(new Date(event.at));
  if (!date) return;
  await updateDay(date, (current) => applyScanDay(current, date, event));
}

/** A scan that started and never finished. Counted once, as a timeout. */
export async function recordAbandonedScan(startedAt: number, noticedAt: number): Promise<void> {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return;
  const started = chicagoDate(new Date(startedAt));
  const noticed = chicagoDate(new Date(noticedAt));
  if (!started || started !== noticed) return;
  await updateDay(started, (current) => {
    const base = current.date === started ? current : emptyDayTally(started);
    if (base.abandonedAt === startedAt) return base;
    return {
      ...base,
      scans: base.scans + 1,
      timedOut: base.timedOut + 1,
      abandonedAt: startedAt,
    };
  });
}

export async function readDayTally(date: string): Promise<DayTally> {
  const stored = await readCurrent();
  if (!stored || stored.date !== date) return emptyDayTally(date);
  return stored;
}

/**
 * Send the close note once. A second call the same Chicago day does not send.
 * Schwab is not consulted. A failed send releases the claim so a retry can try.
 */
export async function deliverDailyNote(now: Date, manual = false): Promise<DailyNoteResult> {
  const decision = dailyNoteDecision(now, manual);
  if (!decision.run) return { sent: false, skipped: true, reason: decision.reason ?? "skipped" };
  const date = chicagoDate(now);
  if (!date) return { sent: false, skipped: true, reason: "clock" };
  const claimed = await claimNote(date, now.getTime());
  if (claimed !== "send") {
    return { sent: false, skipped: true, reason: claimed === "already" ? "already sent" : "note already in progress" };
  }
  const tally = await readDayTally(date);
  const note = formatDailyNote(tally, namedSource());
  let sent = false;
  try {
    sent = await sendTelegramAlert(note);
  } catch {
    sent = false;
  }
  await finishNote(date, now.getTime(), sent);
  if (!sent) return { sent: false, skipped: true, reason: "Telegram did not accept the note", note };
  return { sent: true, note, date };
}

async function claimNote(date: string, now: number): Promise<"send" | "already" | "busy"> {
  let result: "send" | "already" | "busy" = "busy";
  const saved = await updateDay(date, (current) => {
    const base = current.date === date ? current : emptyDayTally(date);
    if (base.noteSentAt != null) {
      result = "already";
      return base;
    }
    if (base.noteClaimAt != null && now >= base.noteClaimAt && now - base.noteClaimAt < NOTE_CLAIM_MS) {
      result = "busy";
      return base;
    }
    result = "send";
    return { ...base, noteClaimAt: now };
  });
  if (!saved) return "busy";
  return result;
}

async function finishNote(date: string, now: number, sent: boolean): Promise<void> {
  await updateDay(date, (current) => {
    const base = current.date === date ? current : emptyDayTally(date);
    if (sent) return { ...base, noteSentAt: now, noteClaimAt: null };
    return { ...base, noteClaimAt: null };
  });
}

function blobEnabled(): boolean {
  if (process.env.VITEST === "true") return false;
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
  return token.length > 0;
}

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

async function updateDay(date: string, change: (current: DayTally) => DayTally): Promise<boolean> {
  let saved = false;
  const run = chain.then(async () => {
    saved = await updateOnce(date, change);
  });
  chain = run.then(() => undefined, () => undefined);
  await run;
  return saved;
}

async function updateOnce(date: string, change: (current: DayTally) => DayTally): Promise<boolean> {
  if (!blobEnabled()) {
    const current = memory && memory.date === date ? memory : emptyDayTally(date);
    memory = change(current);
    return true;
  }
  const token = blobToken();
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const read = await readBlob(token);
    const parsed = read ? parseDayTally(read.text) : null;
    const current = parsed && parsed.date === date ? parsed : emptyDayTally(date);
    const next = change(current);
    try {
      await put(DAY_TALLY_BLOB, JSON.stringify(next), {
        access: "private",
        token,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 60,
        ...(read?.etag ? { ifMatch: read.etag } : {}),
      });
      memory = next;
      return true;
    } catch (err) {
      last = err;
      if (err instanceof BlobPreconditionFailedError && attempt < 3) continue;
      if (attempt < 3 && isConflict(err)) continue;
      break;
    }
  }
  console.warn(`Day tally was not saved: ${last instanceof Error ? last.message : "write failed"}`);
  return false;
}

async function readCurrent(): Promise<DayTally | null> {
  if (!blobEnabled()) return memory;
  const read = await readBlob(blobToken());
  const parsed = read ? parseDayTally(read.text) : null;
  return parsed ?? memory;
}

async function readBlob(token: string): Promise<{ text: string; etag: string | null } | null> {
  try {
    const meta = await blobHead(DAY_TALLY_BLOB, { token });
    const etag = strongEtag(meta?.etag);
    const result = await get(DAY_TALLY_BLOB, { access: "private", token, useCache: false });
    if (!result || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return { text, etag };
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    return null;
  }
}

function strongEtag(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text || text.startsWith("W/")) return null;
  return text;
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return status === 412 || status === 409;
}

export function parseDayTally(text: string): DayTally | null {
  try {
    const parsed = JSON.parse(text) as Partial<DayTally>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
      return null;
    }
    const keys: string[] = [];
    if (Array.isArray(parsed.qualifiedKeys)) {
      for (let i = 0; i < parsed.qualifiedKeys.length && keys.length < MAX_QUALIFIED_KEYS; i++) {
        const key = parsed.qualifiedKeys[i];
        if (typeof key !== "string" || !key || key.length > 160 || keys.indexOf(key) !== -1) continue;
        keys.push(key);
      }
    }
    return {
      date: parsed.date,
      scans: count(parsed.scans),
      schwabScans: count(parsed.schwabScans),
      timedOut: count(parsed.timedOut),
      failed: count(parsed.failed),
      qualifiedKeys: keys,
      alertsSent: count(parsed.alertsSent),
      noteSentAt: time(parsed.noteSentAt),
      noteClaimAt: time(parsed.noteClaimAt),
      abandonedAt: time(parsed.abandonedAt),
    };
  } catch {
    return null;
  }
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function time(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}
