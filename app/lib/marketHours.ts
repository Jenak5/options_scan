/**
 * US equity regular session in Central Time, including both CST and CDT.
 * Weekdays, 8:30 inclusive through 15:00 exclusive.
 * This clock does not know NYSE holidays. Scheduled scans use isMarketDay for that.
 */

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

/**
 * Full-day NYSE closures for 2026 and 2027.
 * Source: NYSE, "Holidays & Trading Hours"
 * https://www.nyse.com/markets/hours-calendars
 * The table lists these dates for all NYSE markets. Observed dates are the ones NYSE prints.
 *
 * Not included, because the stock market is open: Columbus Day and Veterans Day.
 *
 * Not included, because they are early closes (1:00 p.m. Eastern), not full-day holidays:
 * Friday, November 27, 2026 and Friday, November 26, 2027 (the day after Thanksgiving),
 * and Thursday, December 24, 2026 (Christmas Eve).
 *
 * January 1, 2028 falls on Saturday. NYSE does not observe a New Year's holiday for it,
 * so Friday, December 31, 2027 is a normal session.
 */
const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King, Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth National Independence Day
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King, Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth National Independence Day (observed)
  "2027-07-05", // Independence Day (observed)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day (observed)
]);

export interface ChicagoClock {
  weekday: string;
  /** Minutes from midnight in America/Chicago. */
  minutes: number;
  /** YYYY-MM-DD in America/Chicago. */
  date: string;
  weekdaySession: boolean;
}

export function chicagoClock(now: Date = new Date()): ChicagoClock | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  let hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour === 24) hour = 0;

  return {
    weekday,
    minutes: hour * 60 + minute,
    date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    weekdaySession: WEEKDAYS.has(weekday),
  };
}

export function chicagoDate(now: Date = new Date()): string {
  return chicagoClock(now)?.date ?? "";
}

export function isChicagoMarketHours(now: Date = new Date()): boolean {
  const clock = chicagoClock(now);
  if (!clock || !clock.weekdaySession) return false;
  return clock.minutes >= 8 * 60 + 30 && clock.minutes < 15 * 60;
}

/** Weekday window in America/Chicago, start inclusive and end exclusive. */
export function isChicagoMinuteWindow(now: Date, startMinute: number, endMinute: number): boolean {
  const clock = chicagoClock(now);
  if (!clock || !clock.weekdaySession) return false;
  return clock.minutes >= startMinute && clock.minutes < endMinute;
}

/** True when the America/New_York calendar date is a full-day NYSE close in 2026 or 2027. */
export function isNyseHoliday(date: Date = new Date()): boolean {
  const clock = newYorkClock(date);
  if (!clock) return false;
  return NYSE_HOLIDAYS.has(clock.date);
}

/**
 * True on a New York weekday that is not a full-day NYSE holiday.
 * This is the calendar day, not the 9:30–16:00 session. Weekends are false.
 * Early closes stay true, so a half day still runs.
 */
export function isMarketDay(date: Date = new Date()): boolean {
  const clock = newYorkClock(date);
  if (!clock || !clock.weekdaySession) return false;
  return !NYSE_HOLIDAYS.has(clock.date);
}

/**
 * Chicago dates after the open date, through `to`, not counting the open date.
 * Saturday, Sunday, and full-day NYSE holidays do not count.
 * Early closes still count. The 3-day flat time stop uses this count, so a holiday does not tick it.
 */
export function chicagoTradingDaysElapsed(from: Date, to: Date): number {
  const start = chicagoDate(from);
  const end = chicagoDate(to);
  if (!start || !end || end <= start) return 0;
  let count = 0;
  let cursor = nextYmd(start);
  while (cursor <= end) {
    if (isTradingDayYmd(cursor)) count += 1;
    const next = nextYmd(cursor);
    if (next <= cursor) break;
    cursor = next;
  }
  return count;
}

/**
 * The next Chicago trading day after `ymd`.
 * Saturday, Sunday, and full-day NYSE holidays are skipped. Early closes are not.
 */
export function nextChicagoTradingDay(ymd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  let cursor = nextYmd(ymd);
  for (let i = 0; i < 10; i++) {
    if (isTradingDayYmd(cursor)) return cursor;
    const next = nextYmd(cursor);
    if (next <= cursor) return null;
    cursor = next;
  }
  return null;
}

/**
 * The Chicago trading day before `ymd`.
 * Saturday, Sunday, and full-day NYSE holidays are skipped. Early closes are not.
 */
export function previousChicagoTradingDay(ymd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  let cursor = prevYmd(ymd);
  for (let i = 0; i < 10; i++) {
    if (isTradingDayYmd(cursor)) return cursor;
    const prev = prevYmd(cursor);
    if (prev >= cursor) return null;
    cursor = prev;
  }
  return null;
}

function nextYmd(ymd: string): string {
  return shiftYmd(ymd, 1);
}

function prevYmd(ymd: string): string {
  return shiftYmd(ymd, -1);
}

function shiftYmd(ymd: string, days: number): string {
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + days));
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

function isWeekdayYmd(ymd: string): boolean {
  const parts = ymd.split("-");
  if (parts.length !== 3) return false;
  const day = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
  return day !== 0 && day !== 6;
}

function isTradingDayYmd(ymd: string): boolean {
  return isWeekdayYmd(ymd) && !NYSE_HOLIDAYS.has(ymd);
}

interface NewYorkClock {
  weekday: string;
  /** YYYY-MM-DD in America/New_York. */
  date: string;
  weekdaySession: boolean;
}

function newYorkClock(now: Date): NewYorkClock | null {
  if (Number.isNaN(now.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  if (!year || !month || !day || !weekday) return null;
  return {
    weekday,
    date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    weekdaySession: WEEKDAYS.has(weekday),
  };
}
