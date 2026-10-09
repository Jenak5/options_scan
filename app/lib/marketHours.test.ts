import { describe, expect, it } from "vitest";
import { OUTCOME_RULES } from "@/app/lib/alertConfig";
import { chicagoDate, chicagoTradingDaysElapsed, isChicagoMarketHours, isChicagoMinuteWindow, isMarketDay, isNyseHoliday, nextChicagoTradingDay, previousChicagoTradingDay } from "@/app/lib/marketHours";

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

  it("names the next Chicago weekday and skips the weekend", () => {
    expect(nextChicagoTradingDay("2026-10-01")).toBe("2026-10-02");
    expect(nextChicagoTradingDay("2026-10-02")).toBe("2026-10-05");
    expect(nextChicagoTradingDay("not-a-date")).toBeNull();
  });

  it("names the previous Chicago weekday and skips the weekend", () => {
    expect(previousChicagoTradingDay("2026-10-07")).toBe("2026-10-06");
    expect(previousChicagoTradingDay("2026-10-05")).toBe("2026-10-02");
    expect(previousChicagoTradingDay("2026-10-03")).toBe("2026-10-02");
    expect(previousChicagoTradingDay("not-a-date")).toBeNull();
  });
});

describe("NYSE holidays", () => {
  const holidays = [
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25",
    "2027-01-01",
    "2027-01-18",
    "2027-02-15",
    "2027-03-26",
    "2027-05-31",
    "2027-06-18",
    "2027-07-05",
    "2027-09-06",
    "2027-11-25",
    "2027-12-24",
  ];

  it("treats each full-day close as a holiday in New York, and not a market day", () => {
    for (const ymd of holidays) {
      const duringSession = new Date(`${ymd}T15:00:00Z`);
      expect(isNyseHoliday(duringSession)).toBe(true);
      expect(isMarketDay(duringSession)).toBe(false);
    }
  });

  it("keeps early closes and Columbus Day as market days", () => {
    const halfDay = new Date("2026-11-27T15:00:00Z");
    const christmasEve = new Date("2026-12-24T15:00:00Z");
    const columbus = new Date("2026-10-12T15:00:00Z");
    const veterans = new Date("2026-11-11T15:00:00Z");
    expect(isNyseHoliday(halfDay)).toBe(false);
    expect(isMarketDay(halfDay)).toBe(true);
    expect(isChicagoMarketHours(halfDay)).toBe(true);
    expect(isNyseHoliday(christmasEve)).toBe(false);
    expect(isMarketDay(christmasEve)).toBe(true);
    expect(isNyseHoliday(columbus)).toBe(false);
    expect(isMarketDay(columbus)).toBe(true);
    expect(isNyseHoliday(veterans)).toBe(false);
    expect(isMarketDay(veterans)).toBe(true);
    expect(nextChicagoTradingDay("2026-10-09")).toBe("2026-10-12");
    expect(isNyseHoliday(new Date("2027-12-31T15:00:00Z"))).toBe(false);
    expect(isMarketDay(new Date("2027-12-31T15:00:00Z"))).toBe(true);
  });

  it("uses the New York date, so the holiday starts at midnight Eastern", () => {
    const stillWednesday = new Date("2026-11-26T04:30:00Z");
    const thursday = new Date("2026-11-26T05:30:00Z");
    expect(isNyseHoliday(stillWednesday)).toBe(false);
    expect(isMarketDay(stillWednesday)).toBe(true);
    expect(isNyseHoliday(thursday)).toBe(true);
    expect(isMarketDay(thursday)).toBe(false);
    expect(isMarketDay(new Date("2026-11-28T16:00:00Z"))).toBe(false);
    expect(isNyseHoliday(new Date("nope"))).toBe(false);
    expect(isMarketDay(new Date("nope"))).toBe(false);
  });

  it("does not count Thanksgiving 2026, and still counts the half day after it", () => {
    const tuesday = new Date("2026-11-24T15:00:00Z");
    expect(chicagoTradingDaysElapsed(tuesday, new Date("2026-11-25T15:00:00Z"))).toBe(1);
    expect(chicagoTradingDaysElapsed(tuesday, new Date("2026-11-26T15:00:00Z"))).toBe(1);
    expect(chicagoTradingDaysElapsed(tuesday, new Date("2026-11-27T15:00:00Z"))).toBe(2);
    expect(chicagoTradingDaysElapsed(tuesday, new Date("2026-11-30T15:00:00Z"))).toBe(3);
    expect(nextChicagoTradingDay("2026-11-25")).toBe("2026-11-27");
    expect(previousChicagoTradingDay("2026-11-27")).toBe("2026-11-25");
    expect(nextChicagoTradingDay("2026-11-26")).toBe("2026-11-27");
    expect(previousChicagoTradingDay("2026-11-30")).toBe("2026-11-27");
    expect(nextChicagoTradingDay("2026-12-24")).toBe("2026-12-28");
  });
});
