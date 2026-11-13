import type { CandleBar } from "@/app/lib/candleTypes";
import {
  advanceAvwapPaper,
  avwapPaperSection,
  avwapSkipReason,
  formatAvwapPaperAlert,
  latestGapDay,
  minuteHistoryChunks,
  parseAvwapPaperBook,
  quotePlan,
  serializeAvwapPaperBook,
  AVWAP_SYMBOLS,
  type AvwapMarket,
  type AvwapPaperSection,
  type AvwapQuoteRequest,
  type AvwapSnapshot,
} from "@/app/lib/avwapPaper";
import { newYorkDate } from "@/app/lib/flow";
import { getPriceHistory, getQuoteEntries } from "@/app/lib/marketData";
import type { PriceCandle } from "@/app/lib/schwabParse";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { readAvwapPaperBookText, resolveStoreKind, updateAvwapPaperBook } from "@/app/lib/schwabStore";
import { sendTelegramAlert } from "@/app/lib/telegram";
import { preferredDataSource as avwapPreferredSource } from "@/app/lib/marketData";
import { getPriceHistory as schwabPriceHistory, schwabBackupAvailable as schwabHistoryBackup } from "@/app/lib/schwab";
import {
  DXLINK_CANDLE_BATCH,
  equityHistoryKey,
  prefetchEquityHistory,
  type EquityHistoryInput,
} from "@/app/lib/tastytradeMarket";
import { historyCandleSymbol } from "@/app/lib/tastytradeMarketParse";

/**
 * Scheduled paper pass for the gap-day anchored VWAP put.
 * Price history and option quotes go through the market-data provider
 * (Tastytrade, then Schwab). It does not call a chain, an account,
 * or any order endpoint, and it does not write the A/B alert book.
 */

export interface AvwapQuote {
  bid: number;
  ask: number;
}

export interface AvwapPaperDeps {
  daily: (symbol: string, now: Date) => Promise<CandleBar[]>;
  /** Five-minute bars from the gap day through now. anchorDate is null when that symbol has no gap. */
  minutes: (symbol: string, now: Date, anchorDate: string | null) => Promise<CandleBar[]>;
  quotes: (symbols: readonly string[]) => Promise<Map<string, AvwapQuote>>;
  readBook: () => Promise<string | null>;
  writeBook: (change: (current: string | null) => string) => Promise<boolean>;
  send: (message: string) => Promise<boolean>;
}

export interface AvwapRunResult {
  opened: number;
  closed: number;
  saved: boolean;
  skipped: "holiday" | "closed" | null;
  drawdownFlag: boolean;
  logNote: string;
}

/** One runtime-log line. The cron prints this with console.info so it shows up in Vercel logs. */
export function formatAvwapPaperLog(result: AvwapRunResult): string {
  const noun = result.opened === 1 ? "entry" : "entries";
  const flag = result.drawdownFlag ? " Drawdown flag over $1,500." : "";
  const skip = result.skipped === "holiday" ? " Market holiday." : result.skipped === "closed" ? " Outside market hours." : "";
  return `AVWAP paper: ${result.opened} new ${noun}, ${result.closed} closed (${result.saved ? "saved" : "not saved"}, PAPER ONLY).${flag}${skip} ${result.logNote}`.replace(/[ \t]+/g, " ").trim();
}

export async function loadAvwapPaperSection(now: Date = new Date()): Promise<AvwapPaperSection> {
  const text = await readAvwapPaperBookText();
  const stored = resolveStoreKind() !== "unconfigured";
  return avwapPaperSection(parseAvwapPaperBook(text), now, stored);
}

