import { describe, expect, it } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  replayCandleExit,
  usableCandleBars,
  whatIfFromShadows,
  WHAT_IF_SCENARIOS,
} from "@/app/lib/exitWhatIf";
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
});
