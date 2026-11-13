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
import { preferredDataSource } from "@/app/lib/dataSourcePref";
import { getPriceHistory, recordMarketData } from "@/app/lib/marketData";
import { redactReason } from "@/app/lib/marketDataHealth";
import { createSchwabProvider, createTastytradeProvider } from "@/app/lib/marketProviders";
import type { PriceCandle, ParsedQuote } from "@/app/lib/schwabParse";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { schwabBackupAvailable } from "@/app/lib/schwab";
import { readAvwapPaperBookText, resolveStoreKind, updateAvwapPaperBook } from "@/app/lib/schwabStore";
import { sendTelegramAlert } from "@/app/lib/telegram";

/**
 * Scheduled paper pass for the gap-day anchored VWAP put.
 * Price history and option quotes go through the market-data provider
 * (Tastytrade, then Schwab). It does not call a chain, an account,
 * or any order endpoint, and it does not write the A/B alert book.
 */

export interface AvwapQuote {
  bid: number;
  ask: number;
  /** Epoch milliseconds from the live quote. Null when the feed did not send a time. */
  quoteTime?: number | null;
  source?: "tastytrade" | "schwab" | null;
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
      quoteTime: quote.quoteTime ?? null,
      source: quote.source === "tastytrade" || quote.source === "schwab" ? quote.source : null,
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
  const candles = await getPriceHistory({
    symbol,
    periodType: "month",
    period: 6,
    frequencyType: "daily",
    frequency: 1,
    needExtendedHoursData: false,
    endDate: now.getTime(),
  });
  return candles.map(toBar);
}

async function loadMinutes(symbol: string, now: Date, anchorDate: string | null): Promise<CandleBar[]> {
  if (!anchorDate) return [];
  const chunks = minuteHistoryChunks(anchorDate, now.getTime());
  const byTime = new Map<number, CandleBar>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const candles = await getPriceHistory({
      symbol,
      periodType: "day",
      period: 10,
      frequencyType: "minute",
      frequency: 5,
      needExtendedHoursData: false,
      startDate: chunk.startDate,
      endDate: chunk.endDate,
    });
    for (let c = 0; c < candles.length; c++) {
      const bar = toBar(candles[c]);
      const prior = byTime.get(bar.t);
      if (!prior || (bar.v ?? 0) >= (prior.v ?? 0)) byTime.set(bar.t, bar);
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

const tastytradeQuotes = createTastytradeProvider();
const schwabQuotes = createSchwabProvider();

/**
 * Live option bids for the paper book. Tastytrade first, then Schwab for
 * symbols still missing, matching the market-data router. Each fill keeps
 * the source that sent it. Bid and ask only: the last print and the mid
 * are not read. No order, account, or transaction call.
 */
async function loadQuotes(symbols: readonly string[]): Promise<Map<string, AvwapQuote>> {
  const map = new Map<string, AvwapQuote>();
  const wanted = uniqueSymbols(symbols);
  if (wanted.length === 0) return map;
  if (preferredDataSource() === "schwab") {
    try {
      const read = await schwabQuotes.getQuoteEntries(wanted);
      takePuts(read.entries, "schwab", map);
      await recordMarketData("quotes", "schwab", null, `${wanted.length} symbols`);
      return map;
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new Error("AVWAP option quotes were not read");
    }
  }

  let reason = "empty Tastytrade answer";
  try {
    const read = await tastytradeQuotes.getQuoteEntries(wanted);
    takePuts(read.entries, "tastytrade", map);
    if (missingSymbols(wanted, map).length === 0) {
      await recordMarketData("quotes", "tastytrade", null, `${wanted.length} symbols`);
      return map;
    }
    reason = map.size > 0 ? "partial Tastytrade quote" : "empty Tastytrade answer";
  } catch (err) {
    if (isAbort(err)) throw err;
    reason = redactReason(err);
  }

  const missing = missingSymbols(wanted, map);
  if (!(await schwabBackupAvailable())) {
    if (map.size > 0) {
      await recordMarketData("quotes", "tastytrade", "partial", `${wanted.length} symbols`);
      return map;
    }
    throw new Error("AVWAP option quotes were not read");
  }

  try {
    const filled = await schwabQuotes.getQuoteEntries(missing);
    const before = map.size;
    takePuts(filled.entries, "schwab", map);
    await recordMarketData("quotes", map.size > before ? "schwab" : "tastytrade", reason, `${wanted.length} symbols`);
    return map;
  } catch (err) {
    if (isAbort(err)) throw err;
    if (map.size > 0) {
      await recordMarketData("quotes", "tastytrade", "partial", `${wanted.length} symbols`);
      return map;
    }
    throw new Error("AVWAP option quotes were not read");
  }
}

function takePuts(entries: readonly ParsedQuote[], source: "tastytrade" | "schwab", map: Map<string, AvwapQuote>): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const contract = entry.contract;
    if (contract.putCall !== "put") continue;
    if (!(contract.ask >= 0) || !(contract.bid >= 0)) continue;
    if (!Number.isFinite(contract.bid) || !Number.isFinite(contract.ask)) continue;
    const key = normalizeOptionSymbol(entry.symbol);
    if (map.has(key)) continue;
    const quoteTime = contract.quoteTime;
    map.set(key, {
      bid: contract.bid,
      ask: contract.ask,
      quoteTime: typeof quoteTime === "number" && Number.isFinite(quoteTime) && quoteTime > 0 ? quoteTime : null,
      source,
    });
  }
}

function uniqueSymbols(symbols: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i].trim();
    if (!symbol) continue;
    const key = normalizeOptionSymbol(symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

function missingSymbols(wanted: readonly string[], map: ReadonlyMap<string, AvwapQuote>): string[] {
  const missing: string[] = [];
  for (let i = 0; i < wanted.length; i++) {
    if (!map.has(normalizeOptionSymbol(wanted[i]))) missing.push(wanted[i]);
  }
  return missing;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
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
