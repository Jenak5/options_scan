import { describe, expect, it } from "vitest";
import { PRINT_RULES } from "@/app/lib/alertConfig";
import { flowScore } from "@/app/lib/flow";
import {
  NOT_EXCHANGE_SWEEP,
  PRINT_SOURCE,
  detectPrints,
  quotePointFromContract,
  type FlowQuotePoint,
} from "@/app/lib/prints";

function point(over: Partial<FlowQuotePoint> = {}): FlowQuotePoint {
  return {
    at: 1_000,
    volume: 100,
    last: 2,
    lastSize: 10,
    bid: 1.9,
    ask: 2,
    tradeTime: 1_000,
    ...over,
  };
}

describe("quote prints", () => {
  it("does not invent a print from a single quote", () => {
    const read = detectPrints({ points: [point()] });
    expect(read.summary).toBeNull();
    expect(read.block).toBe(false);
    expect(read.sweepLike).toBe(false);
  });

  it("calls a large last size a block and does not treat the volume change as one print", () => {
    const read = detectPrints({
      points: [
        point({ at: 1_000, volume: 100, tradeTime: 1_000, lastSize: 1 }),
        point({
          at: 2_000,
          volume: 600,
          tradeTime: 2_000,
          lastSize: PRINT_RULES.blockMinContracts,
          last: 2,
          ask: 2,
          bid: 1.8,
        }),
      ],
    });
    expect(read.block).toBe(true);
    expect(read.sweepLike).toBe(false);
    expect(read.summary).toContain(PRINT_SOURCE);
    expect(read.summary).toContain("block print");
    expect(read.summary).toContain(NOT_EXCHANGE_SWEEP);
    expect(read.summary?.includes("exchange-reported sweep") && read.summary.includes("Not an exchange-reported sweep")).toBe(true);
  });

  it("does not call a volume increase a block when the last size is small", () => {
    const read = detectPrints({
      points: [
        point({ volume: 10, tradeTime: 1_000, lastSize: 1 }),
        point({ at: 2_000, volume: 5_010, tradeTime: 2_000, lastSize: 4, last: 1, ask: 1, bid: 0.9 }),
      ],
    });
    expect(read.block).toBe(false);
    expect(read.summary).toContain("only the last size is one print");
    expect(read.summary).toContain("5000");
    expect(read.summary?.includes("block print")).toBe(false);
  });

  it("flags a sweep-like burst only when several trade times land inside the window on one side", () => {
    const start = 10_000;
    const points = [point({ at: start, volume: 0, tradeTime: start, lastSize: 1 })];
    for (let i = 1; i <= PRINT_RULES.sweepMinPrints; i++) {
      points.push(point({
        at: start + i * 1_000,
        volume: i * 10,
        tradeTime: start + i * 1_000,
        lastSize: 10,
        last: 2.05,
        ask: 2,
        bid: 1.9,
      }));
    }
    const burst = detectPrints({ points });
    expect(burst.sweepLike).toBe(true);
    expect(burst.summary).toContain("sweep-like burst");
    expect(burst.summary).toContain("at the ask");
    expect(burst.summary).toContain(NOT_EXCHANGE_SWEEP);

    const slow = points.map((row, index) => ({
      ...row,
      at: start + index * 60_000,
      tradeTime: start + index * 60_000,
    }));
    expect(detectPrints({ points: slow }).sweepLike).toBe(false);
  });

  it("does not call a delayed burst sweep-like", () => {
    const start = 10_000;
    const points = [point({ volume: 0, tradeTime: start })];
    for (let i = 1; i <= 3; i++) {
      points.push(point({
        at: start + i * 1_000,
        volume: i * 8,
        tradeTime: start + i * 1_000,
        last: 1.5,
        bid: 1.5,
        ask: 1.7,
      }));
    }
    const read = detectPrints({ points, delayed: true });
    expect(read.sweepLike).toBe(false);
    expect(read.summary).toContain("Quotes were delayed.");
    expect(read.summary).toContain("at the bid");
  });

  it("treats a trade through the ask as at the ask", () => {
    const read = detectPrints({
      points: [
        point({ at: 1_000, volume: 1, tradeTime: 1_000, lastSize: 1 }),
        point({ at: 2_000, volume: 6, tradeTime: 2_000, lastSize: 5, last: 3, ask: 2, bid: 1 }),
      ],
    });
    expect(read.side).toBe("at ask");
    expect(read.summary).toContain("at the ask");
  });

  it("reads last size off a contract and raises the flow score for a block", () => {
    const quote = quotePointFromContract({
      bid: 1,
      ask: 1.1,
      last: 1.1,
      volume: 20,
      openInterest: 50,
      delta: null,
      iv: null,
      strike: 100,
      expiration: "2026-10-08",
      putCall: "call",
      lastSize: 12,
      tradeTime: 50,
    }, 50);
    expect(quote.lastSize).toBe(12);
    expect(quote.tradeTime).toBe(50);

    const base = {
      notionalPremium: 80_000,
      volOiRatio: 1,
      volumeExceedsOi: false,
      volumeJump: 10,
      otmFraction: 0.04,
      dte: 7,
      spreadQuality: "acceptable" as const,
      side: "estimated at ask" as const,
    };
    expect(flowScore({ ...base, block: true, printDetected: true })).toBeGreaterThan(flowScore(base));
    expect(flowScore({ ...base, sweepLike: true, printDetected: true })).toBeGreaterThan(
      flowScore({ ...base, block: true, printDetected: true }),
    );
  });
});
