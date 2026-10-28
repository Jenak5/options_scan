import type { CandleBar } from "@/app/lib/candleTypes";
import {
  advanceJgVwap,
  formatJgVwapAlert,
  jgChainRoots,
  jgHistorySymbol,
  jgSessionVwap,
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
import { newYorkDate } from "@/app/lib/flow";
import { getOptionChain, getPriceHistory } from "@/app/lib/marketData";
import type { ChainParseResult, PriceCandle } from "@/app/lib/schwabParse";
import { readJgVwapBookText, updateJgVwapBook } from "@/app/lib/schwabStore";
import { sendTelegramAlert } from "@/app/lib/telegram";

/**
 * Scheduled paper pass for JG-VWAP. It reads chains and 1-minute candles,
 * writes its own log, and sends PAPER TEST telegrams.
 * It does not call the A/B alert chooser and it does not write the alert book.
 */

export interface JgVwapDeps {
  history: (symbol: string, now: Date) => Promise<CandleBar[]>;
  chain: (symbol: string, day: string) => Promise<ChainParseResult>;
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
  const snapshots: JgSnapshot[] = [];
  let spxRoot: "SPX" | "SPXW" | null = null;
  let spxChainMiss = false;
  let spxVwapMiss = false;

  for (let i = 0; i < JG_VWAP_TICKERS.length; i++) {
    const ticker = JG_VWAP_TICKERS[i];
    const bars = await deps.history(jgHistorySymbol(ticker), now);
    const session = jgSessionVwap(bars, now.getTime());
    if (ticker === "SPX" && !session) spxVwapMiss = true;
    const loaded = await loadChain(jgChainRoots(ticker), day, deps);
    if (ticker === "SPX") {
      if (loaded.root === "SPX" || loaded.root === "SPXW") spxRoot = loaded.root;
      else spxChainMiss = true;
    }
    const chainSpot = loaded.chain?.underlyingPrice;
    const spot = chainSpot != null && chainSpot > 0 ? chainSpot : session?.close ?? null;
    snapshots.push({
      ticker,
      root: loaded.root,
      spot,
      vwap: session?.vwap ?? null,
      contracts: loaded.chain?.contracts ?? [],
    });
  }

  const meta: JgRunMeta = { spxRoot, spxChainMiss, spxVwapMiss };
  const openedById = new Map<string, JgVwapTrade>();
  const closedIds = new Set<string>();
  let spxStored: "SPX" | "SPXW" | null = spxRoot;
  let spxUnavailable = spxChainMiss;
  const saved = await deps.writeBook((text) => {
    const current = parseJgVwapBook(text);
    const advanced = advanceJgVwap(current, snapshots, now, meta);
    for (let i = 0; i < advanced.opened.length; i++) openedById.set(advanced.opened[i].id, advanced.opened[i]);
    for (let i = 0; i < advanced.closed.length; i++) closedIds.add(advanced.closed[i].id);
    spxStored = advanced.book.spxRoot;
    spxUnavailable = advanced.book.spxUnavailable;
    return serializeJgVwapBook(advanced.book);
  });
  if (!saved) {
    return { opened: 0, closed: 0, saved: false, skipped: null, spxRoot: spxStored, spxUnavailable, logNote: logNote(spxStored, spxUnavailable, spxVwapMiss) };
  }
  const stored = parseJgVwapBook(await deps.readBook());
  const opened = stored.trades.filter((trade) => openedById.has(trade.id));
  for (let i = 0; i < opened.length; i++) {
    await deps.send(formatJgVwapAlert(opened[i]));
  }
  return {
    opened: opened.length,
    closed: closedIds.size,
    saved: true,
    skipped: null,
    spxRoot: stored.spxRoot ?? spxStored,
    spxUnavailable: stored.spxUnavailable,
    logNote: logNote(stored.spxRoot ?? spxStored, stored.spxUnavailable, stored.spxVwapMiss),
  };
}

function logNote(spxRoot: "SPX" | "SPXW" | null, unavailable: boolean, vwapMiss: boolean): string {
  if (unavailable && spxRoot == null) return "SPX and SPXW chains unavailable; QQQ only";
  if (unavailable) return `latest SPX chain missed; last root ${spxRoot}`;
  if (vwapMiss && spxRoot) return `SPX contracts on ${spxRoot}; SPX VWAP candles missing`;
  if (spxRoot) return `SPX contracts on ${spxRoot}`;
  return "SPX chain not seen yet";
}

async function loadChain(
  roots: readonly string[],
  day: string,
  deps: JgVwapDeps,
): Promise<{ root: JgTicker | "SPXW" | null; chain: ChainParseResult | null }> {
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    try {
      const chain = await deps.chain(root, day);
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
      period: 1,
      frequencyType: "minute",
      frequency: 1,
      needExtendedHoursData: false,
      startDate: now.getTime() - 36 * 60 * 60 * 1000,
      endDate: now.getTime(),
    });
    return candles.map(toBar);
  } catch {
    return [];
  }
}

async function loadOptionChain(symbol: string, day: string): Promise<ChainParseResult> {
  return getOptionChain({
    symbol,
    contractType: "ALL",
    fromDate: day,
    toDate: day,
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
