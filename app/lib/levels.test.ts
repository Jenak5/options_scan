import { describe, expect, it } from "vitest";
import { computeKeyLevels, formatLevelsSummary, sma20FromDaily, toStoredLevels } from "@/app/lib/levels";
import type { PriceCandle } from "@/app/lib/schwabParse";

const NOW = new Date("2026-10-01T15:00:00Z");

function candle(iso: string, over: Partial<PriceCandle> = {}): PriceCandle {
  return {
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
    datetime: Date.parse(iso),
    ...over,
  };
}

describe("key levels", () => {
  it("uses the prior session and ignores today's daily bar", () => {
    const levels = computeKeyLevels({
      spot: 110,
      now: NOW,
      intraday: [],
      daily: [
        candle("2026-09-30T13:30:00Z", { high: 112, low: 90, close: 108 }),
        candle("2026-10-01T13:30:00Z", { high: 200, low: 50, close: 140 }),
      ],
    });
    expect(levels.checked).toBe(true);
    expect(levels.priorClose).toBe(108);
    expect(levels.support).toMatchObject({ price: 108, label: "prior close" });
    expect(levels.resistance).toMatchObject({ price: 112, label: "prior day high" });
    expect(levels.support?.distance).toBeCloseTo(2 / 110);
    expect(levels.resistance?.distance).toBeCloseTo(2 / 110);
    expect(levels.sma20).toBeNull();
  });

  it("averages the last 20 completed daily closes and ignores today", () => {
    const daily = [];
    for (let i = 0; i < 20; i++) {
      const day = String(i + 1).padStart(2, "0");
      daily.push(candle(`2026-09-${day}T13:30:00Z`, { close: i + 1 }));
    }
    daily.push(candle("2026-10-01T13:30:00Z", { close: 999 }));
    expect(sma20FromDaily(daily, "2026-10-01")).toBeCloseTo(10.5);
    expect(computeKeyLevels({ spot: 110, now: NOW, daily, intraday: [] }).sma20).toBeCloseTo(10.5);
  });

  it("reads pre-market, the open, the open range, and the regular-session high and low", () => {
    const levels = computeKeyLevels({
      spot: 102,
      now: NOW,
      daily: [candle("2026-09-30T13:30:00Z", { high: 130, low: 70, close: 80 })],
      intraday: [
        candle("2026-10-01T12:00:00Z", { high: 101, low: 97, open: 98, close: 100, volume: 0 }),
        candle("2026-10-01T13:30:00Z", { open: 100.2, high: 103, low: 100, close: 102, volume: 0 }),
        candle("2026-10-01T14:30:00Z", { open: 102, high: 108, low: 97, close: 106, volume: 0 }),
        candle("2026-10-01T20:05:00Z", { high: 104, low: 96, close: 101, volume: 0 }),
      ],
    });
    expect(levels.checked).toBe(true);
    expect(levels.resistance).toMatchObject({ price: 103, label: "open range high" });
    expect(levels.support?.price).not.toBe(104);
    expect(levels.resistance?.price).not.toBe(104);
    expect(levels.support?.price).not.toBe(96);
  });

  it("estimates VWAP from regular-session typical price and volume", () => {
    const levels = computeKeyLevels({
      spot: 101.7,
      now: NOW,
      daily: [candle("2026-09-30T13:30:00Z", { high: 90, low: 80, close: 85 })],
      intraday: [
        candle("2026-10-01T13:30:00Z", { high: 102, low: 100, close: 101.5, volume: 1000 }),
        candle("2026-10-01T14:00:00Z", { high: 103, low: 100.2, close: 102, volume: 2000 }),
      ],
    });
    const typicalA = (102 + 100 + 101.5) / 3;
    const typicalB = (103 + 100.2 + 102) / 3;
    const vwap = (typicalA * 1000 + typicalB * 2000) / 3000;
    expect(levels.vwap).toBeCloseTo(vwap);
    expect(levels.support).toMatchObject({ price: Math.round(vwap * 100) / 100, label: "VWAP" });
    expect(levels.resistance).toMatchObject({ price: 102, label: "open range high" });
  });

  it("finds swing highs and lows on the recent daily bars", () => {
    const days = [21, 22, 23, 24, 25, 26, 27, 28, 29];
    const highs = [50.2, 50.3, 50.4, 50.5, 51, 50.5, 50.4, 50.3, 60];
    const lows = [49.8, 49.7, 49.6, 49.5, 49, 49.5, 49.6, 49.7, 30];
    const daily = days.map((day, index) => candle(`2026-09-${day}T14:00:00Z`, {
      high: highs[index],
      low: lows[index],
      open: 50,
      close: index === days.length - 1 ? 40 : 50,
    }));
    const levels = computeKeyLevels({ spot: 50, now: NOW, daily, intraday: [] });
    expect(levels.checked).toBe(true);
    expect(levels.support).toMatchObject({ price: 49, label: "swing low" });
    expect(levels.resistance).toMatchObject({ price: 51, label: "swing high" });
  });

  it("uses round numbers and high-open-interest strikes once history exists", () => {
    const levels = computeKeyLevels({
      spot: 572.4,
      now: NOW,
      daily: [candle("2026-09-30T13:30:00Z", { high: 400, low: 300, close: 350 })],
      intraday: [],
      contracts: [
        { strike: 580, putCall: "call", openInterest: 100 },
        { strike: 573, putCall: "call", openInterest: 9_000 },
        { strike: 560, putCall: "put", openInterest: 4_000 },
        { strike: 571, putCall: "put", openInterest: 4_000 },
      ],
    });
    expect(levels.checked).toBe(true);
    expect(levels.callWall).toBe(573);
    expect(levels.putWall).toBe(571);
    expect(levels.support).toMatchObject({ price: 571, label: "put wall" });
    expect(levels.resistance).toMatchObject({ price: 573, label: "call wall" });
    const stored = toStoredLevels(levels);
    expect(stored?.supportLabel).toBe("put wall");
    expect(formatLevelsSummary(stored!)).toMatch(/Support \$571\.00 \(put wall\)/);
    expect(formatLevelsSummary(stored!)).toMatch(/Resistance \$573\.00 \(call wall\)/);
  });

  it("does not treat round numbers or walls as a successful history read", () => {
    const rounds = computeKeyLevels({ spot: 100, now: NOW, daily: [], intraday: [] });
    expect(rounds.checked).toBe(false);
    expect(rounds.support?.label).toBe("round number");
    expect(toStoredLevels(rounds)).toBeNull();

    const walls = computeKeyLevels({
      spot: 100,
      now: NOW,
      daily: [],
      intraday: [],
      contracts: [
        { strike: 105, putCall: "call", openInterest: 8_000 },
        { strike: 95, putCall: "put", openInterest: 8_000 },
      ],
    });
    expect(walls.checked).toBe(false);
    expect(walls.callWall).toBe(105);
    expect(walls.putWall).toBe(95);
    expect(computeKeyLevels({ spot: null, now: NOW, daily: [candle("2026-09-30T13:30:00Z")], intraday: [] }).checked).toBe(false);
  });
});
