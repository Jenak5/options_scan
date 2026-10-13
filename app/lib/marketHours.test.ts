import { describe, expect, it } from "vitest";
import { OUTCOME_RULES } from "@/app/lib/alertConfig";
import { newYorkDate } from "@/app/lib/flow";
import { chicagoDate, chicagoTradingDayCutoffMs, chicagoTradingDaysElapsed, isChicagoMarketHours, isChicagoMinuteWindow, isMarketDay, isNyseHoliday, nextChicagoTradingDay, previousChicagoTradingDay } from "@/app/lib/marketHours";

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

  it("matches Chicago and New York calendar dates through the daylight change", () => {
    const chicago = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const ny = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const samples: number[] = [];
    const start = Date.parse("2026-01-01T00:30:00Z");
    const end = Date.parse("2027-12-31T23:30:00Z");
    for (let t = start; t <= end; t += 6 * 3_600_000) samples.push(t);
    const dense = [
      Date.parse("2026-03-08T06:00:00Z"),
      Date.parse("2026-03-08T07:30:00Z"),
      Date.parse("2026-03-08T12:30:00Z"),
      Date.parse("2026-11-01T04:30:00Z"),
      Date.parse("2026-11-01T05:30:00Z"),
      Date.parse("2026-11-01T06:30:00Z"),
      Date.parse("2027-03-14T06:30:00Z"),
      Date.parse("2027-03-14T08:30:00Z"),
      Date.parse("2027-11-07T05:30:00Z"),
      Date.parse("2027-11-07T07:30:00Z"),
    ];
    for (let i = 0; i < dense.length; i++) {
      for (let minute = -90; minute <= 90; minute += 15) samples.push(dense[i] + minute * 60_000);
    }
    for (let i = 0; i < samples.length; i++) {
      const date = new Date(samples[i]);
      expect(chicagoDate(date)).toBe(chicago.format(date));
      expect(newYorkDate(date)).toBe(ny.format(date));
    }
  });

  it("puts the flat-day cutoff at Chicago midnight, and skips Thanksgiving", () => {
    const open = new Date("2026-10-01T15:00:00Z");
    const cutoff = chicagoTradingDayCutoffMs(open, 2);
    expect(cutoff).toBe(Date.parse("2026-10-05T05:00:00Z"));
    expect(chicagoTradingDaysElapsed(open, new Date(cutoff! - 60_000))).toBe(1);
    expect(chicagoTradingDaysElapsed(open, new Date(cutoff!))).toBe(2);

    const tuesday = new Date("2026-11-24T15:00:00Z");
    const afterHoliday = chicagoTradingDayCutoffMs(tuesday, 2);
    expect(afterHoliday).toBe(Date.parse("2026-11-27T06:00:00Z"));
    expect(chicagoTradingDaysElapsed(tuesday, new Date("2026-11-26T15:00:00Z"))).toBe(1);
    expect(chicagoTradingDaysElapsed(tuesday, new Date(afterHoliday!))).toBe(2);
  });
});
