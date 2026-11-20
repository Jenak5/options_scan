import seedRows from "../../data/gex-seed.json";
import { addCalendarDays, calendarDaysBetween } from "@/app/lib/flow";
import { chunkSymbols } from "@/app/lib/eodFlow";
import {
  computeGexLevels,
  emptyGexBook,
  futuresPrice,
  GEX_MAX_DTE,
  GEX_UNDERLYINGS,
  gexCronDecision,
  mergeGexSeed,
  parseGexBook,
  upsertGexRow,
  type GexBook,
  type GexContract,
  type GexRow,
  type GexUnderlying,
} from "@/app/lib/gex";
import { chicagoDate } from "@/app/lib/marketHours";
import { SCAN_TIME_BUDGET_MS } from "@/app/lib/scanHealth";
import * as schwab from "@/app/lib/schwab";
import { readGexText, resolveStoreKind, updateGexBook } from "@/app/lib/schwabStore";
import {
  selectChainSymbols,
  streamerFromOcc,
  underlyingFromItems,
  type NestedExpiration,
} from "@/app/lib/tastytradeMarketParse";
import { ttActiveFuture, ttGexFeed, ttOptionExpirations, ttQuotes } from "@/app/lib/tastytradeMarket";

/**
 * Pre-market QQQ and SPY gamma levels.
 * Tastytrade chain and DXLink greeks are primary. Schwab is the chain backup.
 * A missing greek stays missing. The seed fills days the store does not have.
 */

const SAVE_MARGIN_MS = 15_000;
const STORE_MESSAGE = "The private store is not configured, so the gamma levels were not saved.";

export interface GexJobOptions {
  now?: Date;
  manual?: boolean;
  budgetMs?: number;
  nowMs?: () => number;
  loadUnderlying?: (symbol: GexUnderlying, sessionDate: string, timeoutMs: number) => Promise<GexRow | null>;
}

export interface GexJobResult {
  ok: boolean;
  skipped: string | null;
  reason: string | null;
  date: string | null;
  saved: GexUnderlying[];
  pending: GexUnderlying | null;
}

/** Checked-in history. A row that does not parse is dropped. */
export function gexSeedRows(): GexRow[] {
  const book = parseGexBook(JSON.stringify({ version: 1, rows: seedRows, pending: null, lockUntil: null }));
  return book?.rows ?? [];
}

export async function loadGexRows(): Promise<GexRow[]> {
  if (resolveStoreKind() === "unconfigured") return mergeGexSeed([], gexSeedRows());
  const book = parseGexBook(await readGexText());
  if (!book) return [];
  return mergeGexSeed(book.rows, gexSeedRows());
}