export async function runAvwapPaper(now: Date, deps: AvwapPaperDeps = defaultDeps()): Promise<AvwapRunResult> {
  const skip = avwapSkipReason(now);
  if (skip) {
    return { opened: 0, closed: 0, saved: true, skipped: skip, drawdownFlag: false, logNote: skip === "holiday" ? "market holiday" : "outside market hours" };
  }

  const today = newYorkDate(now);
  const markets: AvwapMarket[] = await Promise.all(AVWAP_SYMBOLS.map(async (symbol) => {
    try {
      const dailyBars = await deps.daily(symbol, now);
      const daily = dailyBars.map((bar) => ({ t: bar.t, open: bar.o, close: bar.c }));
      const gap = latestGapDay(daily, today);
      const minuteBars = await deps.minutes(symbol, now, gap?.date ?? null);
      return { symbol, daily, bars: minuteBars, historyFailed: false };
    } catch {
      return { symbol, daily: [], bars: [], historyFailed: true };
    }
  }));

  const current = parseAvwapPaperBook(await deps.readBook());
  const plan = quotePlan(current, markets, now);
  let quoteMap = new Map<string, AvwapQuote>();
  if (plan.length > 0) {
    try {
      quoteMap = await deps.quotes(plan.map((item) => item.occ));
    } catch {
      quoteMap = new Map();
    }
  }
  const snapshots = markets.map((market) => attachQuotes(market, plan, quoteMap));
  let openedIds: string[] = [];
  let closedCount = 0;
  let drawdownFlag = false;
  const saved = await deps.writeBook((text) => {
    const advanced = advanceAvwapPaper(parseAvwapPaperBook(text), snapshots, now);
    openedIds = advanced.opened.map((trade) => trade.id);
    closedCount = advanced.closed.length;
    drawdownFlag = advanced.book.trades.length > 0 && avwapPaperSection(advanced.book, now, true).health.drawdownFlag;
    return serializeAvwapPaperBook(advanced.book);
  });
  if (!saved) {
    return { opened: 0, closed: 0, saved: false, skipped: null, drawdownFlag: false, logNote: "paper log was not saved" };
  }
  const stored = parseAvwapPaperBook(await deps.readBook());
  const opened = stored.trades.filter((trade) => openedIds.includes(trade.id));
  for (let i = 0; i < opened.length; i++) {
    await deps.send(formatAvwapPaperAlert(opened[i]));
  }
  const notes = AVWAP_SYMBOLS.map((symbol) => `${symbol}: ${stored.notes[symbol] ?? "no note"}`).join("; ");
  const flag = stored.trades.length > 0 && avwapPaperSection(stored, now, true).health.drawdownFlag ? " Drawdown flag over $1,500." : "";
  return {
    opened: opened.length,
    closed: closedCount,
    saved: true,
    skipped: null,
    drawdownFlag: drawdownFlag || flag.length > 0,
    logNote: `${notes}.${flag}`,
  };
}

function attachQuotes(
  market: AvwapMarket,
  plan: readonly AvwapQuoteRequest[],
  quotes: ReadonlyMap<string, AvwapQuote>,
): AvwapSnapshot {
  const marks = [];
  for (let i = 0; i < plan.length; i++) {
    const request = plan[i];
    if (request.symbol !== market.symbol) continue;
    const quote = quotes.get(normalizeOptionSymbol(request.occ));
    if (!quote) continue;
    marks.push({
      expiration: request.expiration,
      strike: request.strike,
      bid: quote.bid,
      ask: quote.ask,
    });
  }
  return { ...market, quotes: marks };
}

function defaultDeps(): AvwapPaperDeps {
  return {
    daily: loadDaily,
    minutes: loadMinutes,
    quotes: loadQuotes,
    readBook: readAvwapPaperBookText,
    writeBook: updateAvwapPaperBook,
    send: sendTelegramAlert,
  };
}

async function loadDaily(symbol: string, now: Date): Promise<CandleBar[]> {
  const input = avwapDailyHistoryInput(symbol, now);
  if (historySource() !== "schwab") {
    try {
      const rows = await enqueueCandles(input, 15_000);
      if (rows.length > 0) return rows.map(toBar);
    } catch {
      if (!(await readers.schwabReady())) throw new Error("AVWAP price history was not read");
      return (await readers.schwab(input)).map(toBar);
    }
  }
  return (await readers.router(input)).map(toBar);
}

