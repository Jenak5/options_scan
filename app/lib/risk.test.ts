import { describe, expect, it } from "vitest";
import { TRADE_RULES } from "@/app/lib/alertConfig";
import {
  ACCOUNT_SIZE_DOLLARS,
  DEFAULT_ACCOUNT_SIZE_DOLLARS,
  DEFAULT_MAX_LOSS_DOLLARS,
  MAX_LOSS_DOLLARS,
  readAccountSizeDollars,
  readMaxLossDollars,
} from "@/app/lib/risk";
import { weeklyDrawdownThreshold } from "@/app/lib/trades";

describe("account size", () => {
  it("defaults to $5,000 and keeps the $875 cap at 17.5%", () => {
    expect(DEFAULT_ACCOUNT_SIZE_DOLLARS).toBe(5000);
    expect(ACCOUNT_SIZE_DOLLARS).toBe(5000);
    expect(DEFAULT_MAX_LOSS_DOLLARS).toBe(875);
    expect(MAX_LOSS_DOLLARS).toBe(875);
    expect(MAX_LOSS_DOLLARS / ACCOUNT_SIZE_DOLLARS).toBeCloseTo(0.175);
    expect(TRADE_RULES.weeklyDrawdownFraction).toBe(0.25);
    expect(weeklyDrawdownThreshold()).toBe(1250);
  });

  it("falls back when the environment value is empty or unsafe", () => {
    expect(readAccountSizeDollars(undefined)).toBe(5000);
    expect(readAccountSizeDollars("")).toBe(5000);
    expect(readAccountSizeDollars("  ")).toBe(5000);
    expect(readAccountSizeDollars("nope")).toBe(5000);
    expect(readAccountSizeDollars("0")).toBe(5000);
    expect(readAccountSizeDollars("-20")).toBe(5000);
    expect(readAccountSizeDollars("10000001")).toBe(5000);
    expect(readAccountSizeDollars("7500")).toBe(7500);
    expect(readMaxLossDollars(undefined)).toBe(875);
    expect(readMaxLossDollars("0")).toBe(875);
    expect(readMaxLossDollars("900")).toBe(900);
  });
});
