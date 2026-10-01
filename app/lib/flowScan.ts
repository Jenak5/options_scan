import {
  FLOW_BATCH_SIZE,
  FLOW_CACHE_MS,
  FLOW_MAX_REQUESTS_PER_MINUTE,
  flowChainRequest,
  scoreChain,
  snapshotFromRows,
  watchlistFromEnv,
  type FlowRow,
} from "@/app/lib/flow";
import { earningsForTicker } from "@/app/lib/earnings";
import { UNKNOWN_EARNINGS } from "@/app/lib/eventRisk";
import { keyLevelsForTicker } from "@/app/lib/levelScan";
import { getOptionChain, getSchwabStatus, SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { readFlowSnapshots, writeFlowSnapshots } from "@/app/lib/schwabStore";

/**
 * Reads Schwab chains and scores them, then attaches cached price levels.
 * Chains and price history only. No orders. Chain results are cached for about 60 seconds.
 * Volume snapshots go to a separate store key so the next poll can show a jump.
 */

export interface FlowScanError {
  ticker: string;
  message: string;
}

export interface FlowScanResult {
  rows: FlowRow[];
  scannedAt: number;
  cached: boolean;
  watchlist: string[];
  errors: FlowScanError[];
}

interface CacheEntry {
  at: number;
  result: FlowScanResult;
}

const cache = new Map<string, CacheEntry>();
const requestTimes: number[] = [];

export function clearFlowScanCacheForTests(): void {
  cache.clear();
  requestTimes.length = 0;
}

export async function scanEstimatedFlow(options?: {
  tickers?: string[];
  now?: number;
  bypassCache?: boolean;
}): Promise<FlowScanResult> {
  const now = options?.now ?? Date.now();
  const tickers = (options?.tickers && options.tickers.length > 0
    ? options.tickers
    : watchlistFromEnv(process.env.FLOW_WATCHLIST)
  ).map((ticker) => ticker.trim().toUpperCase());
  const cacheKey = tickers.join(",");
  if (!options?.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && now - hit.at < FLOW_CACHE_MS) {
      return { ...hit.result, cached: true, scannedAt: hit.result.scannedAt };
    }
  }

  const status = await getSchwabStatus(now);
  if (!status.configured) throw new SchwabConfigError();
  if (!status.connected) throw new SchwabNotConnectedError();

  const previous = await readFlowSnapshots();
  const rows: FlowRow[] = [];
  const errors: FlowScanError[] = [];
  const updates: Record<string, { scannedAt: number; volumes: Record<string, number> }> = {};
  const asOf = new Date(now);

  for (let i = 0; i < tickers.length; i += FLOW_BATCH_SIZE) {
    const batch = tickers.slice(i, i + FLOW_BATCH_SIZE);
    await Promise.all(batch.map(async (ticker) => {
      await pace(Date.now());
      try {
        const request = flowChainRequest(ticker, asOf);
        const chain = await getOptionChain(request);
        const levels = await keyLevelsForTicker({
          ticker,
          spot: chain.underlyingPrice,
          contracts: chain.contracts,
          now,
        });
        const earnings = await earningsForTicker(ticker, now).catch(() => UNKNOWN_EARNINGS);
        const scored = scoreChain({
          ticker,
          contracts: chain.contracts,
          underlyingPrice: chain.underlyingPrice,
          delayed: chain.delayed,
          previous: previous[ticker] ?? null,
          now: asOf,
        }).map((row) => ({ ...row, levels, earnings }));
        rows.push(...scored);
        updates[ticker] = snapshotFromRows(scored, now);
      } catch (err) {
        if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
        errors.push({ ticker, message: safeScanMessage(err) });
      }
    }));
  }

  if (Object.keys(updates).length > 0) {
    await writeFlowSnapshots(updates);
  }

  const result: FlowScanResult = {
    rows,
    scannedAt: now,
    cached: false,
    watchlist: tickers,
    errors,
  };
  cache.set(cacheKey, { at: now, result });
  return result;
}

async function pace(now: number): Promise<void> {
  while (requestTimes.length > 0 && now - requestTimes[0] >= 60_000) requestTimes.shift();
  if (requestTimes.length >= FLOW_MAX_REQUESTS_PER_MINUTE) {
    const wait = 60_000 - (now - requestTimes[0]) + 25;
    await sleep(wait);
  }
  requestTimes.push(Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeScanMessage(err: unknown): string {
  if (err instanceof Error && err.message.startsWith("Schwab ")) return err.message.slice(0, 180);
  return "Schwab market data request failed";
}
