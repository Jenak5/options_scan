import { describe, expect, it } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  replayCandleExit,
  usableCandleBars,
  whatIfFromShadows,
  WHAT_IF_CANDLE_BUDGET_MS,
  WHAT_IF_SCENARIOS,
  type WhatIfPath,
  type WhatIfScenario,
} from "@/app/lib/exitWhatIf";
import { chicagoDate, chicagoTradingDaysElapsed } from "@/app/lib/marketHours";
import type { ShadowTrade } from "@/app/lib/shadow";

const OPEN = Date.parse("2026-10-01T15:00:00Z");
const EXPIRATION = "2026-12-18";

function scenario(id: string) {
  const found = WHAT_IF_SCENARIOS.find((row) => row.id === id);
  if (!found) throw new Error(id);
  return found;
}

function bar(at: number, o: number, h: number, l: number, c: number): CandleBar {
  return { t: at, o, h, l, c };
}

function shadow(over: Partial<ShadowTrade> = {}): ShadowTrade {
  return {
    id: "candlepath0000001",
    alertId: "candlepath0000001",
    openedAt: OPEN,
    ticker: "SPY",
    putCall: "call",
    strike: 670,
    expiration: EXPIRATION,
    grade: "A",
    cohort: "ab",
    experimentLabel: null,
    probeGrade: null,
    features: null,
    rulesVersion: 3,
    marks: [{ at: OPEN + 60_000, price: 3.2 }],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 1,
    contracts: 1,
    entryPrice: 2,
    entryPriceSource: "ask",
    status: "closed",
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    exitQuote: null,
    exitStale: false,
    pnlDollars: null,
    pnlFraction: null,
    tradingDaysHeld: null,
    lastMark: null,
    lastMarkSource: null,
    lastMarkedAt: null,
    ...over,
  };
}