async function loadMinutes(symbol: string, now: Date, anchorDate: string | null): Promise<CandleBar[]> {
  if (!anchorDate) return [];
  const chunks = minuteHistoryChunks(anchorDate, now.getTime());
  const byTime = new Map<number, CandleBar>();
  if (chunks.length > 0) await readMinuteBars(symbol, chunks, byTime);
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

async function loadQuotes(symbols: readonly string[]): Promise<Map<string, AvwapQuote>> {
  const map = new Map<string, AvwapQuote>();
  if (symbols.length === 0) return map;
  const read = await getQuoteEntries(symbols.slice());
  for (let i = 0; i < read.entries.length; i++) {
    const entry = read.entries[i];
    const contract = entry.contract;
    if (contract.putCall !== "put") continue;
    if (!(contract.ask >= 0) || !(contract.bid >= 0)) continue;
    map.set(normalizeOptionSymbol(entry.symbol), { bid: contract.bid, ask: contract.ask });
  }
  return map;
}

function toBar(candle: PriceCandle): CandleBar {
  return {
    t: candle.datetime,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    v: candle.volume,
  };
}

/**
 * Candle reads for the book share one DXLink session per 8-day window, same 80-symbol
 * batch as the scan. The pass stops inside the 240s cron budget. Schwab is asked only
 * for a window Tastytrade did not return, and only in those 8-day chunks.
 */
export const AVWAP_HISTORY_BUDGET_MS = 45_000;
const AVWAP_CANDLE_TIMEOUT_MS = 15_000;

type HistorySource = "tastytrade" | "schwab";

interface HistoryReaders {
  source: HistorySource | null;
  prefetch: (inputs: readonly EquityHistoryInput[], timeoutMs: number) => Promise<Map<string, PriceCandle[]>>;
  router: (input: EquityHistoryInput) => Promise<PriceCandle[]>;
  schwab: (input: EquityHistoryInput) => Promise<PriceCandle[]>;
  schwabReady: () => Promise<boolean>;
}

let readers: HistoryReaders = defaultHistoryReaders();
let candleJobs: CandleJob[] = [];
let candleFlush: Promise<void> | null = null;
let minuteJobs: MinuteJob[] = [];
let minuteFlush: Promise<void> | null = null;

function defaultHistoryReaders(): HistoryReaders {
  return {
    source: null,
    prefetch: (inputs, timeoutMs) => prefetchEquityHistory(inputs, { timeoutMs }),
    router: getPriceHistory,
    schwab: schwabPriceHistory,
    schwabReady: () => schwabHistoryBackup(),
  };
}

/** Test seam. Production keeps Tastytrade first and Schwab as the backup reader. */
export function setAvwapHistoryReadersForTests(next: Partial<HistoryReaders> | null): void {
  const base = defaultHistoryReaders();
  readers = next ? { ...base, ...next } : base;
  candleJobs = [];
  candleFlush = null;
  minuteJobs = [];
  minuteFlush = null;
}

export function loadAvwapDailyBars(symbol: string, now: Date): Promise<CandleBar[]> {
  return loadDaily(symbol, now);
}

export function loadAvwapMinuteBars(symbol: string, now: Date, anchorDate: string | null): Promise<CandleBar[]> {
  return loadMinutes(symbol, now, anchorDate);
}

export function avwapDailyHistoryInput(symbol: string, now: Date): EquityHistoryInput {
  return {
    symbol,
    periodType: "month",
    period: 6,
    frequencyType: "daily",
    frequency: 1,
    needExtendedHoursData: false,
    endDate: now.getTime(),
  };
}

export function avwapMinuteHistoryInput(symbol: string, startDate: number, endDate: number): EquityHistoryInput {
  return {
    symbol,
    periodType: "day",
    period: 10,
    frequencyType: "minute",
    frequency: 5,
    needExtendedHoursData: false,
    startDate,
    endDate,
  };
}

/** One DXLink session per wave. A repeated candle symbol waits for the next session. */
export function candleWaves(inputs: readonly EquityHistoryInput[]): EquityHistoryInput[][] {
  const pending = inputs.slice();
  const waves: EquityHistoryInput[][] = [];
  while (pending.length > 0) {
    const wave: EquityHistoryInput[] = [];
    const seen = new Set<string>();
    const rest: EquityHistoryInput[] = [];
    for (let i = 0; i < pending.length; i++) {
      const key = historyCandleSymbol(pending[i]) ?? pending[i].symbol;
      if (seen.has(key) || wave.length >= DXLINK_CANDLE_BATCH) rest.push(pending[i]);
      else {
        seen.add(key);
        wave.push(pending[i]);
      }
    }
    if (wave.length === 0) break;
    waves.push(wave);
    pending.splice(0, pending.length, ...rest);
  }
  return waves;
}

interface CandleJob {
  input: EquityHistoryInput;
  timeoutMs: number;
  resolve: (rows: PriceCandle[]) => void;
  reject: (err: unknown) => void;
}

interface MinuteChunk {
  startDate: number;
  endDate: number;
}

interface MinuteJob {
  symbol: string;
  chunks: MinuteChunk[];
  byTime: Map<number, CandleBar>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function historySource(): HistorySource {
  return readers.source ?? avwapPreferredSource();
}

function enqueueCandles(input: EquityHistoryInput, timeoutMs: number): Promise<PriceCandle[]> {
  return new Promise((resolve, reject) => {
    candleJobs.push({ input, timeoutMs, resolve, reject });
    if (!candleFlush) candleFlush = Promise.resolve().then(flushCandleJobs);
  });
}

async function flushCandleJobs(): Promise<void> {
  const jobs = candleJobs;
  candleJobs = [];
  candleFlush = null;
  if (jobs.length === 0) return;
  const timeoutMs = jobs.reduce((max, job) => Math.max(max, job.timeoutMs), 15_000);
  const merged = new Map<string, PriceCandle[]>();
  let failed: unknown = null;
  try {
    const waves = candleWaves(jobs.map((job) => job.input));
    for (let w = 0; w < waves.length; w++) {
      const part = await readers.prefetch(waves[w], timeoutMs);
      part.forEach((rows, key) => {
        merged.set(key, rows);
      });
    }
  } catch (err) {
    failed = err;
  }
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (failed) job.reject(failed instanceof Error ? failed : new Error("Tastytrade candles were not read"));
    else job.resolve(merged.get(equityHistoryKey(job.input)) ?? []);
  }
}

async function readMinuteBars(
  symbol: string,
  chunks: MinuteChunk[],
  byTime: Map<number, CandleBar>,
): Promise<void> {
  if (historySource() === "schwab") {
    await fillChunks(symbol, chunks, byTime, "router", Number.POSITIVE_INFINITY);
    if (byTime.size === 0) throw new Error("AVWAP price history was not read");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    minuteJobs.push({ symbol, chunks, byTime, resolve, reject });
    if (!minuteFlush) minuteFlush = Promise.resolve().then(flushMinuteJobs);
  });
}

