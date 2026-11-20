import { describe, expect, it } from "vitest";
import {
  computeGexLevels,
  contractGex,
  futuresPrice,
  gexCronDecision,
  mergeGexSeed,
  upsertGexRow,
  type GexContract,
  type GexRow,
} from "@/app/lib/gex";
import { gexSeedRows } from "@/app/lib/gexJob";

/**
 * Same two-expiry book used to check the port against gex.py:
 * Black-Scholes gamma on a 401-point spot grid, calls positive, puts negative.
 * Expected flip numbers were produced by that formula in Python.
 */
const BOOK: GexContract[] = [
  { expiration: "2026-11-02", dte: 0, strike: 100, putCall: "call", gamma: 0.05, iv: 0.2, openInterest: 50 },
  { expiration: "2026-11-02", dte: 0, strike: 90, putCall: "put", gamma: 0.04, iv: 0.25, openInterest: 40 },
  { expiration: "2026-11-20", dte: 18, strike: 105, putCall: "call", gamma: 0.01, iv: 0.2, openInterest: 20 },
  { expiration: "2026-11-02", dte: 0, strike: 95, putCall: "put", gamma: null, iv: 0.2, openInterest: 10 },
  { expiration: "2026-11-02", dte: 0, strike: 200, putCall: "call", gamma: 0.02, iv: 0.2, openInterest: 10 },
  { expiration: "2026-12-20", dte: 46, strike: 100, putCall: "call", gamma: 0.02, iv: 0.2, openInterest: 10 },
];

function row(over: Partial<GexRow> & Pick<GexRow, "date" | "underlying">): GexRow {
  return {
    runTimeCt: null,
    spot: null,
    dataTimestamp: null,
    totalGex: null,
    flip: null,
    flipFutures: null,
    callWall1: null,
    callWall2: null,
    callWall3: null,
    callWall1Futures: null,
    callWall2Futures: null,
    callWall3Futures: null,
    putWall1: null,
    putWall2: null,
    putWall3: null,
    putWall1Futures: null,
    putWall2Futures: null,
    putWall3Futures: null,
    nearExpiry: null,
    nearGex: null,
    nearFlip: null,
    nearFlipFutures: null,
    futuresSymbol: null,
    futuresPrice: null,
    ratio: null,
    gammaCoverage: null,
    source: null,
    ...over,
  };
}

describe("gamma level math", () => {
  it("matches gex.py on the fixture: sign, walls, flip, and the nearest expiry", () => {
    expect(contractGex({ gamma: 0.05, openInterest: 50, spot: 100, putCall: "call" })).toBe(25000);
    expect(contractGex({ gamma: 0.04, openInterest: 40, spot: 100, putCall: "put" })).toBe(-16000);
    const levels = computeGexLevels({ spot: 100, contracts: BOOK });
    expect(levels.totalGex).toBe(11000);
    expect(levels.callWalls).toEqual([100, 105, null]);
    expect(levels.putWalls).toEqual([90, null, null]);
    expect(levels.flip).toBeCloseTo(92.20047881163511, 6);
    expect(levels.nearExpiry).toBe("2026-11-02");
    expect(levels.nearGex).toBe(9000);
    expect(levels.nearFlip).toBeCloseTo(95.40863558050464, 6);
    expect(levels.used).toBe(3);
    expect(levels.inBand).toBe(4);
    expect(levels.gammaCoverage).toBe(75);
    expect(futuresPrice(levels.flip, 10)).toBe(922);
  });

  it("leaves the flip blank when no contract has an implied volatility", () => {
    const levels = computeGexLevels({
      spot: 100,
      contracts: [{ expiration: "2026-11-02", dte: 1, strike: 100, putCall: "call", gamma: 0.02, iv: null, openInterest: 10 }],
    });
    expect(levels.totalGex).toBe(2000);
    expect(levels.flip).toBeNull();
    expect(levels.callWalls[0]).toBe(100);
  });
});

describe("gamma seed and schedule", () => {
  it("merges the CSV rows only when that date and underlying are absent", () => {
    const seed = gexSeedRows();
    expect(seed).toHaveLength(30);
    expect(seed.filter((row) => row.underlying === "QQQ")).toHaveLength(15);
    expect(seed.filter((row) => row.underlying === "SPY")).toHaveLength(15);
    const first = seed.find((row) => row.date === "2026-11-02" && row.underlying === "QQQ");
    expect(first).toMatchObject({
      spot: 690.555,
      totalGex: -3742575042.574082,
      flip: 716.3438642908468,
      flipFutures: 29829.64,
      callWall1: 700,
      callWall2: 695,
      callWall3: 715,
      putWall1: 680,
      nearExpiry: "2026-11-02",
      futuresSymbol: "/NQZ26:XCME",
      futuresPrice: 28755.75,
      ratio: 41.64150574537872,
      gammaCoverage: 100,
      source: "Tastytrade",
      runTimeCt: "08:04",
    });
    const stored = row({ date: "2026-11-02", underlying: "QQQ", spot: 1 });
    const merged = mergeGexSeed([stored], seed);
    expect(merged.find((row) => row.date === "2026-11-02" && row.underlying === "QQQ")?.spot).toBe(1);
    expect(merged.find((row) => row.date === "2026-11-02" && row.underlying === "SPY")?.spot).toBe(755.7);
    expect(merged.filter((row) => row.date === "2026-11-02" && row.underlying === "QQQ")).toHaveLength(1);
  });

  it("skips a full-day holiday and runs at 8:05am Chicago in both daylight offsets", () => {
    expect(gexCronDecision(new Date("2026-11-26T14:05:00Z"), true)).toEqual({ run: false, reason: "market holiday" });
    expect(gexCronDecision(new Date("2026-07-16T13:05:00Z"), false).run).toBe(true);
    expect(gexCronDecision(new Date("2026-07-16T13:04:00Z"), false).run).toBe(false);
    expect(gexCronDecision(new Date("2026-07-16T14:05:00Z"), false).run).toBe(false);
    expect(gexCronDecision(new Date("2026-11-20T14:05:00Z"), false).run).toBe(true);
    expect(gexCronDecision(new Date("2026-11-20T13:05:00Z"), false).run).toBe(false);
    expect(gexCronDecision(new Date("2026-07-16T13:15:00Z"), false).run).toBe(true);
    expect(gexCronDecision(new Date("2026-11-20T14:15:00Z"), false).run).toBe(true);
  });

  it("overwrites the same date and underlying", () => {
    const first = row({ date: "2026-07-16", underlying: "QQQ", spot: 100, flip: 90 });
    const other = row({ date: "2026-07-16", underlying: "SPY", spot: 50 });
    const next = upsertGexRow(upsertGexRow([], first), other);
    const replaced = upsertGexRow(next, row({ date: "2026-07-16", underlying: "QQQ", spot: 111 }));
    expect(replaced.map((row) => `${row.underlying}:${row.spot}`)).toEqual(["QQQ:111", "SPY:50"]);
  });
});