export async function runGexJob(options: GexJobOptions = {}): Promise<GexJobResult> {
  const now = options.now ?? new Date();
  const manual = options.manual === true;
  const nowMs = options.nowMs ?? Date.now;
  const decision = gexCronDecision(now, manual);
  if (!decision.run) return { ok: true, skipped: decision.reason, reason: decision.reason, date: null, saved: [], pending: null };
  if (resolveStoreKind() === "unconfigured") {
    return { ok: false, skipped: null, reason: STORE_MESSAGE, date: null, saved: [], pending: null };
  }
  const date = chicagoDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, skipped: null, reason: "The Chicago session date is not available.", date: null, saved: [], pending: null };
  }
  const budgetMs = options.budgetMs ?? SCAN_TIME_BUDGET_MS;
  const deadline = nowMs() + budgetMs;
  const held: { status: "ok" | "busy" | "skip" | "unreadable"; book: GexBook | null } = { status: "ok", book: null };
  const storedToday = new Set<GexUnderlying>();
  const locked = await updateGexBook((current) => {
    const parsed = parseGexBook(current);
    if (!parsed) {
      held.status = "unreadable";
      return null;
    }
    parsed.rows.forEach((row) => {
      if (row.date === date) storedToday.add(row.underlying);
    });
    const book = { ...parsed, rows: mergeGexSeed(parsed.rows, gexSeedRows()) };
    if (book.pending !== "QQQ" && book.pending !== "SPY") book.pending = null;
    const finished = GEX_UNDERLYINGS.every((name) => storedToday.has(name));
    if (!manual && book.pending == null && finished) {
      held.status = "skip";
      held.book = book;
      return JSON.stringify(book);
    }
    if (book.lockUntil != null && book.lockUntil > nowMs()) {
      held.status = "busy";
      held.book = book;
      return current ?? JSON.stringify(book);
    }
    if (manual) book.pending = null;
    book.lockUntil = deadline;
    held.status = "ok";
    held.book = book;
    return JSON.stringify(book);
  });
  if (held.status === "unreadable" || !locked) {
    return { ok: false, skipped: null, reason: "The gamma book could not be read.", date, saved: [], pending: null };
  }
  if (held.status === "skip") {
    return { ok: true, skipped: "already collected", reason: "already collected", date, saved: [], pending: null };
  }
  if (held.status === "busy") {
    return { ok: true, skipped: "busy", reason: "busy", date, saved: [], pending: null };
  }

  const book = held.book ?? emptyGexBook();
  const saved: GexUnderlying[] = [];
  const errors: string[] = [];
  let failed = false;
  const load = options.loadUnderlying ?? defaultLoadUnderlying;
  try {
    const startAt = book.pending ?? nextMissing(book, date);
    const names = GEX_UNDERLYINGS.slice(GEX_UNDERLYINGS.indexOf(startAt ?? "QQQ"));
    for (let i = 0; i < names.length; i++) {
      if (nowMs() >= deadline - SAVE_MARGIN_MS) {
        book.pending = names[i];
        break;
      }
      const symbol = names[i];
      if (storedToday.has(symbol) && !manual) continue;
      const timeoutMs = Math.max(5_000, deadline - nowMs() - SAVE_MARGIN_MS);
      try {
        const row = await load(symbol, date, timeoutMs);
        if (!row) {
          errors.push(`${symbol}: gamma levels were not read`);
          book.pending = symbol;
          failed = true;
          break;
        }
        book.rows = upsertGexRow(book.rows, row);
        saved.push(symbol);
        book.pending = i + 1 < names.length ? names[i + 1] : null;
      } catch (err) {
        errors.push(`${symbol}: ${safeError(err)}`);
        book.pending = symbol;
        failed = true;
        break;
      }
    }
    if (!failed && book.pending && book.rows.some((row) => row.date === date && row.underlying === book.pending)) {
      book.pending = nextMissing(book, date);
    }
  } finally {
    book.lockUntil = null;
    if (!(await writeBook(book))) {
      errors.push("The gamma levels could not be saved.");
      failed = true;
    }
  }
  return {
    ok: !failed && errors.length === 0,
    skipped: null,
    reason: errors[0] ?? null,
    date,
    saved,
    pending: book.pending,
  };
}

async function defaultLoadUnderlying(symbol: GexUnderlying, sessionDate: string, timeoutMs: number): Promise<GexRow | null> {
  const toDate = addCalendarDays(sessionDate, GEX_MAX_DTE);
  let contracts: GexContract[] = [];
  let spot: number | null = null;
  let source = "Tastytrade";
  try {
    const expirations = await ttOptionExpirations(symbol);
    contracts = contractsFromNested(expirations, sessionDate, toDate);
    const quotes = await ttQuotes({ equity: [symbol] });
    spot = underlyingFromItems(quotes, symbol);
  } catch {
    source = "Schwab";
    const chain = await schwab.getOptionChain({
      symbol,
      contractType: "ALL",
      range: "ALL",
      fromDate: sessionDate,
      toDate,
    });
    spot = chain.underlyingPrice;
    contracts = chain.contracts
      .filter((contract) => contract.putCall === "call" || contract.putCall === "put")
      .map((contract) => ({
        expiration: contract.expiration,
        dte: calendarDaysBetween(sessionDate, contract.expiration) ?? -1,
        strike: contract.strike,
        putCall: contract.putCall,
        gamma: null,
        iv: contract.iv,
        openInterest: Number.isFinite(contract.openInterest) ? contract.openInterest : null,
      }));
  }
  if (spot == null || !(spot > 0)) return null;
  const band = contracts.filter((contract) => contract.dte >= 0 && contract.dte <= GEX_MAX_DTE && Math.abs(contract.strike / spot - 1) <= 0.12);
  const streamers = band.map((contract) => streamerFor(contract, symbol)).filter((symbol): symbol is string => symbol != null);
  const readings = new Map<string, { gamma: number | null; iv: number | null; openInterest: number | null }>();
  const chunks = chunkSymbols(streamers, 4_500);
  let left = timeoutMs;
  for (let i = 0; i < chunks.length && left > 5_000; i++) {
    const started = Date.now();
    try {
      const feed = await ttGexFeed(chunks[i], { timeoutMs: Math.min(left, 90_000) });
      feed.forEach((reading, key) => readings.set(key, reading));
    } catch {
      source = source === "Tastytrade" ? "Tastytrade" : source;
    }
    left -= Date.now() - started;
  }
  const priced = band.map((contract) => {
    const key = streamerFor(contract, symbol);
    const reading = key ? readings.get(key) : undefined;
    return {
      ...contract,
      gamma: reading?.gamma ?? contract.gamma,
      iv: reading?.iv ?? contract.iv,
      openInterest: reading?.openInterest ?? contract.openInterest,
    };
  });
  const levels = computeGexLevels({ spot, contracts: priced });
  const future = await futureQuote(symbol === "QQQ" ? "NQ" : "ES").catch(() => null);
  const ratio = future && future.price > 0 ? future.price / spot : null;
  return rowFromLevels(symbol, sessionDate, spot, levels, future, ratio, source);
}

