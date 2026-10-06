import { describe, expect, it } from "vitest";
import { parseFeatureSnapshot } from "@/app/lib/alertFeatures";
import {
  carryPriorSession,
  detectPairedFlow,
  ivVersusRecent,
  openingNoise,
  repeatFromSnapshot,
  trendFromPrices,
  type PairContract,
} from "@/app/lib/marketContext";

const CALL: PairContract = { strike: 100, expiration: "2026-10-16", putCall: "call", volume: 200 };

describe("trend and the open", () => {
  it("needs both VWAP and the 20-day average on the wrong side before the trend is against", () => {
    expect(trendFromPrices("call", 110, 100, 105).trendAlignment).toBe("with");
    expect(trendFromPrices("call", 90, 100, 105).trendAlignment).toBe("against");
    expect(trendFromPrices("put", 90, 100, 105).trendAlignment).toBe("with");
    expect(trendFromPrices("call", 90, 100, null).trendAlignment).toBe("unknown");
    expect(trendFromPrices("call", 100, 100, 100).trendAlignment).toBe("unknown");
  });

  it("treats the first 15 Chicago minutes as noisy and the 15th minute as clear", () => {
    expect(openingNoise(new Date("2026-05-14T13:40:00Z"))).toBe(true);
    expect(openingNoise(new Date("2026-05-14T13:45:00Z"))).toBe(false);
    expect(openingNoise(new Date("2026-05-16T13:40:00Z"))).toBe(false);
    expect(openingNoise(new Date("2026-05-14T21:00:00Z"))).toBe(false);
  });
});

describe("paired flow", () => {
  it("reads a neighboring strike as a spread and the opposite side as a hedge", () => {
    expect(detectPairedFlow(CALL, [CALL])).toBe("unknown");
    expect(detectPairedFlow(CALL, [
      CALL,
      { strike: 101, expiration: "2026-10-16", putCall: "call", volume: 150 },
    ])).toBe("spread");
    expect(detectPairedFlow(CALL, [
      CALL,
      { strike: 100, expiration: "2026-10-16", putCall: "put", volume: 180 },
    ])).toBe("hedge");
    expect(detectPairedFlow(CALL, [
      CALL,
      { strike: 101, expiration: "2026-10-16", putCall: "call", volume: 160 },
      { strike: 100, expiration: "2026-10-16", putCall: "put", volume: 170 },
    ])).toBe("hedge");
    expect(detectPairedFlow(CALL, [
      { strike: 101, expiration: "2026-10-16", putCall: "call", volume: 40 },
    ])).toBe("none");
    expect(detectPairedFlow(CALL, [
      { strike: 101, expiration: "2026-10-16", putCall: "call", volume: 150 },
      { strike: 110, expiration: "2026-10-16", putCall: "call", volume: 200 },
    ])).toBe("spread");
  });
});

describe("prior session memory", () => {
  it("keeps yesterday's volume and IV when today's scan replaces the snapshot", () => {
    const yesterday = Date.parse("2026-10-01T15:00:00Z");
    const today = new Date("2026-10-02T15:00:00Z");
    const key = "2026-10-16|100|call";
    const previous = {
      scannedAt: yesterday,
      volumes: { [key]: 200 },
      ivs: { [key]: 0.3 },
    };
    const next = {
      scannedAt: today.getTime(),
      volumes: { [key]: 50 },
      ivs: { [key]: 0.4 },
    };
    const carried = carryPriorSession(previous, next, today);
    expect(carried.priorSession?.volumes[key]).toBe(200);
    expect(carried.priorSession?.ivs?.[key]).toBe(0.3);
    expect(repeatFromSnapshot(key, carried)).toBe("contract");
    expect(ivVersusRecent(0.4, carried.priorSession?.ivs?.[key])).toBeCloseTo(0.4 / 0.3 - 1);

    const later = carryPriorSession(carried, { ...next, volumes: { [key]: 80 } }, today);
    expect(later.priorSession?.volumes[key]).toBe(200);
    expect(carryPriorSession(undefined, next, today).priorSession).toBeUndefined();
  });
});

describe("feature snapshot", () => {
  it("keeps the new fields and leaves them blank on an older snapshot", () => {
    const saved = parseFeatureSnapshot({
      version: 1,
      capturedAtAlert: true,
      flowPremium: 100_000,
      side: "estimated at ask",
      minutesSinceOpen: 40,
      priceVsVwap: "above",
      priceVsSma20: "above",
      trendAlignment: "with",
      spyDirection: "up",
      qqqDirection: "up",
      marketAlignment: "with",
      ivVsRecent: 0.12,
      aggressor: "buy",
      repeatFlow: "contract",
      pairedFlow: "none",
    });
    expect(saved?.minutesSinceOpen).toBe(40);
    expect(saved?.trendAlignment).toBe("with");
    expect(saved?.marketAlignment).toBe("with");
    expect(saved?.ivVsRecent).toBeCloseTo(0.12);
    expect(saved?.repeatFlow).toBe("contract");
    expect(saved?.pairedFlow).toBe("none");

    const older = parseFeatureSnapshot({
      version: 1,
      capturedAtAlert: true,
      flowPremium: 100_000,
      side: "estimated at bid",
      earnings: "none",
    });
    expect(older?.trendAlignment).toBeNull();
    expect(older?.marketAlignment).toBeNull();
    expect(older?.pairedFlow).toBeNull();
    expect(older?.repeatFlow).toBeNull();
    expect(older?.ivVsRecent).toBeNull();
    expect(older?.minutesSinceOpen).toBeNull();
    expect(older?.aggressor).toBe("sell");
  });
});
