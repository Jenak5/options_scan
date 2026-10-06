import {
  FLOW_BATCH_SIZE,
  FLOW_CACHE_MS,
  FLOW_MAX_REQUESTS_PER_MINUTE,
  flowChainRequest,
  flowContractKey,
  newYorkDate,
  sameDayQuotePoints,
  scoreChain,
  snapshotFromRows,
  watchlistFromEnv,
  type FlowRow,
  type FlowVolumeSnapshot,
} from "@/app/lib/flow";
import { PRINT_RULES } from "@/app/lib/alertConfig";
import type { OptionContract } from "@/app/lib/contract";
import { earningsForTicker } from "@/app/lib/earnings";
import { UNKNOWN_EARNINGS, type EarningsFact } from "@/app/lib/eventRisk";
import type { KeyLevels } from "@/app/lib/levels";
import { keyLevelsForTicker } from "@/app/lib/levelScan";
import { annotateFlowRows, carryPriorSession } from "@/app/lib/marketContext";
import { quotePointFromContract, type FlowQuotePoint } from "@/app/lib/prints";
import { getOptionChain, getSchwabStatus, SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { readFlowSnapshots, writeFlowSnapshots } from "@/app/lib/schwabStore";

/**
 * Reads Schwab chains and scores them, then attaches cached price levels.
 * Chains and price history only. No orders. Chain results are cached for about 60 seconds.
 * A few active tickers are read again a couple of seconds later so a new last trade
 * can show up. That is still a quote, not a time-and-sales feed.
 * Earnings are read once per ticker and attached to every row from that chain.
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
  const errors: FlowScanError[] = [];
  const asOf = new Date(now);
  const passes: TickerPass[] = [];

  for (let i = 0; i < tickers.length; i += FLOW_BATCH_SIZE) {
    const batch = tickers.slice(i, i + FLOW_BATCH_SIZE);
    await Promise.all(batch.map(async (ticker) => {
      await pace(Date.now());
      try {
        const chain = await getOptionChain(flowChainRequest(ticker, asOf));
        const levels = await keyLevelsForTicker({
          ticker,
          spot: chain.underlyingPrice,
          contracts: chain.contracts,
          now,
        });
        const earnings = await earningsForTicker(ticker, now).catch(() => UNKNOWN_EARNINGS);
        passes.push({
          ticker,
          levels,
          earnings,
          samples: [{
            at: Date.now(),
            contracts: chain.contracts,
            delayed: chain.delayed,
            underlyingPrice: chain.underlyingPrice,
          }],
        });
      } catch (err) {
        if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
        errors.push({ ticker, message: safeScanMessage(err) });
      }
    }));
  }

  const follow = rankFollowUps(passes, previous, asOf);
  const followStarted = Date.now();
  for (let round = 0; round < PRINT_RULES.followUpReads; round++) {
    if (follow.length === 0) break;
    if (Date.now() - followStarted >= PRINT_RULES.followUpBudgetMs) break;
    await sleep(PRINT_RULES.followUpGapMs);
    if (Date.now() - followStarted >= PRINT_RULES.followUpBudgetMs) break;
    for (let i = 0; i < follow.length; i += FLOW_BATCH_SIZE) {
      const batch = follow.slice(i, i + FLOW_BATCH_SIZE);
      await Promise.all(batch.map(async (ticker) => {
        const pass = findPass(passes, ticker);
        if (!pass) return;
        await pace(Date.now());
        try {
          const chain = await getOptionChain(flowChainRequest(ticker, asOf));
          pass.samples.push({
            at: Date.now(),
            contracts: chain.contracts,
            delayed: chain.delayed,
            underlyingPrice: chain.underlyingPrice,
          });
        } catch (err) {
          if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
        }
      }));
    }
  }

  const rows: FlowRow[] = [];
  const updates: Record<string, FlowVolumeSnapshot> = {};
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    const last = pass.samples[pass.samples.length - 1];
    const livePoints = livePointsFromSamples(pass.samples);
    const delayed = pass.samples.some((sample) => sample.delayed);
    const prior = previous[pass.ticker] ?? null;
    const scored = scoreChain({
      ticker: pass.ticker,
      contracts: last.contracts,
      underlyingPrice: last.underlyingPrice,
      delayed,
      previous: prior,
      now: asOf,
      livePoints,
    }).map((row) => ({ ...row, levels: pass.levels, earnings: pass.earnings }));
    rows.push(...scored);
    const snap = carryPriorSession(prior, snapshotFromRows(scored, now), asOf);
    snap.quotes = quotesForRows(scored, prior, livePoints, asOf);
    updates[pass.ticker] = snap;
  }

  if (Object.keys(updates).length > 0) {
    await writeFlowSnapshots(updates);
  }

  const withContext = annotateFlowRows(rows, { ...previous, ...updates }, asOf);
  const result: FlowScanResult = {
    rows: withContext,
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

interface TickerSample {
  at: number;
  contracts: OptionContract[];
  delayed: boolean;
  underlyingPrice: number | null;
}

interface TickerPass {
  ticker: string;
  levels: KeyLevels;
  earnings: EarningsFact;
  samples: TickerSample[];
}

function findPass(passes: TickerPass[], ticker: string): TickerPass | null {
  for (let i = 0; i < passes.length; i++) {
    if (passes[i].ticker === ticker) return passes[i];
  }
  return null;
}

function rankFollowUps(
  passes: TickerPass[],
  previous: Record<string, FlowVolumeSnapshot>,
  now: Date,
): string[] {
  const ranked: { ticker: string; score: number }[] = [];
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    const first = pass.samples[0];
    if (!first) continue;
    const score = activityScore(first.contracts, previous[pass.ticker] ?? null, now);
    if (score > 0) ranked.push({ ticker: pass.ticker, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const tickers: string[] = [];
  for (let i = 0; i < ranked.length && tickers.length < PRINT_RULES.maxFollowUpTickers; i++) {
    tickers.push(ranked[i].ticker);
  }
  return tickers;
}

function activityScore(contracts: OptionContract[], previous: FlowVolumeSnapshot | null, now: Date): number {
  const sameDay = previous != null && newYorkDate(new Date(previous.scannedAt)) === newYorkDate(now);
  let best = 0;
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    if (!Number.isFinite(contract.volume) || contract.volume < 0) continue;
    const key = flowContractKey(contract);
    if (!sameDay || !previous) {
      if (contract.volume > best) best = contract.volume;
      continue;
    }
    const prior = previous.volumes[key];
    if (typeof prior === "number" && contract.volume > prior) {
      const delta = contract.volume - prior;
      if (delta > best) best = delta;
    }
    const history = previous.quotes?.[key];
    const lastPoint = history && history.length > 0 ? history[history.length - 1] : null;
    if (lastPoint?.tradeTime && contract.tradeTime && contract.tradeTime > lastPoint.tradeTime && best < 1) {
      best = 1;
    }
  }
  return best;
}

function livePointsFromSamples(samples: TickerSample[]): Record<string, FlowQuotePoint[]> {
  const out: Record<string, FlowQuotePoint[]> = {};
  for (let s = 0; s < samples.length; s++) {
    const sample = samples[s];
    for (let i = 0; i < sample.contracts.length; i++) {
      const contract = sample.contracts[i];
      const key = flowContractKey(contract);
      if (!out[key]) out[key] = [];
      out[key].push(quotePointFromContract(contract, sample.at));
    }
  }
  return out;
}

function quotesForRows(
  rows: FlowRow[],
  previous: FlowVolumeSnapshot | null,
  livePoints: Record<string, FlowQuotePoint[]>,
  now: Date,
): Record<string, FlowQuotePoint[]> {
  const quotes: Record<string, FlowQuotePoint[]> = {};
  for (let i = 0; i < rows.length; i++) {
    const key = flowContractKey(rows[i]);
    const prior = sameDayQuotePoints(previous?.quotes?.[key], now);
    const live = livePoints[key] ?? [];
    const merged = prior.concat(live).slice(-PRINT_RULES.historyPoints);
    if (merged.length > 0) quotes[key] = merged;
  }
  return quotes;
}

function safeScanMessage(err: unknown): string {
  if (err instanceof Error && err.message.startsWith("Schwab ")) return err.message.slice(0, 180);
  return "Schwab market data request failed";
}
