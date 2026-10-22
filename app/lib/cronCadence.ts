/**
 * Scheduled market-scan spacing.
 * vercel.json is the clock Vercel fires. These constants are what the
 * scan lock, the stale banner, and the mark reuse window follow.
 * The candle cron is a separate once-a-day pair and is not part of this cadence.
 */

/** Minutes between /api/cron fires during the covered UTC window. */
export const CRON_CADENCE_MINUTES = 5;

/** Memory on the scan route in vercel.json, in MB. */
export const SCAN_FUNCTION_MEMORY_MB = 3008;

/**
 * A finished scan blocks another non-manual pass for this long.
 * It is shorter than the cadence, so the next scheduled fire still runs.
 * A pass that has not finished is held by the in-progress lock instead.
 */
export const SCAN_SLOT_DEDUPE_MS = 2 * 60 * 1000;

/** Banner: two missed scans. */
export const SCAN_STALE_AFTER_MS = 2 * CRON_CADENCE_MINUTES * 60 * 1000;

/**
 * Do not mark the same shadow again inside this window.
 * One minute under the cadence, so the next scheduled scan still marks
 * and a second caller in the same slot does not.
 */
export const MARK_REUSE_MS = (CRON_CADENCE_MINUTES - 1) * 60 * 1000;

/**
 * Measured wall time of a full scan before this cadence change.
 * The planning model is separate. These are the figures to scale invocations by.
 */
export const OBSERVED_FULL_SCAN_SECONDS = { low: 47, high: 125 } as const;

/** The close-window pass re-quotes. It does not scan the watchlist. Planning figure. */
export const CLOSE_WINDOW_SECONDS_ESTIMATE = 20;

/** Hours check that returns before Schwab. Planning figure. */
export const EARLY_EXIT_SECONDS_ESTIMATE = 1;

export interface ScanDayLoad {
  fullScans: number;
  closeWindowRuns: number;
  earlyExits: number;
  invocations: number;
}

/** UTC minutes-from-midnight for one weekday of the scan cron. */
export function scheduledScanMinutesUtc(cadenceMinutes: 5 | 15): number[] {
  const out: number[] = [];
  const startMinute = cadenceMinutes === 5 ? 30 : 30;
  const step = cadenceMinutes;
  if (cadenceMinutes === 5) {
    for (let minute = startMinute; minute < 60; minute += step) out.push(13 * 60 + minute);
  } else {
    out.push(13 * 60 + 30, 13 * 60 + 45);
  }
  for (let hour = 14; hour <= 20; hour++) {
    for (let minute = 0; minute < 60; minute += step) out.push(hour * 60 + minute);
  }
  out.push(21 * 60);
  return out;
}

/**
 * Split one weekday of cron fires into full scans, the 15:00–15:20 Central
 * close window, and fires that return before Schwab.
 * offsetHours 5 is Central Daylight Time. 6 is Central Standard Time.
 */
export function classifyScanDay(minutesUtc: readonly number[], offsetHours: 5 | 6): ScanDayLoad {
  const open = 8 * 60 + 30;
  const close = 15 * 60;
  const closeEnd = close + 20;
  let fullScans = 0;
  let closeWindowRuns = 0;
  let earlyExits = 0;
  for (let i = 0; i < minutesUtc.length; i++) {
    const chicago = minutesUtc[i] - offsetHours * 60;
    if (chicago >= open && chicago < close) fullScans += 1;
    else if (chicago >= close && chicago < closeEnd) closeWindowRuns += 1;
    else earlyExits += 1;
  }
  return {
    fullScans,
    closeWindowRuns,
    earlyExits,
    invocations: fullScans + closeWindowRuns + earlyExits,
  };
}

/** Provisioned memory times wall-clock seconds, in GB-hours. */
export function gbHours(runs: number, secondsEach: number, memoryMb: number = SCAN_FUNCTION_MEMORY_MB): number {
  if (runs <= 0 || secondsEach <= 0) return 0;
  return (runs * secondsEach / 3600) * (memoryMb / 1024);
}

export function weekdayGbHours(load: ScanDayLoad, fullScanSeconds: number): number {
  return gbHours(load.fullScans, fullScanSeconds)
    + gbHours(load.closeWindowRuns, CLOSE_WINDOW_SECONDS_ESTIMATE)
    + gbHours(load.earlyExits, EARLY_EXIT_SECONDS_ESTIMATE);
}
