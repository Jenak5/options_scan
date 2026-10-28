import type { CandleBar } from "@/app/lib/candleTypes";
import {
  advanceJgVwap,
  formatJgVwapAlert,
  jgAtr14,
  jgAtrUsed,
  jgChainRoots,
  jgHistorySymbol,
  jgNextTradingDay,
  jgTodayRange,
  jgVwapSection,
  jgVwapSessionOpen,
  parseJgVwapBook,
  serializeJgVwapBook,
  JG_VWAP_TICKERS,
  type JgRunMeta,
  type JgSnapshot,
  type JgTicker,
  type JgVwapSection,
  type JgVwapTrade,
} from "@/app/lib/jgVwap";
import { jgFindSignal, type JgDailyBar } from "@/app/lib/jgSignal";
import { newYorkDate } from "@/app/lib/flow";
import { getOptionChain, getPriceHistory } from "@/app/lib/marketData";
import type { ChainParseResult, PriceCandle } from "@/app/lib/schwabParse";
import { readJgVwapBookText, updateJgVwapBook } from "@/app/lib/schwabStore";
import { sendTelegramAlert } from "@/app/lib/telegram";

/**
 * Scheduled paper pass for JG-VWAP. It reads chains, 1-minute candles, and
 * daily candles from the same price history, writes its own log, and sends
 * PAPER TEST telegrams through sendTelegramAlert.
 * It does not call the A/B alert chooser and it does not write the alert book.
 */

export interface JgVwapDeps {
  history: (symbol: string, now: Date) => Promise<CandleBar[]>;
  /** Completed daily bars from the same price-history source as the intraday candles. */
  daily: (symbol: string, now: Date) => Promise<CandleBar[]>;
  /** Daily bars for VXN or VIX. Empty when that index did not load. */
  vol: (symbol: "VXN" | "VIX", now: Date) => Promise<CandleBar[]>;
  chain: (symbol: string, fromDay: string, toDay: string) => Promise<ChainParseResult>;
  readBook: () => Promise<string | null>;
  writeBook: (change: (current: string | null) => string) => Promise<boolean>;
  send: (message: string) => Promise<boolean>;
}

export interface JgVwapRunResult {
  opened: number;
  closed: number;
  saved: boolean;
  skipped: "closed" | null;
  spxRoot: "SPX" | "SPXW" | null;
  spxUnavailable: boolean;
  logNote: string;
}

export async function loadJgVwapSection(): Promise<JgVwapSection> {
  const text = await readJgVwapBookText();
  return jgVwapSection(parseJgVwapBook(text));
}

export async function runJgVwapPaper(now: Date, deps: JgVwapDeps = defaultDeps()): Promise<JgVwapRunResult> {
  if (!jgVwapSessionOpen(now)) {
    return { opened: 0, closed: 0, saved: true, skipped: "closed", spxRoot: null, spxUnavailable: false, logNote: "outside market hours" };
  }
  const day = newYorkDate(now);
  const toDay = jgNextTradingDay(day) ?? day;
  const snapshots: JgSnapshot[] = [];
  let spxRoot: "SPX" | "SPXW" | null = null;
  let spxChainMiss = false;
  let spxVwapMiss = false;
  const signalNotes: string[] = [];

  for (let i = 0; i < JG_VWAP_TICKERS.length; i++) {
    const ticker = JG_VWAP_TICKERS[i];
    const symbol = jgHistorySymbol(ticker);
    const volSymbol = ticker === "SPX" ? "VIX" : "VXN";
    const [bars, dailyBars, volBars] = await Promise.all([
      deps.history(symbol, now),
      deps.daily(symbol, now),
      deps.vol(volSymbol, now),
    ]);
    const daily = toDaily(dailyBars);
    const atrUsed = jgAtrUsed(jgTodayRange(bars, now.getTime()), jgAtr14(dailyBars, day));
    const volIndex = priorClose(volBars, day);
    const found = jgFindSignal({
      bars,
      daily,
      volIndex,
      volSymbol,
      day,
      nowMs: now.getTime(),
      atrUsed,
      enforceSeed: true,
    });
    if (found.status !== "signal") {
      signalNotes.push(found.status === "vwap-reject" ? `${ticker} VWAP reject ${found.signal.vwapDist}` : `${ticker} ${found.reason}`);
    }
    if (ticker === "SPX" && bars.length === 0) spxVwapMiss = true;
    const loaded = await loadChain(jgChainRoots(ticker), day, toDay, deps);
    if (ticker === "SPX") {
      if (loaded.root === "SPX" || loaded.root === "SPXW") spxRoot = loaded.root;
      else spxChainMiss = true;
    }
    const signal = found.status === "signal" ? found.signal : null;
    const chainSpot = loaded.chain?.underlyingPrice;
    const spot = signal?.entry ?? (chainSpot != null && chainSpot > 0 ? chainSpot : null);
    snapshots.push({
      ticker,
      root: loaded.root,
      spot,
      vwap: signal?.vwap ?? null,
      contracts: loaded.chain?.contracts ?? [],
      atrUsed: signal?.atrUsed ?? atrUsed,
      signal,
      signalNote: found.status === "signal" ? "" : found.status === "vwap-reject" ? `VWAP reject ${found.signal.vwapDist}` : found.reason,
      bars,
    });
  }

  const meta: JgRunMeta = { spxRoot, spxChainMiss, spxVwapMiss };
  const openedById = new Map<string, JgVwapTrade>();
  const closedIds = new Set<string>();
  let spxStored: "SPX" | "SPXW" | null = spxRoot;
  let spxUnavailable = spxChainMiss;
  let oneDteNote = "";
  const saved = await deps.writeBook((text) => {
    const current = parseJgVwapBook(text);
    const advanced = advanceJgVwap(current, snapshots, now, meta);
    for (let i = 0; i < advanced.opened.length; i++) openedById.set(advanced.opened[i].id, advanced.opened[i]);
    for (let i = 0; i < advanced.closed.length; i++) closedIds.add(advanced.closed[i].id);
    spxStored = advanced.book.spxRoot;
    spxUnavailable = advanced.book.spxUnavailable;
    oneDteNote = advanced.book.oneDteNote;
    return serializeJgVwapBook(advanced.book);
  });
  if (!saved) {
    return { opened: 0, closed: 0, saved: false, skipped: null, spxRoot: spxStored, spxUnavailable, logNote: logNote(spxStored, spxUnavailable, spxVwapMiss, oneDteNote, signalNotes) };
  }
  const stored = parseJgVwapBook(await deps.readBook());
  const opened = stored.trades.filter((trade) => openedById.has(trade.id));
  for (let i = 0; i < opened.length; i++) {
    // Same Telegram send as the paper test in PR #66. The ATR line is inside the message.
    await deps.send(formatJgVwapAlert(opened[i]));
  }
  return {
    opened: opened.length,
    closed: closedIds.size,
    saved: true,
    skipped: null,
    spxRoot: stored.spxRoot ?? spxStored,
    spxUnavailable: stored.spxUnavailable,
    logNote: logNote(stored.spxRoot ?? spxStored, stored.spxUnavailable, stored.spxVwapMiss, stored.oneDteNote, signalNotes),
  };
}