async function flushMinuteJobs(): Promise<void> {
  const jobs = minuteJobs;
  minuteJobs = [];
  minuteFlush = null;
  if (jobs.length === 0) return;
  const deadline = Date.now() + AVWAP_HISTORY_BUDGET_MS;
  const missing = new Map<string, MinuteChunk[]>();
  let ttDown = false;
  const max = jobs.reduce((n, job) => Math.max(n, job.chunks.length), 0);
  for (let i = 0; i < max; i++) {
    const inputs: EquityHistoryInput[] = [];
    const owners: { job: MinuteJob; chunk: MinuteChunk }[] = [];
    for (let j = 0; j < jobs.length; j++) {
      const chunk = jobs[j].chunks[i];
      if (!chunk) continue;
      if (ttDown || Date.now() > deadline) {
        const gap = missing.get(jobs[j].symbol) ?? [];
        gap.push(chunk);
        missing.set(jobs[j].symbol, gap);
        continue;
      }
      inputs.push(avwapMinuteHistoryInput(jobs[j].symbol, chunk.startDate, chunk.endDate));
      owners.push({ job: jobs[j], chunk });
    }
    if (inputs.length === 0) continue;
    try {
      const fetched = await readers.prefetch(inputs, AVWAP_CANDLE_TIMEOUT_MS);
      for (let k = 0; k < owners.length; k++) {
        const rows = fetched.get(equityHistoryKey(inputs[k])) ?? [];
        if (rows.length === 0) {
          const gap = missing.get(owners[k].job.symbol) ?? [];
          gap.push(owners[k].chunk);
          missing.set(owners[k].job.symbol, gap);
        } else mergeCandles(owners[k].job.byTime, rows);
      }
    } catch {
      ttDown = true;
      for (let k = 0; k < owners.length; k++) {
        const gap = missing.get(owners[k].job.symbol) ?? [];
        gap.push(owners[k].chunk);
        missing.set(owners[k].job.symbol, gap);
      }
    }
  }
  await Promise.all(jobs.map(async (job) => {
    try {
      const gap = missing.get(job.symbol) ?? [];
      if (gap.length > 0) await fillChunks(job.symbol, gap, job.byTime, ttDown ? "schwab" : "router", deadline);
      if (job.byTime.size === 0 && gap.length > 0) throw new Error("AVWAP price history was not read");
      job.resolve();
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error("AVWAP price history was not read"));
    }
  }));
}

async function fillChunks(
  symbol: string,
  chunks: { startDate: number; endDate: number }[],
  byTime: Map<number, CandleBar>,
  mode: "router" | "schwab",
  deadline: number,
): Promise<void> {
  if (mode === "schwab" && !(await readers.schwabReady())) return;
  for (let i = 0; i < chunks.length; i++) {
    if (Date.now() > deadline) return;
    const input = avwapMinuteHistoryInput(symbol, chunks[i].startDate, chunks[i].endDate);
    try {
      const candles = mode === "schwab" ? await readers.schwab(input) : await readers.router(input);
      mergeCandles(byTime, candles);
    } catch {
      continue;
    }
  }
}

function mergeCandles(byTime: Map<number, CandleBar>, candles: readonly PriceCandle[]): void {
  for (let c = 0; c < candles.length; c++) {
    const bar = toBar(candles[c]);
    const prior = byTime.get(bar.t);
    if (!prior || (bar.v ?? 0) >= (prior.v ?? 0)) byTime.set(bar.t, bar);
  }
}
