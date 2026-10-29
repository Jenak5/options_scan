import type { CandleBar } from "@/app/lib/candleTypes";
import {
  advanceAvwapPaper,
  avwapPaperSection,
  avwapSkipReason,
  formatAvwapPaperAlert,
  parseAvwapPaperBook,
  quotePlan,
  serializeAvwapPaperBook,
  AVWAP_SYMBOLS,
  type AvwapMarket,
  type AvwapPaperSection,
  type AvwapQuoteRequest,
  type AvwapSnapshot,
} from "@/app/lib/avwapPaper";
import { getPriceHistory, getQuoteEntries } from "@/app/lib/schwab";
import type { PriceCandle } from "@/app/lib/schwabParse";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { readAvwapPaperBookText, resolveStoreKind, updateAvwapPaperBook } from "@/app/lib/schwabStore";
import { sendTelegramAlert } from "@/app/lib/telegram";

/**
 * Scheduled paper pass for the gap-day anchored VWAP put.
 * Price history and option quotes only. It does not call a chain, an account,
 * or any order endpoint, and it does not write the A/B alert book.
 */

export interface AvwapQuote {
  bid: number;
  ask: number;
}

export interface AvwapPaperDeps {
  daily: (symbol: string, now: Date) => Promise<CandleBar[]>;
  minutes: (symbol: string, now: Date) => Promise<CandleBar[]>;
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

  const markets: AvwapMarket[] = [];
  for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
    const symbol = AVWAP_SYMBOLS[i];
    const [dailyBars, minuteBars] = await Promise.all([
      deps.daily(symbol, now).catch(() => [] as CandleBar[]),
      deps.minutes(symbol, now).catch(() => [] as CandleBar[]),
    ]);
    markets.push({
      symbol,
      daily: dailyBars.map((bar) => ({ t: bar.t, open: bar.o, close: bar.c })),
      bars: minuteBars,
    });
  }

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

async function loadMinutes(symbol: string, now: Date): Promise<CandleBar[]> {
  const candles = await getPriceHistory({
    symbol,
    periodType: "day",
    period: 10,
    frequencyType: "minute",
    frequency: 5,
    needExtendedHoursData: false,
    startDate: now.getTime() - 12 * 24 * 60 * 60 * 1000,
    endDate: now.getTime(),
  });
  return candles.map(toBar);
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
