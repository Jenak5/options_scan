/**
 * Calendar dates in America/New_York and America/Chicago.
 * US daylight time since 2007 starts the second Sunday in March at 02:00
 * and ends the first Sunday in November at 02:00.
 * A 1-minute walk hits one memo entry per local day instead of building
 * an Intl.DateTimeFormat on every bar.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NY_STANDARD_BEHIND = 5;
const CHICAGO_STANDARD_BEHIND = 6;
const MEMO_CAP = 20_000;

interface DayWindow {
  start: number;
  end: number;
  ymd: string;
}

interface DayHold {
  window: DayWindow | null;
}

const nyMemo = new Map<number, string>();
const chicagoMemo = new Map<number, string>();
const midnightMemo = new Map<string, number | null>();
const dstCache = new Map<string, { start: number; end: number }>();
const nyHold: DayHold = { window: null };
const chicagoHold: DayHold = { window: null };

let utcYearCache = { year: 1970, start: 0, end: Date.UTC(1971, 0, 1) };

function utcYear(ms: number): number {
  if (ms >= utcYearCache.start && ms < utcYearCache.end) return utcYearCache.year;
  let year = 1970 + Math.floor(ms / (365.2425 * DAY_MS));
  let start = Date.UTC(year, 0, 1);
  while (start > ms) {
    year -= 1;
    start = Date.UTC(year, 0, 1);
  }
  let next = Date.UTC(year + 1, 0, 1);
  while (next <= ms) {
    year += 1;
    start = next;
    next = Date.UTC(year + 1, 0, 1);
  }
  utcYearCache = { year, start, end: next };
  return year;
}

function nthSunday(year: number, monthIndex: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((7 - firstWeekday) % 7) + (n - 1) * 7;
}

function dstBounds(year: number, standardBehind: number): { start: number; end: number } {
  const key = `${year}|${standardBehind}`;
  const hit = dstCache.get(key);
  if (hit) return hit;
  const startDay = nthSunday(year, 2, 2);
  const endDay = nthSunday(year, 10, 1);
  const bounds = {
    start: Date.UTC(year, 2, startDay, 2 + standardBehind, 0, 0, 0),
    end: Date.UTC(year, 10, endDay, 1 + standardBehind, 0, 0, 0),
  };
  dstCache.set(key, bounds);
  return bounds;
}

/** Whole hours behind UTC. Daylight time is one hour less than standard. */
function offsetBehind(utcMs: number, standardBehind: number): number {
  const bounds = dstBounds(utcYear(utcMs), standardBehind);
  if (utcMs >= bounds.start && utcMs < bounds.end) return standardBehind - 1;
  return standardBehind;
}

function formatLocal(localMs: number): string {
  const date = new Date(localMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const monthText = month < 10 ? `0${month}` : String(month);
  const dayText = day < 10 ? `0${day}` : String(day);
  return `${year}-${monthText}-${dayText}`;
}

function addDay(ymd: string): string {
  const parts = ymd.split("-");
  return formatLocal(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + 1));
}

function zonedMidnightMs(ymd: string, standardBehind: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const key = `${standardBehind}|${ymd}`;
  if (midnightMemo.has(key)) return midnightMemo.get(key) ?? null;
  const parts = ymd.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  let found: number | null = null;
  const offsets = [standardBehind - 1, standardBehind];
  for (let i = 0; i < offsets.length; i++) {
    const behind = offsets[i];
    const utc = Date.UTC(year, month - 1, day, behind, 0, 0, 0);
    if (offsetBehind(utc, standardBehind) !== behind) continue;
    const local = utc - behind * HOUR_MS;
    const date = new Date(local);
    if (date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0) continue;
    if (formatLocal(local) !== ymd) continue;
    found = utc;
    break;
  }
  if (midnightMemo.size >= MEMO_CAP) midnightMemo.clear();
  midnightMemo.set(key, found);
  return found;
}

function windowFor(ymd: string, standardBehind: number): DayWindow | null {
  const start = zonedMidnightMs(ymd, standardBehind);
  const end = zonedMidnightMs(addDay(ymd), standardBehind);
  if (start == null || end == null || end <= start) return null;
  return { start, end, ymd };
}

function zonedYmd(utcMs: number, standardBehind: number, memo: Map<number, string>, hold: DayHold): string {
  const open = hold.window;
  if (open && utcMs >= open.start && utcMs < open.end) return open.ymd;
  const hour = Math.floor(utcMs / HOUR_MS);
  const cached = memo.get(hour);
  if (cached !== undefined) {
    if (!hold.window || hold.window.ymd !== cached) hold.window = windowFor(cached, standardBehind);
    return cached;
  }
  const ymd = formatLocal(utcMs - offsetBehind(utcMs, standardBehind) * HOUR_MS);
  if (memo.size >= MEMO_CAP) memo.clear();
  memo.set(hour, ymd);
  const built = windowFor(ymd, standardBehind);
  if (built) hold.window = built;
  return ymd;
}

export function newYorkYmd(utcMs: number): string {
  return zonedYmd(utcMs, NY_STANDARD_BEHIND, nyMemo, nyHold);
}

export function chicagoYmd(utcMs: number): string {
  return zonedYmd(utcMs, CHICAGO_STANDARD_BEHIND, chicagoMemo, chicagoHold);
}

/** UTC millis of America/New_York midnight on `ymd`. */
export function newYorkMidnightMs(ymd: string): number | null {
  return zonedMidnightMs(ymd, NY_STANDARD_BEHIND);
}

/** UTC millis of America/Chicago midnight on `ymd`. */
export function chicagoMidnightMs(ymd: string): number | null {
  return zonedMidnightMs(ymd, CHICAGO_STANDARD_BEHIND);
}
