import { describe, expect, it } from "vitest";
import { OUTCOME_RULES, TRADE_RULES } from "@/app/lib/alertConfig";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { defaultTimeStop, exitDefaultsSummary, openFlatTimeStopText, planExits, planExitsForAsk } from "@/app/lib/exits";

describe("exit plan", () => {
  it("takes half off at +40% and stops at -25% inside the cap", () => {
    const plan = planExits({ premium: 2, contracts: 2 });
    expect(plan).not.toBeNull();
    expect(plan?.profitPrice).toBeCloseTo(2.8);
    expect(plan?.takeContracts).toBe(1);
    expect(plan?.stopPrice).toBeCloseTo(1.5);
    expect(plan?.stopDollars).toBeCloseTo(100);
    expect(plan?.stopTightened).toBe(false);
    expect(plan?.riskDollars).toBe(400);
    expect(plan?.riskBreachesCap).toBe(false);
    expect(plan?.lines.join(" ")).toContain("Take half off at $2.80");
    expect(plan?.lines.join(" ")).toContain("1 contract of 2");
    expect(plan?.lines.join(" ")).toContain("inside the $875.00 cap");
    expect(plan?.note).toMatch(/starting defaults/i);
  });

  it("treats one contract as a full exit at the profit target", () => {
    const plan = planExits({ premium: 2, contracts: 1 });
    expect(plan?.lines.join(" ")).toContain("half off is a full exit");
  });

  it("tightens the stop so the dollar loss never exceeds the cap", () => {
    const plan = planExits({ premium: 2, contracts: 20 });
    expect(plan?.riskDollars).toBe(4000);
    expect(plan?.riskBreachesCap).toBe(true);
    expect(plan?.stopTightened).toBe(true);
    expect(plan?.stopDollars).toBe(MAX_LOSS_DOLLARS);
    expect(plan?.stopPrice).toBeCloseTo(2 * (1 - MAX_LOSS_DOLLARS / 4000));
    expect(plan?.lines.join(" ")).toContain("over the $875.00 cap");
    expect(plan?.lines.join(" ")).toContain("Risk used is $4000.00");
  });

  it("uses the same percents on a debit spread's net debit", () => {
    const plan = planExits({ premium: 1.2, contracts: 2, structure: "debit-spread" });
    expect(plan?.structure).toBe("debit-spread");
    expect(plan?.profitPrice).toBeCloseTo(1.68);
    expect(plan?.lines.join(" ")).toContain("net debit");
    expect(plan?.lines.join(" ")).toContain("same percents");
  });

  it("sizes an alert from the contracts that fit, and names the multi-day stop", () => {
    const plan = planExitsForAsk(2.05, 2);
    expect(plan?.contracts).toBe(2);
    expect(TRADE_RULES.profitTargetFraction).toBe(0.4);
    expect(TRADE_RULES.flatAfterTradingDays).toBe(3);
    expect(defaultTimeStop()).toContain("3 trading days");
    expect(defaultTimeStop()).toContain(TRADE_RULES.lastWeekExitReminder);
    expect(defaultTimeStop()).not.toContain("3:00pm");
    expect(defaultTimeStop()).not.toContain("60 minutes");
    expect(openFlatTimeStopText()).toContain("still flat after 3 trading days");
    expect(plan?.lines.join(" ")).toContain("last week to expiration");
    expect(exitDefaultsSummary()).toMatch(/\+40%/);
    expect(exitDefaultsSummary()).toMatch(/not a broker order/i);
    expect(OUTCOME_RULES.closeCheckpointMinutes).toBe(15 * 60);
  });
});
