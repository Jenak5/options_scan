import { afterEach, describe, expect, it, vi } from "vitest";
import { LEVEL_RULES } from "@/app/lib/alertConfig";
import {
  clearLevelCacheForTests,
  keyLevelsForTicker,
  setPriceHistoryFetcherForTests,
  type PriceHistoryRequest,
} from "@/app/lib/levelScan";
import { SchwabNotConnectedError } from "@/app/lib/schwab";
import type { PriceCandle } from "@/app/lib/schwabParse";

function candle(datetime: number, close: number): PriceCandle {
  return { open: close, high: close + 1, low: close - 1, close, volume: 100, datetime };
}

afterEach(() => {
  setPriceHistoryFetcherForTests(null);
  clearLevelCacheForTests();
});

describe("level cache", () => {
  it("reuses candles for a few minutes and recomputes when the spot moves", async () => {
    const calls: PriceHistoryRequest[] = [];
    setPriceHistoryFetcherForTests(async (input) => {
      calls.push(input);
      if (input.frequencyType === "daily") {
        return [candle(Date.parse("2026-09-30T13:30:00Z"), 90)];
      }
      return [candle(Date.parse("2026-10-01T13:30:00Z"), 100)];
    });
    const now = Date.parse("2026-10-01T15:00:00Z");
    const first = await keyLevelsForTicker({ ticker: "spy", spot: 100, now });
    const second = await keyLevelsForTicker({ ticker: "SPY", spot: 100.2, now: now + 1_000 });
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].frequencyType).toBe("daily");
    expect(calls[0].needExtendedHoursData).toBe(false);
    expect(calls[1].frequencyType).toBe("minute");
    expect(calls[1].frequency).toBe(5);
    expect(calls[1].needExtendedHoursData).toBe(true);
    expect(calls[0].symbol).toBe("SPY");

    await keyLevelsForTicker({ ticker: "SPY", spot: 100, now: now + LEVEL_RULES.cacheMs });
    expect(calls).toHaveLength(4);
  });

  it("uses two history reads per ticker, then the cache, on a longer list", async () => {
    const calls: string[] = [];
    setPriceHistoryFetcherForTests(async (input) => {
      calls.push(input.symbol);
      return [candle(Date.parse("2026-10-01T13:30:00Z"), 100)];
    });
    const now = Date.parse("2026-10-01T15:00:00Z");
    const tickers = ["SPY", "QQQ", "IWM", "JPM", "BA", "XOM", "XLF", "GLD", "NVDA"];
    for (let i = 0; i < tickers.length; i++) {
      await keyLevelsForTicker({ ticker: tickers[i], spot: 100, now });
    }
    expect(calls).toHaveLength(tickers.length * 2);
    for (let i = 0; i < tickers.length; i++) {
      await keyLevelsForTicker({ ticker: tickers[i], spot: 100, now: now + 1_000 });
    }
    expect(calls).toHaveLength(tickers.length * 2);
  });

  it("does not cache a failed read and still refuses a dead Schwab session", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("Schwab market data request failed (500)");
    });
    setPriceHistoryFetcherForTests(fetcher);
    const now = Date.parse("2026-10-01T15:00:00Z");
    const missed = await keyLevelsForTicker({ ticker: "QQQ", spot: 400, now });
    expect(missed.checked).toBe(false);
    await keyLevelsForTicker({ ticker: "QQQ", spot: 400, now: now + 1_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);

    setPriceHistoryFetcherForTests(async () => {
      throw new SchwabNotConnectedError();
    });
    await expect(keyLevelsForTicker({ ticker: "QQQ", spot: 400, now })).rejects.toBeInstanceOf(SchwabNotConnectedError);
    const skipped = await keyLevelsForTicker({ ticker: "nope!", spot: 10, now });
    expect(skipped.checked).toBe(false);
  });
});
