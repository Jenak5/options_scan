import type { CandleBar } from "@/app/lib/candleTypes";
import {
  advanceCallsPaper,
  callsPaperSection,
  callsQuotePlan,
  callsSkipReason,
  formatCallsPaperAlert,
  parseCallsPaperBook,
  serializeCallsPaperBook,
  CALLS_CHAIN_STRIKE_COUNT,
  CALLS_DTE_MAX,
  CALLS_DTE_MIN,
  CALLS_SYMBOLS,
  type CallsContractQuote,
  type CallsMarket,
  type CallsPaperSection,
  type CallsQuotePlan,
  type CallsSnapshot,
} from "@/app/lib/callsPaper";
import { addCalendarDays, newYorkDate } from "@/app/lib/flow";
import type { OptionContract } from "@/app/lib/contract";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { getOptionChain, getPriceHistory, getQuoteEntries } from "@/app/lib/schwab";
import type { PriceCandle } from "@/app/lib/schwabParse";
import { readCallsPaperBookText, resolveStoreKind, updateCallsPaperBook } from "@/app/lib/schwabStore";
import { sendTelegramAlert } from "@/app/lib/telegram";

/**
 * Scheduled paper pass for the flush-then-reclaim call and bull call spread.
 * Price history, option chains, and option quotes only. It does not call an
 * account, an order, or a transaction endpoint, and it does not write the A/B alert book.
 * Schwab market-data paths: pricehistory, chains, quotes.
 */

export const CALLS_MARKET_DATA_PATHS = ["pricehistory", "chains", "quotes"] as const;

export interface CallsQuote {
  bid: number;
  ask: number;
  delta: number | null;
}

export interface CallsChainRead {
  quotes: CallsContractQuote[];
  problem: "delayed" | "unavailable" | null;
}

export interface CallsPaperDeps {
  daily: (symbol: string, now: Date) => Promise<CandleBar[]>;
  minutes: (symbol: string, now: Date) => Promise<CandleBar[]>;
  chain: (symbol: string, now: Date) => Promise<CallsChainRead>;
  quotes: (symbols: readonly string[]) => Promise<Map<string, CallsQuote>>;
  readBook: () => Promise<string | null>;
  writeBook: (change: (current: string | null) => string) => Promise<boolean>;
  send: (message: string) => Promise<boolean>;
}

export interface CallsRunResult {
  opened: number;
  openedA: number;
  openedS: number;
  closed: number;
  saved: boolean;
  skipped: "holiday" | "closed" | null;
  drawdownFlag: boolean;
  logNote: string;
}

export async function loadCallsPaperSection(now: Date = new Date()): Promise<CallsPaperSection> {
  const text = await readCallsPaperBookText();
  const stored = resolveStoreKind() !== "unconfigured";
  return callsPaperSection(parseCallsPaperBook(text), now, stored);
}

