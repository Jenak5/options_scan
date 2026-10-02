/**
 * US equity regular session in Central Time, including both CST and CDT.
 * Weekdays, 8:30 inclusive through 15:00 exclusive.
 */

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

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

/**
 * Chicago weekdays after the open date, through `to`, not counting the open date.
 * Saturday and Sunday do not count. Exchange holidays are not on this calendar.
 */
export function chicagoTradingDaysElapsed(from: Date, to: Date): number {
  const start = chicagoDate(from);
  const end = chicagoDate(to);
  if (!start || !end || end <= start) return 0;
  let count = 0;
  let cursor = nextYmd(start);
  while (cursor <= end) {
    if (isWeekdayYmd(cursor)) count += 1;
    const next = nextYmd(cursor);
    if (next <= cursor) break;
    cursor = next;
  }
  return count;
}

function nextYmd(ymd: string): string {
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + 1));
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
