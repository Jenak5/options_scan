import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GexRow, GexUnderlying } from "@/app/lib/gex";
import { parseGexBook } from "@/app/lib/gex";
import { loadGexRows, runGexJob } from "@/app/lib/gexJob";
import { SCAN_TIME_BUDGET_MS } from "@/app/lib/scanHealth";
import { clearMemoryStoreForTests, readGexText } from "@/app/lib/schwabStore";

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "SESSION_SECRET",
  "NODE_ENV",
  "VERCEL",
] as const;

const saved: Record<string, string | undefined> = {};

function level(symbol: GexUnderlying, spot: number): GexRow {
  return {
    date: "2026-07-16",
    runTimeCt: "08:05",
    underlying: symbol,
    spot,
    dataTimestamp: null,
    totalGex: symbol === "QQQ" ? -1 : 2,
    flip: spot + 1,
    flipFutures: null,
    callWall1: spot + 5,
    callWall2: null,
    callWall3: null,
    callWall1Futures: null,
    callWall2Futures: null,
    callWall3Futures: null,
    putWall1: spot - 5,
    putWall2: null,
    putWall3: null,
    putWall1Futures: null,
    putWall2Futures: null,
    putWall3Futures: null,
    nearExpiry: "2026-07-16",
    nearGex: null,
    nearFlip: null,
    nearFlipFutures: null,
    futuresSymbol: null,
    futuresPrice: null,
    ratio: null,
    gammaCoverage: 90,
    source: "Tastytrade",
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearMemoryStoreForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearMemoryStoreForTests();
  vi.restoreAllMocks();
});

describe("gamma collection job", () => {
  it("uses the scanner time budget and does not read a chain on a holiday", async () => {
    expect(SCAN_TIME_BUDGET_MS).toBe(240_000);
    const loadUnderlying = vi.fn(async () => level("QQQ", 1));
    const holiday = await runGexJob({
      now: new Date("2026-11-26T14:05:00Z"),
      manual: true,
      loadUnderlying,
    });
    expect(holiday).toMatchObject({ ok: true, skipped: "market holiday" });
    expect(loadUnderlying).not.toHaveBeenCalled();
    expect(await readGexText()).toBeNull();
  });

  it("upserts a later run and shows the seed when the book is empty", async () => {
    const page = await loadGexRows();
    expect(page).toHaveLength(30);
    let spot = 100;
    await runGexJob({
      now: new Date("2026-07-16T13:05:00Z"),
      loadUnderlying: async (symbol) => level(symbol, spot),
    });
    spot = 140;
    const again = await runGexJob({
      now: new Date("2026-07-16T13:06:00Z"),
      manual: true,
      loadUnderlying: async (symbol) => level(symbol, spot),
    });
    expect(again.ok).toBe(true);
    expect(again.saved).toEqual(["QQQ", "SPY"]);
    const book = parseGexBook(await readGexText());
    const qqq = book?.rows.find((row) => row.date === "2026-07-16" && row.underlying === "QQQ");
    expect(qqq?.spot).toBe(140);
    expect(book?.rows.filter((row) => row.date === "2026-07-16" && row.underlying === "QQQ")).toHaveLength(1);
    expect(book?.rows.find((row) => row.date === "2026-11-02" && row.underlying === "SPY")?.spot).toBe(755.7);
  });
});
