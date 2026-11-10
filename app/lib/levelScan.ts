import { LEVEL_RULES } from "@/app/lib/alertConfig";
import { isFlowTicker } from "@/app/lib/flow";
import {
  computeKeyLevels,
  emptyLevels,
  type KeyLevels,
  type WallContract,
} from "@/app/lib/levels";
import { getPriceHistory, rethrowIfSchwabOnly } from "@/app/lib/marketData";
import { prefetchEquityHistory, type EquityHistoryInput } from "@/app/lib/tastytradeMarket";
import type { PriceCandle } from "@/app/lib/schwabParse";

/**
 * Price history for one ticker, cached for a few minutes.
 * A failed read is not cached. It does not throw unless Schwab itself is down,
 * so a missing chart does not drop the chain scan.
 * Read-only. Two GETs: about a month of daily candles, and today's 5-minute candles.
 */

export interface PriceHistoryRequest {
  symbol: string;
  periodType: "day" | "month";
  period: number;
  frequencyType: "minute" | "daily";
  frequency: number;
  needExtendedHoursData: boolean;
  /** Epoch ms. Schwab defaults endDate to the prior business day's close when it is omitted. */
  startDate?: number;
  /** Epoch ms. Set on intraday reads so today's bars are included. */
  endDate?: number;
}

/** Covers today's pre-market from 4:00 ET on any intraday scan. */
const INTRADAY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type HistoryFetcher = (input: PriceHistoryRequest) => Promise<PriceCandle[]>;

interface CandleCache {
  at: number;
  daily: PriceCandle[];
  intraday: PriceCandle[];
}

const cache = new Map<string, CandleCache>();
const historyTimes: number[] = [];
const HISTORY_MAX_PER_MINUTE = 60;

let fetcher: HistoryFetcher = defaultFetcher;

export function clearLevelCacheForTests(): void {
  cache.clear();
  historyTimes.length = 0;
}

export function setPriceHistoryFetcherForTests(next: HistoryFetcher | null): void {
  fetcher = next ?? defaultFetcher;
  clearLevelCacheForTests();
}

export function levelHistoryRequests(ticker: string, now: number): PriceHistoryRequest[] {
  return [
    {
      symbol: ticker,
      periodType: "month",
      period: 1,
      frequencyType: "daily",
      frequency: 1,
      needExtendedHoursData: false,
    },
    {
      symbol: ticker,
      periodType: "day",
      period: 1,
      frequencyType: "minute",
      frequency: 5,
      needExtendedHoursData: true,
      startDate: now - INTRADAY_LOOKBACK_MS,
      endDate: now,
    },
  ];
}

/** One candle session for the scan list. Core names are first when the caller orders them that way. */
export async function prefetchLevelHistory(tickers: readonly string[], now: number): Promise<void> {
  const inputs: EquityHistoryInput[] = [];
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i].trim().toUpperCase();
    if (!isFlowTicker(ticker)) continue;
    const hit = cache.get(ticker);
    if (hit && now - hit.at < LEVEL_RULES.cacheMs && now >= hit.at) continue;
    inputs.push(...levelHistoryRequests(ticker, now));
  }
  if (inputs.length === 0) return;
  await prefetchEquityHistory(inputs);
}

export async function keyLevelsForTicker(input: {
  ticker: string;
  spot: number | null;
  contracts?: WallContract[];
  now?: number;
}): Promise<KeyLevels> {
  const now = input.now ?? Date.now();
  const ticker = input.ticker.trim().toUpperCase();
  const spot = input.spot != null && input.spot > 0 ? input.spot : null;
  if (!isFlowTicker(ticker)) return emptyLevels(spot);

  const hit = cache.get(ticker);
  if (hit && now - hit.at < LEVEL_RULES.cacheMs && now >= hit.at) {
    return computeKeyLevels({
      spot,
      daily: hit.daily,
      intraday: hit.intraday,
      now: new Date(now),
      contracts: input.contracts,
    });
  }

  try {
    const [dailyReq, intraReq] = levelHistoryRequests(ticker, now);
    await paceHistory(Date.now());
    const daily = await fetcher(dailyReq);
    await paceHistory(Date.now());
    const intraday = await fetcher(intraReq);
    cache.set(ticker, { at: now, daily, intraday });
    return computeKeyLevels({
      spot,
      daily,
      intraday,
      now: new Date(now),
      contracts: input.contracts,
    });
  } catch (err) {
    rethrowIfSchwabOnly(err);
    return emptyLevels(spot);
  }
}

async function defaultFetcher(input: PriceHistoryRequest): Promise<PriceCandle[]> {
  return getPriceHistory(input);
}

async function paceHistory(now: number): Promise<void> {
  while (historyTimes.length > 0 && now - historyTimes[0] >= 60_000) historyTimes.shift();
  if (historyTimes.length >= HISTORY_MAX_PER_MINUTE) {
    const wait = 60_000 - (now - historyTimes[0]) + 25;
    await sleep(wait);
  }
  historyTimes.push(Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
