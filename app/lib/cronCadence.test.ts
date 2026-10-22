import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERT_POLICY, EXPERIMENT_DTE, EXPERIMENT_SHORT_DTE } from "@/app/lib/alertConfig";
import {
  CLOSE_WINDOW_SECONDS_ESTIMATE,
  CRON_CADENCE_MINUTES,
  EARLY_EXIT_SECONDS_ESTIMATE,
  MARK_REUSE_MS,
  OBSERVED_FULL_SCAN_SECONDS,
  SCAN_FUNCTION_MEMORY_MB,
  SCAN_SLOT_DEDUPE_MS,
  SCAN_STALE_AFTER_MS,
  classifyScanDay,
  gbHours,
  scheduledScanMinutesUtc,
  weekdayGbHours,
} from "@/app/lib/cronCadence";
import { FLOW_FUNCTION_BUDGET_MS } from "@/app/lib/flow";
import { isMarketDay } from "@/app/lib/marketHours";
import { SCAN_IN_PROGRESS_MS, SCAN_RECENT_SUCCESS_MS, SCAN_STALE_MS } from "@/app/lib/scanHealth";

describe("5-minute scan cadence", () => {
  it("fires every 5 minutes on weekdays and leaves the candle crons alone", () => {
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as {
      functions: Record<string, { maxDuration?: number; memory?: number }>;
      crons: Array<{ path: string; schedule: string }>;
    };
    const scans = vercel.crons.filter((row) => row.path === "/api/cron").map((row) => row.schedule);
    expect(scans).toEqual([
      "30,35,40,45,50,55 13 * * 1-5",
      "*/5 14-20 * * 1-5",
      "0 21 * * 1-5",
    ]);
    const candles = vercel.crons.filter((row) => row.path === "/api/cron/candles").map((row) => row.schedule);
    expect(candles).toEqual(["30 20 * * 1-5", "30 21 * * 1-5"]);
    expect(vercel.crons.every((row) => row.schedule.endsWith("1-5"))).toBe(true);
    expect(vercel.functions["app/api/cron/route.ts"]).toMatchObject({
      maxDuration: 300,
      memory: SCAN_FUNCTION_MEMORY_MB,
    });
    expect(CRON_CADENCE_MINUTES).toBe(5);
  });

  it("counts full scans, the close window, and early exits in both Central offsets", () => {
    const now = scheduledScanMinutesUtc(5);
    const before = scheduledScanMinutesUtc(15);
    expect(now).toHaveLength(91);
    expect(before).toHaveLength(31);
    expect(classifyScanDay(now, 5)).toEqual({ fullScans: 78, closeWindowRuns: 4, earlyExits: 9, invocations: 91 });
    expect(classifyScanDay(before, 5)).toEqual({ fullScans: 26, closeWindowRuns: 2, earlyExits: 3, invocations: 31 });
    expect(classifyScanDay(now, 6)).toEqual({ fullScans: 78, closeWindowRuns: 1, earlyExits: 12, invocations: 91 });
    expect(classifyScanDay(before, 6)).toEqual({ fullScans: 26, closeWindowRuns: 1, earlyExits: 4, invocations: 31 });
    expect(isMarketDay(new Date("2026-11-26T15:00:00Z"))).toBe(false);
    expect(isMarketDay(new Date("2026-11-25T15:00:00Z"))).toBe(true);
  });

  it("keeps the lock, the stale banner, and mark reuse inside the 5-minute slot", () => {
    expect(SCAN_RECENT_SUCCESS_MS).toBe(SCAN_SLOT_DEDUPE_MS);
    expect(SCAN_RECENT_SUCCESS_MS).toBe(2 * 60 * 1000);
    expect(SCAN_STALE_MS).toBe(SCAN_STALE_AFTER_MS);
    expect(SCAN_STALE_MS).toBe(2 * CRON_CADENCE_MINUTES * 60 * 1000);
    expect(MARK_REUSE_MS).toBe(4 * 60 * 1000);
    expect(MARK_REUSE_MS).toBeLessThan(CRON_CADENCE_MINUTES * 60 * 1000);
    expect(SCAN_IN_PROGRESS_MS).toBeGreaterThanOrEqual(CRON_CADENCE_MINUTES * 60 * 1000);
    expect(OBSERVED_FULL_SCAN_SECONDS.high).toBeLessThan(CRON_CADENCE_MINUTES * 60);
    expect(OBSERVED_FULL_SCAN_SECONDS.high).toBeLessThan(FLOW_FUNCTION_BUDGET_MS / 1000);
    expect(ALERT_POLICY.maxPerDay).toBe(5);
    expect(EXPERIMENT_DTE.opensPerDay).toBe(4);
    expect(EXPERIMENT_SHORT_DTE.opensPerDay).toBe(4);
  });

  it("estimates the weekday change in invocations and GB-hours", () => {
    const cdtNow = classifyScanDay(scheduledScanMinutesUtc(5), 5);
    const cdtBefore = classifyScanDay(scheduledScanMinutesUtc(15), 5);
    expect(cdtNow.invocations - cdtBefore.invocations).toBe(60);
    const lowBefore = weekdayGbHours(cdtBefore, OBSERVED_FULL_SCAN_SECONDS.low);
    const highBefore = weekdayGbHours(cdtBefore, OBSERVED_FULL_SCAN_SECONDS.high);
    const lowNow = weekdayGbHours(cdtNow, OBSERVED_FULL_SCAN_SECONDS.low);
    const highNow = weekdayGbHours(cdtNow, OBSERVED_FULL_SCAN_SECONDS.high);
    expect(lowBefore).toBeCloseTo(1.032, 3);
    expect(highBefore).toBeCloseTo(2.687, 3);
    expect(lowNow).toBeCloseTo(3.064, 3);
    expect(highNow).toBeCloseTo(8.028, 3);
    expect(lowNow - lowBefore).toBeCloseTo(2.032, 3);
    expect(highNow - highBefore).toBeCloseTo(5.341, 3);
    expect(gbHours(1, 3600)).toBeCloseTo(SCAN_FUNCTION_MEMORY_MB / 1024, 6);
    expect(CLOSE_WINDOW_SECONDS_ESTIMATE).toBe(20);
    expect(EARLY_EXIT_SECONDS_ESTIMATE).toBe(1);
    const cstNow = weekdayGbHours(classifyScanDay(scheduledScanMinutesUtc(5), 6), OBSERVED_FULL_SCAN_SECONDS.high);
    const cstBefore = weekdayGbHours(classifyScanDay(scheduledScanMinutesUtc(15), 6), OBSERVED_FULL_SCAN_SECONDS.high);
    expect(cstNow).toBeGreaterThan(cstBefore);
  });
});
