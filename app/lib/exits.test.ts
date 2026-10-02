import { describe, expect, it } from "vitest";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { defaultTimeStop, exitDefaultsSummary, planExits, planExitsForAsk } from "@/app/lib/exits";

describe("exit plan", () => {
  it("takes half off at +30% and stops at -25% inside the cap", () => {
    const plan = planExits({ premium: 2, contracts: 2 });
    expect(plan).not.toBeNull();
    expect(plan?.profitPrice).toBeCloseTo(2.6);
    expect(plan?.takeContracts).toBe(1);
    expect(plan?.stopPrice).toBeCloseTo(1.5);
    expect(plan?.stopDollars).toBeCloseTo(100);
    expect(plan?.stopTightened).toBe(false);
    expect(plan?.riskDollars).toBe(400);
    expect(plan?.riskBreachesCap).toBe(false);
    expect(plan?.lines.join(" ")).toContain("Take half off at $2.60");
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
    expect(plan?.profitPrice).toBeCloseTo(1.56);
    expect(plan?.lines.join(" ")).toContain("net debit");
    expect(plan?.lines.join(" ")).toContain("same percents");
  });

  it("sizes an alert from the contracts that fit, and names the clock stop", () => {
    const plan = planExitsForAsk(2.05, 2);
    expect(plan?.contracts).toBe(2);
    expect(defaultTimeStop()).toContain("3:00pm Chicago");
    expect(defaultTimeStop()).toContain("60 minutes");
    expect(exitDefaultsSummary()).toMatch(/not a broker order/i);
  });
});
