/**
 * US equity regular session in Central Time, including both CST and CDT.
 * Weekdays, 8:30 inclusive through 15:00 exclusive.
 */
export function isChicagoMarketHours(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  if (weekday !== "Mon" && weekday !== "Tue" && weekday !== "Wed" && weekday !== "Thu" && weekday !== "Fri") {
    return false;
  }

  let hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  if (hour === 24) hour = 0;

  const minutes = hour * 60 + minute;
  return minutes >= 8 * 60 + 30 && minutes < 15 * 60;
}
