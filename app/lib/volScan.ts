import { addCalendarDays, newYorkDate } from "@/app/lib/flow";
import {
  buildVolArbReading,
  compareVolReadings,
  type VolArbReading,
} from "@/app/lib/volArb";
import {
  getOptionChain,
  getPriceHistory,
  getSchwabStatus,
  SchwabConfigError,
  SchwabNotConnectedError,
} from "@/app/lib/schwab";

/**
 * Reads Schwab chains and Schwab daily prices for the vol view.
 * Read-only. No orders. A delayed chain is not turned into a reading.
 */

/** Strikes above and below the money. Wide enough to reach ~25 delta on liquid names. */
export const VOL_STRIKE_COUNT = 40;

/** Covers a front expiration and one near 60 days for the term slope. */
export const VOL_EXPIRATION_WINDOW_DAYS = 100;

const BATCH_SIZE = 2;
const CACHE_MS = 45_000;
const MAX_REQUESTS_PER_MINUTE = 60;

export interface VolScanError {
  symbol: string;
  message: string;
}

export interface VolScanResult {
  rows: VolArbReading[];
  errors: VolScanError[];
  scannedAt: number;
  cached: boolean;
}

interface CacheEntry {
  at: number;
  result: VolScanResult;
}

const cache = new Map<string, CacheEntry>();
const requestTimes: number[] = [];

export function clearVolScanCacheForTests(): void {
  cache.clear();
  requestTimes.length = 0;
}

export function volChainRequest(symbol: string, now: Date): {
  symbol: string;
  contractType: "ALL";
  strikeCount: number;
  fromDate: string;
  toDate: string;
} {
  const fromDate = newYorkDate(now);
  return {
    symbol: symbol.trim().toUpperCase(),
    contractType: "ALL",
    strikeCount: VOL_STRIKE_COUNT,
    fromDate,
    toDate: addCalendarDays(fromDate, VOL_EXPIRATION_WINDOW_DAYS),
  };
}

export async function scanVolArb(options: {
  symbols: string[];
  now?: number;
  bypassCache?: boolean;
}): Promise<VolScanResult> {
  const nowMs = options.now ?? Date.now();
  const symbols = options.symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol.length > 0);
  const cacheKey = symbols.join(",");
  if (!options.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && nowMs - hit.at < CACHE_MS) {
      return { ...hit.result, cached: true };
    }
  }

  const status = await getSchwabStatus(nowMs);
  if (!status.configured) throw new SchwabConfigError();
  if (!status.connected) throw new SchwabNotConnectedError();

  const asOf = new Date(nowMs);
  const rows: VolArbReading[] = [];
  const errors: VolScanError[] = [];

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (symbol) => {
      try {
        rows.push(await readSymbol(symbol, asOf));
      } catch (err) {
        if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
        errors.push({ symbol, message: safeMessage(err) });
      }
    }));
  }

  rows.sort(compareVolReadings);
  const result: VolScanResult = { rows, errors, scannedAt: nowMs, cached: false };
  cache.set(cacheKey, { at: nowMs, result });
  return result;
}

async function readSymbol(symbol: string, now: Date): Promise<VolArbReading> {
  await pace(Date.now());
  const chain = await getOptionChain(volChainRequest(symbol, now));
  const asOf = newYorkDate(now);
  if (chain.delayed) {
    return buildVolArbReading({
      symbol,
      asOf,
      underlyingPrice: null,
      delayed: true,
      contracts: [],
      closes: [],
    });
  }

  let closes: number[] = [];
  let priceHistoryFailed = false;
  try {
    await pace(Date.now());
    const bars = await getPriceHistory(symbol);
    closes = bars.map((bar) => bar.close);
  } catch (err) {
    if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
    priceHistoryFailed = true;
  }

  return buildVolArbReading({
    symbol,
    asOf,
    underlyingPrice: chain.underlyingPrice,
    delayed: false,
    contracts: chain.contracts,
    closes,
    priceHistoryFailed,
  });
}

async function pace(now: number): Promise<void> {
  while (requestTimes.length > 0 && now - requestTimes[0] >= 60_000) requestTimes.shift();
  if (requestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
    const wait = 60_000 - (now - requestTimes[0]) + 25;
    await sleep(wait);
  }
  requestTimes.push(Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMessage(err: unknown): string {
  if (err instanceof Error && err.message.startsWith("Schwab ")) return err.message.slice(0, 180);
  return "Schwab market data request failed";
}