export async function runCallsPaper(now: Date, deps: CallsPaperDeps = defaultDeps()): Promise<CallsRunResult> {
  const skip = callsSkipReason(now);
  if (skip) {
    return {
      opened: 0,
      openedA: 0,
      openedS: 0,
      closed: 0,
      saved: true,
      skipped: skip,
      drawdownFlag: false,
      logNote: skip === "holiday" ? "market holiday" : "outside market hours",
    };
  }

  const markets: CallsMarket[] = [];
  for (let i = 0; i < CALLS_SYMBOLS.length; i++) {
    const symbol = CALLS_SYMBOLS[i];
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

  const current = parseCallsPaperBook(await deps.readBook());
  const plan = callsQuotePlan(current, markets, now);
  const chainReads = new Map<string, CallsChainRead>();
  await Promise.all(plan.chainSymbols.map(async (symbol) => {
    try {
      chainReads.set(symbol, await deps.chain(symbol, now));
    } catch {
      chainReads.set(symbol, { quotes: [], problem: "unavailable" });
    }
  }));
  let quoteMap = new Map<string, CallsQuote>();
  if (plan.marks.length > 0) {
    try {
      quoteMap = await deps.quotes(plan.marks.map((item) => item.occ));
    } catch {
      quoteMap = new Map();
    }
  }
  const snapshots = markets.map((market) => attachQuotes(market, plan, chainReads, quoteMap));
  let openedIds: string[] = [];
  let closedCount = 0;
  const saved = await deps.writeBook((text) => {
    const advanced = advanceCallsPaper(parseCallsPaperBook(text), snapshots, now);
    openedIds = advanced.opened.map((trade) => trade.id);
    closedCount = advanced.closed.length;
    return serializeCallsPaperBook(advanced.book);
  });
  if (!saved) {
    return {
      opened: 0,
      openedA: 0,
      openedS: 0,
      closed: 0,
      saved: false,
      skipped: null,
      drawdownFlag: false,
      logNote: "paper log was not saved",
    };
  }
  const stored = parseCallsPaperBook(await deps.readBook());
  const opened = stored.trades.filter((trade) => openedIds.includes(trade.id));
  for (let i = 0; i < opened.length; i++) {
    await deps.send(formatCallsPaperAlert(opened[i]));
  }
  const health = callsPaperSection(stored, now, true).health;
  const notes = CALLS_SYMBOLS.map((symbol) => `${symbol}: ${stored.notes[symbol] ?? "no note"}`).join("; ");
  const flagged: string[] = [];
  if (health.setups.A.drawdownFlag) flagged.push("A");
  if (health.setups.S.drawdownFlag) flagged.push("S");
  const flag = flagged.length > 0 ? ` Drawdown flag over $1,500 on setup ${flagged.join(" and ")}.` : "";
  const openedA = opened.filter((trade) => trade.setup === "A").length;
  const openedS = opened.filter((trade) => trade.setup === "S").length;
  return {
    opened: opened.length,
    openedA,
    openedS,
    closed: closedCount,
    saved: true,
    skipped: null,
    drawdownFlag: flagged.length > 0,
    logNote: `${notes}.${flag}`,
  };
}

function attachQuotes(
  market: CallsMarket,
  plan: CallsQuotePlan,
  chains: ReadonlyMap<string, CallsChainRead>,
  marks: ReadonlyMap<string, CallsQuote>,
): CallsSnapshot {
  const byKey = new Map<string, CallsContractQuote>();
  const wanted = plan.chainSymbols.includes(market.symbol);
  const chain = wanted ? chains.get(market.symbol) ?? { quotes: [], problem: "unavailable" as const } : null;
  if (chain && chain.problem == null) {
    for (let i = 0; i < chain.quotes.length; i++) {
      const quote = chain.quotes[i];
      byKey.set(quoteKey(quote.expiration, quote.strike), quote);
    }
  }
  for (let i = 0; i < plan.marks.length; i++) {
    const request = plan.marks[i];
    if (request.symbol !== market.symbol) continue;
    const quote = marks.get(normalizeOptionSymbol(request.occ));
    if (!quote) continue;
    const key = quoteKey(request.expiration, request.strike);
    const prior = byKey.get(key);
    byKey.set(key, {
      expiration: request.expiration,
      strike: request.strike,
      bid: quote.bid,
      ask: quote.ask,
      delta: prior?.delta ?? quote.delta,
    });
  }
  return {
    ...market,
    quotes: Array.from(byKey.values()),
    chainProblem: chain?.problem ?? null,
  };
}

function quoteKey(expiration: string, strike: number): string {
  return `${expiration}|${strike}`;
}

function defaultDeps(): CallsPaperDeps {
  return {
    daily: loadDaily,
    minutes: loadMinutes,
    chain: loadChain,
    quotes: loadQuotes,
    readBook: readCallsPaperBookText,
    writeBook: updateCallsPaperBook,
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

async function loadChain(symbol: string, now: Date): Promise<CallsChainRead> {
  const today = newYorkDate(now);
  const chain = await getOptionChain({
    symbol,
    contractType: "CALL",
    fromDate: addCalendarDays(today, CALLS_DTE_MIN),
    toDate: addCalendarDays(today, CALLS_DTE_MAX),
    strikeCount: CALLS_CHAIN_STRIKE_COUNT,
  });
  if (chain.delayed) return { quotes: [], problem: "delayed" };
  const quotes: CallsContractQuote[] = [];
  for (let i = 0; i < chain.contracts.length; i++) {
    const quote = toCallQuote(chain.contracts[i]);
    if (quote) quotes.push(quote);
  }
  return { quotes, problem: null };
}

async function loadQuotes(symbols: readonly string[]): Promise<Map<string, CallsQuote>> {
  const map = new Map<string, CallsQuote>();
  if (symbols.length === 0) return map;
  const read = await getQuoteEntries(symbols.slice());
  for (let i = 0; i < read.entries.length; i++) {
    const entry = read.entries[i];
    const contract = entry.contract;
    if (contract.putCall !== "call") continue;
    if (!(contract.ask >= 0) || !(contract.bid >= 0)) continue;
    map.set(normalizeOptionSymbol(entry.symbol), {
      bid: contract.bid,
      ask: contract.ask,
      delta: contract.delta != null && Number.isFinite(contract.delta) ? contract.delta : null,
    });
  }
  return map;
}

function toCallQuote(contract: OptionContract): CallsContractQuote | null {
  if (contract.putCall !== "call") return null;
  if (!Number.isFinite(contract.bid) || !Number.isFinite(contract.ask)) return null;
  if (contract.bid < 0 || contract.ask < 0 || contract.ask + 1e-9 < contract.bid) return null;
  if (!(contract.strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(contract.expiration)) return null;
  return {
    expiration: contract.expiration,
    strike: contract.strike,
    bid: contract.bid,
    ask: contract.ask,
    delta: contract.delta != null && Number.isFinite(contract.delta) ? contract.delta : null,
  };
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