function rowFromLevels(
  symbol: GexUnderlying,
  date: string,
  spot: number,
  levels: ReturnType<typeof computeGexLevels>,
  future: { symbol: string; price: number } | null,
  ratio: number | null,
  source: string,
): GexRow {
  const fut = (level: number | null) => futuresPrice(level, ratio);
  return {
    date,
    runTimeCt: null,
    underlying: symbol,
    spot,
    dataTimestamp: null,
    totalGex: levels.totalGex,
    flip: levels.flip,
    flipFutures: fut(levels.flip),
    callWall1: levels.callWalls[0],
    callWall2: levels.callWalls[1],
    callWall3: levels.callWalls[2],
    callWall1Futures: fut(levels.callWalls[0]),
    callWall2Futures: fut(levels.callWalls[1]),
    callWall3Futures: fut(levels.callWalls[2]),
    putWall1: levels.putWalls[0],
    putWall2: levels.putWalls[1],
    putWall3: levels.putWalls[2],
    putWall1Futures: fut(levels.putWalls[0]),
    putWall2Futures: fut(levels.putWalls[1]),
    putWall3Futures: fut(levels.putWalls[2]),
    nearExpiry: levels.nearExpiry,
    nearGex: levels.nearGex,
    nearFlip: levels.nearFlip,
    nearFlipFutures: fut(levels.nearFlip),
    futuresSymbol: future?.symbol ?? null,
    futuresPrice: future?.price ?? null,
    ratio,
    gammaCoverage: levels.gammaCoverage,
    source,
  };
}

async function futureQuote(product: "NQ" | "ES"): Promise<{ symbol: string; price: number } | null> {
  const symbol = await ttActiveFuture(product);
  if (!symbol) return null;
  const feed = await ttGexFeed([symbol], { timeoutMs: 8_000, quietMs: 1_500, includeTrade: true });
  const price = feed.get(symbol)?.price ?? null;
  if (price == null || !(price > 0)) return null;
  return { symbol, price };
}

function contractsFromNested(expirations: readonly NestedExpiration[], fromDate: string, toDate: string): GexContract[] {
  const selected = selectChainSymbols(expirations, { fromDate, toDate, contractType: "ALL" }, null);
  const out: GexContract[] = [];
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    const dte = calendarDaysBetween(fromDate, row.expiration);
    if (dte == null) continue;
    out.push({
      expiration: row.expiration,
      dte,
      strike: row.strike,
      putCall: row.putCall,
      gamma: null,
      iv: null,
      openInterest: null,
    });
  }
  return out;
}

function streamerFor(contract: GexContract, underlying: string): string | null {
  return streamerFromOcc(occSymbol(underlying, contract));
}

function occSymbol(underlying: string, contract: GexContract): string {
  const [year, month, day] = contract.expiration.split("-");
  const side = contract.putCall === "call" ? "C" : "P";
  const strike = Math.round(contract.strike * 1000).toString().padStart(8, "0");
  return `${underlying.padEnd(6, " ")}${year.slice(2)}${month}${day}${side}${strike}`;
}

function nextMissing(book: GexBook, date: string): GexUnderlying | null {
  for (let i = 0; i < GEX_UNDERLYINGS.length; i++) {
    const name = GEX_UNDERLYINGS[i];
    if (!book.rows.some((row) => row.date === date && row.underlying === name)) return name;
  }
  return null;
}

async function writeBook(book: GexBook): Promise<boolean> {
  return updateGexBook((current) => {
    if (parseGexBook(current) == null) return null;
    return JSON.stringify(book);
  });
}

function safeError(err: unknown): string {
  const text = err instanceof Error ? err.message : "The data request failed";
  return text.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/\s+/g, " ").slice(0, 180);
}
