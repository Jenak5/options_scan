import { describe, expect, it } from "vitest";
import { OUTCOME_RULES } from "@/app/lib/alertConfig";
import { chicagoDate, chicagoTradingDaysElapsed, isChicagoMarketHours, isChicagoMinuteWindow } from "@/app/lib/marketHours";

describe("Chicago session clock", () => {
  it("treats 8:30 as open and 15:00 as closed, and opens a short close window", () => {
    const open = new Date("2026-10-01T13:30:00Z");
    const lastMinute = new Date("2026-10-01T19:59:00Z");
    const bell = new Date("2026-10-01T20:00:00Z");
    const still = new Date("2026-10-01T20:19:00Z");
    const after = new Date("2026-10-01T20:20:00Z");
    const saturday = new Date("2026-10-03T20:05:00Z");
    const closeStart = OUTCOME_RULES.closeCheckpointMinutes;
    const closeEnd = closeStart + OUTCOME_RULES.closeWindowMinutes;

    expect(chicagoDate(open)).toBe("2026-10-01");
    expect(isChicagoMarketHours(open)).toBe(true);
    expect(isChicagoMarketHours(lastMinute)).toBe(true);
    expect(isChicagoMarketHours(bell)).toBe(false);
    expect(isChicagoMinuteWindow(lastMinute, closeStart, closeEnd)).toBe(false);
    expect(isChicagoMinuteWindow(bell, closeStart, closeEnd)).toBe(true);
    expect(isChicagoMinuteWindow(still, closeStart, closeEnd)).toBe(true);
    expect(isChicagoMinuteWindow(after, closeStart, closeEnd)).toBe(false);
    expect(isChicagoMarketHours(saturday)).toBe(false);
    expect(isChicagoMinuteWindow(saturday, closeStart, closeEnd)).toBe(false);
  });

  it("counts Chicago weekdays after the open date and skips the weekend", () => {
    const thursday = new Date("2026-10-01T15:00:00Z");
    expect(chicagoTradingDaysElapsed(thursday, thursday)).toBe(0);
    expect(chicagoTradingDaysElapsed(thursday, new Date("2026-10-02T15:00:00Z"))).toBe(1);
    expect(chicagoTradingDaysElapsed(thursday, new Date("2026-10-03T15:00:00Z"))).toBe(1);
    expect(chicagoTradingDaysElapsed(thursday, new Date("2026-10-05T15:00:00Z"))).toBe(2);
    expect(chicagoTradingDaysElapsed(thursday, new Date("2026-10-06T15:00:00Z"))).toBe(3);
  });
});
