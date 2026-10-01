import { describe, expect, it } from "vitest";
import { EVENT_RULES } from "@/app/lib/alertConfig";
import {
  EARNINGS_UNKNOWN_PHRASE,
  IV_CRUSH_SENTENCE,
  NO_EARNINGS_LISTED,
  UNKNOWN_EARNINGS,
  assessEventRisk,
  macroReleasesThrough,
} from "@/app/lib/eventRisk";

const QUIET = new Date("2026-10-05T15:00:00Z");

describe("2026 macro calendar", () => {
  it("uses only dated 2026 releases from the Fed and BLS schedules", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < EVENT_RULES.macroDates.length; i++) {
      const row = EVENT_RULES.macroDates[i];
      expect(row.date).toMatch(/^2026-\d{2}-\d{2}$/);
      counts[row.name] = (counts[row.name] ?? 0) + 1;
    }
    expect(counts.FOMC).toBe(8);
    expect(counts.CPI).toBe(12);
    expect(counts["Jobs report"]).toBe(12);
    expect(counts.PPI).toBe(13);
    const march18 = EVENT_RULES.macroDates.filter((row) => row.date === "2026-03-18").map((row) => row.name);
    expect(march18).toEqual(["FOMC", "PPI"]);
  });
});

describe("event risk", () => {
  it("ignores a macro release after expiration", () => {
    expect(macroReleasesThrough("2026-10-05", "2026-10-08")).toEqual([]);
    expect(macroReleasesThrough("2026-10-14", "2026-10-14").map((row) => row.name)).toEqual(["CPI"]);
  });

  it("treats a stale earnings date as unknown instead of safe", () => {
    const result = assessEventRisk({
      now: QUIET,
      expiration: "2026-10-08",
      dte: 3,
      earnings: { status: "known", date: "2026-09-01", timing: "after-market", estimated: false },
      definedRiskSpread: false,
    });
    expect(result.eventLine.startsWith(EARNINGS_UNKNOWN_PHRASE)).toBe(true);
    expect(result.capGrade).toBe("B");
    expect(result.downgradeSteps).toBe(0);
    expect(result.eventLine.includes(IV_CRUSH_SENTENCE)).toBe(false);
  });

  it("does not downgrade when the listed date is after expiration", () => {
    const result = assessEventRisk({
      now: QUIET,
      expiration: "2026-10-08",
      dte: 3,
      earnings: { status: "known", date: "2026-11-17", timing: "after-market", estimated: false },
      definedRiskSpread: false,
    });
    expect(result.downgradeSteps).toBe(0);
    expect(result.skipForEarnings).toBe(false);
    expect(result.capGrade).toBeNull();
    expect(result.eventLine).toBe("Next earnings 2026-11-17 after the close.");
  });

  it("names an estimated date and still downgrades when it is inside the contract", () => {
    const result = assessEventRisk({
      now: QUIET,
      expiration: "2026-10-08",
      dte: 3,
      earnings: { status: "known", date: "2026-10-07", timing: null, estimated: true },
      definedRiskSpread: false,
    });
    expect(result.eventLine).toContain("Next earnings 2026-10-07 (estimated).");
    expect(result.downgradeSteps).toBe(EVENT_RULES.earningsDowngradeSteps);
  });

  it("leaves a symbol with no earnings calendar uncapped", () => {
    const result = assessEventRisk({
      now: QUIET,
      expiration: "2026-10-08",
      dte: 3,
      earnings: NO_EARNINGS_LISTED,
      definedRiskSpread: false,
    });
    expect(result.capGrade).toBeNull();
    expect(result.eventLine).toBe("No earnings date listed for this ticker.");
  });

  it("treats a missing lookup as unknown", () => {
    const result = assessEventRisk({
      now: QUIET,
      expiration: "2026-10-08",
      dte: 3,
      earnings: null,
      definedRiskSpread: false,
    });
    expect(result.capGrade).toBe(EVENT_RULES.maxGradeUntilEarnings);
    expect(result.eventLine.startsWith(EARNINGS_UNKNOWN_PHRASE)).toBe(true);
    expect(UNKNOWN_EARNINGS.status).toBe("unknown");
  });
});