describe("1-minute stop, target, and gaps", () => {
  const input = {
    entryPrice: 2,
    openedAt: OPEN,
    expiration: EXPIRATION,
  };

  it("stops on the low and takes the target on the high", () => {
    const stopped = replayCandleExit({
      ...input,
      candles: [bar(OPEN + 60_000, 2, 2.2, 1.45, 1.6)],
    }, scenario("stop25"));
    expect(stopped?.ambiguous).toBe(false);
    expect(stopped?.exit?.pnlDollars).toBeCloseTo(-50);
    expect(stopped?.at).toBe(OPEN + 60_000);

    const target = replayCandleExit({
      ...input,
      candles: [bar(OPEN + 60_000, 2, 2.85, 1.9, 2.7)],
    }, scenario("tp40"));
    expect(target?.ambiguous).toBe(false);
    expect(target?.exit?.pnlDollars).toBeCloseTo(80);
  });

  it("counts a candle that touches the stop and the target as a stop and flags it ambiguous", () => {
    const both = replayCandleExit({
      ...input,
      candles: [bar(OPEN + 60_000, 2, 3, 1.2, 2)],
    }, scenario("tp40"));
    expect(both?.ambiguous).toBe(true);
    expect(both?.exit?.pnlDollars).toBeCloseTo(-50);
    expect(both?.barsUsed).toBe(1);
  });

  it("leaves minutes with no trades as gaps and does not fill or interpolate them", () => {
    const later = OPEN + 10 * 60_000;
    const candles = [
      bar(OPEN + 60_000, 2.1, 2.1, 2.1, 2.1),
      bar(later, 2.2, 2.2, 2.2, 2.2),
    ];
    const quiet = replayCandleExit({ ...input, candles }, scenario("tp40"));
    expect(usableCandleBars(candles, OPEN)).toHaveLength(2);
    expect(quiet?.barsUsed).toBe(2);
    expect(quiet?.exit).toBeNull();

    const jumped = replayCandleExit({
      ...input,
      candles: [
        bar(OPEN + 60_000, 2.1, 2.1, 2.1, 2.1),
        bar(later, 2.7, 2.9, 2.6, 2.75),
      ],
    }, scenario("tp40"));
    expect(jumped?.barsUsed).toBe(2);
    expect(jumped?.at).toBe(later);
    expect(jumped?.exit?.pnlDollars).toBeCloseTo(80);
    expect(jumped?.ambiguous).toBe(false);
  });

  it("fills a gap through the stop at the next trade, not at a made-up minute", () => {
    const later = OPEN + 10 * 60_000;
    const gapped = replayCandleExit({
      ...input,
      candles: [
        bar(OPEN + 60_000, 2.1, 2.1, 2.1, 2.1),
        bar(later, 1.1, 1.2, 1, 1.1),
      ],
    }, scenario("stop25"));
    expect(gapped?.at).toBe(later);
    expect(gapped?.barsUsed).toBe(2);
    expect(gapped?.exit?.pnlDollars).toBeCloseTo(-90);
    expect(gapped?.ambiguous).toBe(false);
  });

  it("uses candles instead of 15-minute marks and labels the source", () => {
    const candles = new Map<string, CandleBar[]>([
      ["SPY|2026-12-18|670|call", [bar(OPEN + 60_000, 2, 2.2, 1.9, 2.1)]],
    ]);
    const report = whatIfFromShadows([shadow()], { candles });
    const tp60 = report.scenarios.find((row) => row.id === "tp60");
    expect(tp60?.source).toBe("1m");
    expect(tp60?.resolved).toBe(0);
    expect(tp60?.ambiguous).toBe(0);
    expect(report.candlePaths).toBe(1);
    expect(report.markPaths).toBe(0);
    expect(report.coverageNote).toMatch(/1-minute/);
    expect(report.coverageNote).toMatch(/gap/i);

    const marksOnly = whatIfFromShadows([shadow()]);
    expect(marksOnly.scenarios.find((row) => row.id === "tp60")?.source).toBe("15m");
    expect(marksOnly.scenarios.find((row) => row.id === "tp60")?.resolved).toBe(1);
    expect(marksOnly.markPaths).toBe(1);
  });

  it("labels a mix of candle paths and 15-minute paths", () => {
    const withMarks = shadow({ id: "marksonly0000001", ticker: "QQQ", strike: 500 });
    const candles = new Map<string, CandleBar[]>([
      ["SPY|2026-12-18|670|call", [bar(OPEN + 60_000, 2, 2.2, 1.4, 1.5)]],
    ]);
    const report = whatIfFromShadows([shadow(), withMarks], { candles });
    expect(report.candlePaths).toBe(1);
    expect(report.markPaths).toBe(1);
    expect(report.scenarios.every((row) => row.source === "mixed")).toBe(true);
    const stop = report.scenarios.find((row) => row.id === "stop25");
    expect(stop?.ambiguous).toBe(0);
    expect(stop?.losses).toBe(1);
  });

  it("exits a time stop at Chicago midnight, and skips Thanksgiving", () => {
    const open = Date.parse("2026-10-01T15:00:00Z");
    const beforeMonday = Date.parse("2026-10-05T04:59:00Z");
    const monday = Date.parse("2026-10-05T05:00:00Z");
    expect(chicagoDate(new Date(beforeMonday))).toBe("2026-10-04");
    expect(chicagoDate(new Date(monday))).toBe("2026-10-05");
    expect(chicagoTradingDaysElapsed(new Date(open), new Date(beforeMonday))).toBe(1);
    expect(chicagoTradingDaysElapsed(new Date(open), new Date(monday))).toBe(2);
    const quiet = (at: number) => bar(at, 2, 2.05, 1.95, 2.02);
    const early = replayCandleExit({
      entryPrice: 2,
      openedAt: open,
      expiration: EXPIRATION,
      candles: [quiet(beforeMonday)],
    }, scenario("time2"));
    expect(early?.exit).toBeNull();
    const onTime = replayCandleExit({
      entryPrice: 2,
      openedAt: open,
      expiration: EXPIRATION,
      candles: [quiet(beforeMonday), quiet(monday)],
    }, scenario("time2"));
    expect(onTime?.at).toBe(monday);
    expect(onTime?.exit?.pnlDollars).toBeCloseTo(2);

    const tuesday = Date.parse("2026-11-24T15:00:00Z");
    const thanksgiving = Date.parse("2026-11-26T15:00:00Z");
    const friday = Date.parse("2026-11-27T15:00:00Z");
    const holiday = replayCandleExit({
      entryPrice: 2,
      openedAt: tuesday,
      expiration: EXPIRATION,
      candles: [quiet(thanksgiving), bar(friday, 2.02, 2.06, 1.96, 2.04)],
    }, scenario("time2"));
    expect(holiday?.at).toBe(friday);
    expect(holiday?.exit?.pnlDollars).toBeCloseTo(4);
    expect(replayCandleExit({
      entryPrice: 2,
      openedAt: tuesday,
      expiration: EXPIRATION,
      candles: [quiet(thanksgiving), bar(friday, 2.02, 2.06, 1.96, 2.04)],
    }, scenario("time3"))?.exit).toBeNull();
  });

  it("exits in the last week from New York midnight, before a flat time stop", () => {
    const expiration = "2026-10-16";
    const open = Date.parse("2026-10-01T15:00:00Z");
    const before = Date.parse("2026-10-09T03:59:00Z");
    const at = Date.parse("2026-10-09T04:00:00Z");
    const rule: WhatIfScenario = {
      id: "lastweek",
      label: "last week",
      profitFraction: null,
      stopFraction: -0.9,
      flatDays: 40,
      trailArm: null,
      trailGiveback: null,
    };
    const quiet = (t: number) => bar(t, 2, 2.05, 1.95, 2);
    expect(replayCandleExit({
      entryPrice: 2,
      openedAt: open,
      expiration,
      candles: [quiet(before)],
    }, rule)?.exit).toBeNull();
    const exited = replayCandleExit({
      entryPrice: 2,
      openedAt: open,
      expiration,
      candles: [quiet(before), quiet(at)],
    }, rule);
    expect(exited?.at).toBe(at);
    expect(exited?.exit?.pnlDollars).toBeCloseTo(0);
  });

  it("stops at the candle budget and labels the rest as 15-minute marks", () => {
    expect(WHAT_IF_CANDLE_BUDGET_MS).toBe(45_000);
    const candles = new Map<string, CandleBar[]>([
      ["SPY|2026-12-18|670|call", [bar(OPEN + 60_000, 2, 2.2, 1.9, 2.1)]],
      ["QQQ|2026-12-18|500|call", [bar(OPEN + 60_000, 2, 2.2, 1.9, 2.1)]],
    ]);
    const second = shadow({ id: "budgetpath000002", ticker: "QQQ", strike: 500 });
    let clock = 0;
    const report = whatIfFromShadows([shadow(), second], {
      candles,
      budgetMs: WHAT_IF_CANDLE_BUDGET_MS,
      nowMs: () => {
        const value = clock;
        clock += 30_000;
        return value;
      },
    });
    expect(report.candlePaths).toBe(1);
    expect(report.markPaths).toBe(1);
    expect(report.scenarios.every((row) => row.source === "mixed")).toBe(true);
    expect(report.coverageNote).toMatch(/time budget/);
    expect(report.coverageNote).toMatch(/5-minute/);

    const stopped = whatIfFromShadows([shadow()], { candles, budgetMs: 0 });
    expect(stopped.candlePaths).toBe(0);
    expect(stopped.markPaths).toBe(1);
    expect(stopped.scenarios.every((row) => row.source === "15m")).toBe(true);
    expect(stopped.coverageNote).toMatch(/time budget/);
    expect(stopped.scenarios.find((row) => row.id === "tp40")?.resolved).toBe(1);
  });

  it("replays about 450 paths of 3000 bars across every scenario within a few seconds", () => {
    const pathCount = 450;
    const barCount = 3_000;
    const start = Date.parse("2026-09-08T13:30:00Z");
    const candles: CandleBar[] = [];
    for (let i = 0; i < barCount; i++) {
      const t = start + i * 60_000;
      candles.push(bar(t, 2, 2.05, 1.95, 2));
    }
    const research: WhatIfPath[] = [];
    for (let i = 0; i < pathCount; i++) {
      research.push({
        grade: i % 2 === 0 ? "C" : "D",
        entryPrice: 2,
        openedAt: start,
        expiration: EXPIRATION,
        marks: [{ at: start + 60_000, price: 2.1 }],
        candles,
      });
    }
    const started = Date.now();
    const report = whatIfFromShadows([], { grades: ["C", "D"], research });
    const elapsed = Date.now() - started;
    expect(report.included).toBe(pathCount);
    expect(report.candlePaths).toBe(pathCount);
    expect(report.markPaths).toBe(0);
    expect(report.scenarios).toHaveLength(WHAT_IF_SCENARIOS.length);
    expect(report.scenarios.every((row) => row.source === "1m")).toBe(true);
    expect(report.scenarios.find((row) => row.id === "time2")?.resolved).toBe(pathCount);
    expect(report.scenarios.find((row) => row.id === "time5")?.resolved).toBe(0);
    expect(elapsed).toBeLessThan(5_000);
  });
});