function logNote(
  spxRoot: "SPX" | "SPXW" | null,
  unavailable: boolean,
  vwapMiss: boolean,
  oneDteNote: string,
  signalNotes: readonly string[],
): string {
  const parts = [spxNote(spxRoot, unavailable, vwapMiss)];
  if (oneDteNote) parts.push(oneDteNote);
  if (signalNotes.length > 0) parts.push(signalNotes.join("; "));
  return parts.join(". ");
}

function spxNote(spxRoot: "SPX" | "SPXW" | null, unavailable: boolean, vwapMiss: boolean): string {
  if (unavailable && spxRoot == null) return "SPX and SPXW chains unavailable; QQQ only";
  if (unavailable) return `latest SPX chain missed; last root ${spxRoot}`;
  if (vwapMiss && spxRoot) return `SPX contracts on ${spxRoot}; SPX VWAP candles missing`;
  if (spxRoot) return `SPX contracts on ${spxRoot}`;
  return "SPX chain not seen yet";
}

async function loadChain(
  roots: readonly string[],
  fromDay: string,
  toDay: string,
  deps: JgVwapDeps,
): Promise<{ root: JgTicker | "SPXW" | null; chain: ChainParseResult | null }> {
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    try {
      const chain = await deps.chain(root, fromDay, toDay);
      if (chain.contracts.length > 0 && (root === "QQQ" || root === "SPX" || root === "SPXW")) {
        return { root, chain };
      }
    } catch {
      // A missed SPX chain still leaves QQQ to log. The next run tries again.
    }
  }
  return { root: null, chain: null };
}

function defaultDeps(): JgVwapDeps {
  return {
    history: loadHistory,
    daily: loadDaily,
    vol: loadVol,
    chain: loadOptionChain,
    readBook: readJgVwapBookText,
    writeBook: updateJgVwapBook,
    send: sendTelegramAlert,
  };
}

async function loadHistory(symbol: string, now: Date): Promise<CandleBar[]> {
  try {
    const candles = await getPriceHistory({
      symbol,
      periodType: "day",
      period: 10,
      frequencyType: "minute",
      frequency: 5,
      needExtendedHoursData: false,
      startDate: now.getTime() - 30 * 24 * 60 * 60 * 1000,
      endDate: now.getTime(),
    });
    return candles.map(toBar);
  } catch {
    return [];
  }
}

async function loadDaily(symbol: string, now: Date): Promise<CandleBar[]> {
  try {
    const candles = await getPriceHistory({
      symbol,
      periodType: "month",
      period: 10,
      frequencyType: "daily",
      frequency: 1,
      needExtendedHoursData: false,
      startDate: Date.parse("2018-05-01T00:00:00.000Z"),
      endDate: now.getTime(),
    });
    return candles.map(toBar);
  } catch {
    return [];
  }
}

async function loadVol(symbol: "VXN" | "VIX", now: Date): Promise<CandleBar[]> {
  try {
    const candles = await getPriceHistory({
      symbol,
      periodType: "month",
      period: 2,
      frequencyType: "daily",
      frequency: 1,
      needExtendedHoursData: false,
      startDate: now.getTime() - 80 * 24 * 60 * 60 * 1000,
      endDate: now.getTime(),
    });
    return candles.map(toBar);
  } catch {
    return [];
  }
}

function toDaily(bars: readonly CandleBar[]): JgDailyBar[] {
  const byDate = new Map<string, JgDailyBar>();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!(bar.h > 0) || !(bar.l > 0) || !(bar.c > 0) || bar.h < bar.l) continue;
    const date = newYorkDate(new Date(bar.t));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDate.set(date, { date, high: bar.h, low: bar.l, close: bar.c });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function priorClose(bars: readonly CandleBar[], day: string): number | null {
  let close: number | null = null;
  let date = "";
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!(bar.c > 0)) continue;
    const barDay = newYorkDate(new Date(bar.t));
    if (!barDay || barDay >= day || barDay < date) continue;
    date = barDay;
    close = bar.c;
  }
  return close;
}

async function loadOptionChain(symbol: string, fromDay: string, toDay: string): Promise<ChainParseResult> {
  return getOptionChain({
    symbol,
    contractType: "ALL",
    fromDate: fromDay,
    toDate: toDay,
    range: "NTM",
    strikeCount: 8,
  });
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
