import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_EARNINGS } from "@/app/lib/eventRisk";
import { TICKER_GROUP_PAUSE_MS } from "@/app/lib/flow";
import { clearFlowScanCacheForTests, scanEstimatedFlow } from "@/app/lib/flowScan";
import * as earnings from "@/app/lib/earnings";
import * as levelScan from "@/app/lib/levelScan";
import * as marketData from "@/app/lib/marketData";
import { clearMemoryStoreForTests } from "@/app/lib/schwabStore";

const T0 = Date.parse("2026-10-06T15:00:00Z");
const CHAIN = {
  contracts: [{
    bid: 1,
    ask: 1.1,
    last: 1.05,
    volume: 0,
    openInterest: 20,
    delta: 0.4,
    iv: 0.2,
    strike: 100,
    expiration: "2026-12-18",
    putCall: "call" as const,
  }],
  delayed: false,
  underlyingPrice: 100,
};

describe("flow chain reuse and group pause", () => {
  beforeEach(() => {
    vi.stubEnv("DATA_SOURCE", "tastytrade");
    vi.stubEnv("TASTYTRADE_CLIENT_ID", "fixture-id");
    vi.stubEnv("TASTYTRADE_CLIENT_SECRET", "fixture-secret");
    vi.stubEnv("TASTYTRADE_REFRESH_TOKEN", "fixture-refresh");
    clearMemoryStoreForTests();
    clearFlowScanCacheForTests();
    vi.spyOn(marketData, "getOptionChain").mockResolvedValue(CHAIN);
    vi.spyOn(marketData, "requireMarketData").mockResolvedValue();
    vi.spyOn(levelScan, "keyLevelsForTicker").mockResolvedValue({
      checked: false,
      spot: 100,
      support: null,
      resistance: null,
      vwap: null,
      sma20: null,
      priorClose: null,
      callWall: null,
      putWall: null,
    });
    vi.spyOn(earnings, "earningsForTicker").mockResolvedValue(UNKNOWN_EARNINGS);
  });

  afterEach(() => {
    clearMemoryStoreForTests();
    clearFlowScanCacheForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reuses a ticker chain for 5 minutes on a fresh pull and refetches after that", async () => {
    await scanEstimatedFlow({ tickers: ["SPY"], now: T0, bypassCache: true, groupPauseMs: 0 });
    expect(marketData.getOptionChain).toHaveBeenCalledTimes(1);

    const reused = await scanEstimatedFlow({
      tickers: ["SPY"],
      now: T0 + 4 * 60_000,
      bypassCache: true,
      reuseRecentChains: true,
      groupPauseMs: 0,
    });
    expect(marketData.getOptionChain).toHaveBeenCalledTimes(1);
    expect(reused.cached).toBe(true);

    const other = await scanEstimatedFlow({
      tickers: ["QQQ"],
      now: T0 + 4 * 60_000,
      bypassCache: true,
      reuseRecentChains: true,
      groupPauseMs: 0,
    });
    expect(marketData.getOptionChain).toHaveBeenCalledTimes(2);
    expect(other.cached).toBe(false);

    const expired = await scanEstimatedFlow({
      tickers: ["SPY"],
      now: T0 + 5 * 60_000,
      bypassCache: true,
      reuseRecentChains: true,
      groupPauseMs: 0,
    });
    expect(marketData.getOptionChain).toHaveBeenCalledTimes(3);
    expect(expired.cached).toBe(false);

    await scanEstimatedFlow({ tickers: ["QQQ"], now: T0 + 4 * 60_000, bypassCache: true, groupPauseMs: 0 });
    expect(marketData.getOptionChain).toHaveBeenCalledTimes(4);
  });

  it("pauses between ticker groups and can skip that wait", async () => {
    const names = ["SPY", "QQQ", "IWM", "AAPL"];
    const fast = Date.now();
    await scanEstimatedFlow({ tickers: names, now: T0, bypassCache: true, groupPauseMs: 0 });
    expect(Date.now() - fast).toBeLessThan(1_000);
    expect(marketData.getOptionChain).toHaveBeenCalledTimes(4);

    vi.mocked(marketData.getOptionChain).mockClear();
    const slow = Date.now();
    await scanEstimatedFlow({
      tickers: names,
      now: T0 + 10 * 60_000,
      bypassCache: true,
      groupPauseMs: TICKER_GROUP_PAUSE_MS,
    });
    expect(Date.now() - slow).toBeGreaterThanOrEqual(TICKER_GROUP_PAUSE_MS - 50);
    expect(marketData.getOptionChain).toHaveBeenCalledTimes(4);
  });
});
