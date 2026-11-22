import {
  AVWAP_BAR_MS,
  AVWAP_PRIMARY_DTE_MAX,
  AVWAP_PRIMARY_DTE_MIN,
  AVWAP_PRIMARY_DTE_TARGET,
  AVWAP_SYMBOLS,
  AVWAP_TARGET_FRACTION,
  anchorCovered,
  atmStrike,
  avwapContractCount,
  avwapPnl,
  avwapPoints,
  avwapSessionOpen,
  bidHitsTarget,
  expiryCandidates,
  isExpiryFinalScan,
  latestAvwapCross,
  latestGapDay,
  signalIsFresh,
  type AvwapMark,
  type AvwapMarket,
  type AvwapPaperBook,
  type AvwapQuoteRequest,
  type AvwapSnapshot,
  type AvwapSymbol,
  type AvwapSymbolCheck,
} from "@/app/lib/avwapPaper";
import { calendarDaysBetween, newYorkDate } from "@/app/lib/flow";
import { nyMinutes } from "@/app/lib/featureBackfill";
import { schwabOptionSymbol } from "@/app/lib/optionSymbol";

/**
 * Two paper books that follow the live AVWAP put, with one entry filter each.
 * They do not send Telegram, place orders, or read a broker. The scan passes
 * the quotes it already loaded (Tastytrade, then Schwab only for a gap).
 * A skipped signal does not take the book's one-position slot.
 */

export const AVWAP_SHADOW_BOOK_IDS = ["skip-monday", "skip-before-945"] as const;
export type AvwapShadowBookId = (typeof AVWAP_SHADOW_BOOK_IDS)[number];
export type AvwapSignalBookId = "main" | AvwapShadowBookId;

/** A bar that closes at this New York minute is kept. Earlier closes are not. */
export const AVWAP_SHADOW_CUTOFF_MINUTE = 9 * 60 + 45;
export const AVWAP_SHADOW_MARK_CAP = 560;
export const AVWAP_SHADOW_TRADE_CAP = 80;
export const AVWAP_SHADOW_SIGNAL_CAP = 400;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export type NyWeekday = (typeof WEEKDAYS)[number];

export const AVWAP_SHADOW_NOTE =
  "Paper only. No order is placed. No Telegram alert is sent. Each book uses the same AVWAP put signal and the same quote as the live book (Tastytrade, Schwab only when that quote is missing). Buy the at-the-money put nearest 7 calendar days and inside 5–10, at the ask, up to the $875 debit cap. Sell at the bid when the bid is 50% above the entry ask. Otherwise sell at the bid on the expiry-day final scan, 3:55 PM New York, or 12:55 PM New York on an early close. One open position per ticker in that book. A signal the book ignores leaves the slot free. There is no stop. Skip Monday ignores a signal bar whose New York date is Monday. Skip before 9:45 ignores a signal bar that closes before 9:45 AM New York. A bar that closes at 9:45 is kept.";

interface ShadowSpec {
  id: AvwapShadowBookId;
  label: string;
  rule: string;
  skips: (signalAt: number) => boolean;
  skipReason: string;
}

const SHADOW_SPECS: readonly ShadowSpec[] = [
  {
    id: "skip-monday",
    label: "Skip Monday",
    rule: "Ignore a signal whose bar falls on a Monday in New York. The ticker slot stays free.",
    skips: (signalAt) => nyWeekday(signalAt) === "Monday",
    skipReason: "signal bar is a Monday in New York",
  },
  {
    id: "skip-before-945",
    label: "Skip before 9:45",
    rule: "Ignore a signal whose bar closes before 9:45 AM New York. A close at 9:45 is kept. The ticker slot stays free.",
    skips: (signalAt) => signalBarClosesBefore945(signalAt),
    skipReason: "signal bar closes before 9:45 AM New York",
  },
];

/** Weekday of the New York calendar date. Null when the instant is not a real time. */
export function nyWeekday(at: number): NyWeekday | null {
  if (!Number.isFinite(at)) return null;
  const ymd = newYorkDate(new Date(at));
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  const noon = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  const day = noon.getUTCDay();
  return WEEKDAYS[day] ?? null;
}

/** True when the 5-minute signal bar's New York date is Monday. */
export function signalBarIsMonday(signalAt: number): boolean {
  return nyWeekday(signalAt) === "Monday";
}

/**
 * True when the signal bar closes before 9:45 AM New York.
 * The close is five minutes after the bar start. A close at 9:45 is false.
 */
export function signalBarClosesBefore945(signalAt: number): boolean {
  if (!Number.isFinite(signalAt)) return true;
  const minutes = nyMinutes(signalAt + AVWAP_BAR_MS);
  if (!Number.isFinite(minutes)) return true;
  return minutes < AVWAP_SHADOW_CUTOFF_MINUTE;
}

export interface AvwapBookDecision {
  action: "taken" | "skipped";
  reason: string;
}

export interface AvwapSignalLog {
  id: string;
  symbol: AvwapSymbol;
  side: "put";
  nyDate: string;
  dayOfWeek: NyWeekday;
  signalAt: number;
  signalCloseAt: number;
  anchorDate: string;
  /** open / prior close − 1 on the anchor day. */
  gap: number;
  gapDirection: "up" | "down";
  /** Signal close minus that bar's anchored VWAP. Negative means below VWAP. */
  vwapDistance: number;
  signalClose: number;
  signalVwap: number;
  entryBid: number | null;
  entryAsk: number | null;
  entrySpread: number | null;
  books: Record<AvwapSignalBookId, AvwapBookDecision>;
  loggedAt: number;
}

export interface AvwapShadowMark {
  at: number;
  bid: number;
  ask: number;
  spread: number;
}

export interface AvwapShadowTrade {
  id: string;
  bookId: AvwapShadowBookId;
  symbol: AvwapSymbol;
  side: "put";
  putCall: "put";
  strike: number;
  expiration: string;
  dte: number;
  contracts: number;
  openedAt: number;
  signalAt: number;
  signalCloseAt: number;
  anchorDate: string;
  gap: number;
  spot: number;
  signalClose: number;
  signalVwap: number;
  entryBid: number;
  entryAsk: number;
  entrySpread: number;
  marks: AvwapShadowMark[];
  lastBid: number | null;
  lastAsk: number | null;
  lastQuoteAt: number | null;
  status: "open" | "closed";
  closedAt: number | null;
  exitBid: number | null;
  exitAsk: number | null;
  exitReason: "target50" | "expiry" | null;
  exitNote: string | null;
  pnlDollars: number | null;
}

export interface AvwapShadowBookState {
  trades: AvwapShadowTrade[];
  notes: Partial<Record<AvwapSymbol, string>>;
  checks: Partial<Record<AvwapSymbol, AvwapSymbolCheck>>;
  updatedAt: number | null;
}

export interface AvwapShadowBook {
  version: 1;
  books: Record<AvwapShadowBookId, AvwapShadowBookState>;
  signals: AvwapSignalLog[];
  updatedAt: number | null;
}

export interface AvwapShadowAdvance {
  book: AvwapShadowBook;
  opened: number;
  closed: number;
  byBook: Record<AvwapShadowBookId, { opened: number; closed: number }>;
}

export function emptyShadowBookState(): AvwapShadowBookState {
  return { trades: [], notes: {}, checks: {}, updatedAt: null };
}

export function emptyAvwapShadowBook(): AvwapShadowBook {
  return {
    version: 1,
    books: {
      "skip-monday": emptyShadowBookState(),
      "skip-before-945": emptyShadowBookState(),
    },
    signals: [],
    updatedAt: null,
  };
}

export function serializeAvwapShadowBook(book: AvwapShadowBook): string {
  return JSON.stringify({
    version: 1,
    books: book.books,
    signals: book.signals,
    updatedAt: book.updatedAt,
  });
}

export function parseAvwapShadowBook(text: string | null | undefined): AvwapShadowBook {
  if (!text) return emptyAvwapShadowBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyAvwapShadowBook();
  }
  const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  if (!row || !Array.isArray(row.signals)) return emptyAvwapShadowBook();
  const books = emptyAvwapShadowBook().books;
  const source = row.books && typeof row.books === "object" ? row.books as Record<string, unknown> : {};
  for (let i = 0; i < AVWAP_SHADOW_BOOK_IDS.length; i++) {
    const id = AVWAP_SHADOW_BOOK_IDS[i];
    books[id] = parseBookState(source[id]);
  }
  const signals: AvwapSignalLog[] = [];
  for (let i = 0; i < row.signals.length; i++) {
    const signal = parseSignal(row.signals[i]);
    if (signal) signals.push(signal);
  }
  return {
    version: 1,
    books,
    signals: trimSignals(signals),
    updatedAt: finiteNumber(row.updatedAt),
  };
}

/** Puts the live book already quotes, plus shadow opens and fresh signals the live book may skip. */
export function shadowQuoteRequests(
  book: AvwapShadowBook,
  markets: readonly AvwapMarket[],
  now: Date,
): AvwapQuoteRequest[] {
  if (!avwapSessionOpen(now)) return [];
  const requests: AvwapQuoteRequest[] = [];
  const seen = new Set<string>();
  const add = (symbol: AvwapSymbol, expiration: string, strike: number) => {
    const occ = schwabOptionSymbol({ ticker: symbol, expiration, strike, putCall: "put" });
    if (!occ || seen.has(occ)) return;
    seen.add(occ);
    requests.push({ occ, symbol, expiration, strike });
  };
  for (let b = 0; b < AVWAP_SHADOW_BOOK_IDS.length; b++) {
    const trades = book.books[AVWAP_SHADOW_BOOK_IDS[b]].trades;
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i];
      if (trade.status === "open") add(trade.symbol, trade.expiration, trade.strike);
    }
  }
  const today = newYorkDate(now);
  const nowMs = now.getTime();
  for (let i = 0; i < markets.length; i++) {
    const setup = readSetup(markets[i], today, nowMs);
    if (!setup?.fresh || setup.signalAt == null || setup.strike == null) continue;
    const expiries = expiryCandidates(today, AVWAP_PRIMARY_DTE_MIN, AVWAP_PRIMARY_DTE_MAX, AVWAP_PRIMARY_DTE_TARGET);
    for (let e = 0; e < expiries.length; e++) add(markets[i].symbol, expiries[e], setup.strike);
  }
  return requests;
}

export function mergeQuoteRequests(
  base: readonly AvwapQuoteRequest[],
  extra: readonly AvwapQuoteRequest[],
): AvwapQuoteRequest[] {
  const seen = new Set<string>();
  const out: AvwapQuoteRequest[] = [];
  const add = (item: AvwapQuoteRequest) => {
    if (seen.has(item.occ)) return;
    seen.add(item.occ);
    out.push(item);
  };
  for (let i = 0; i < base.length; i++) add(base[i]);
  for (let i = 0; i < extra.length; i++) add(extra[i]);
  return out;
}

/**
 * Mark open shadow puts and open a fresh signal the book's filter allows.
 * A closed session returns the book unchanged. No daily stop and no price stop.
 */
export function advanceAvwapShadows(
  book: AvwapShadowBook,
  snapshots: readonly AvwapSnapshot[],
  mainBook: AvwapPaperBook,
  now: Date,
): AvwapShadowAdvance {
  const byBook = emptyCounts();
  if (!avwapSessionOpen(now)) return { book, opened: 0, closed: 0, byBook };
  const nowMs = now.getTime();
  const today = newYorkDate(now);
  const bySymbol = new Map<AvwapSymbol, AvwapSnapshot>();
  for (let i = 0; i < snapshots.length; i++) bySymbol.set(snapshots[i].symbol, snapshots[i]);
  const signalById = new Map<string, AvwapSignalLog>();
  for (let i = 0; i < book.signals.length; i++) signalById.set(book.signals[i].id, book.signals[i]);

  let opened = 0;
  let closed = 0;
  const books = emptyAvwapShadowBook().books;
  for (let s = 0; s < SHADOW_SPECS.length; s++) {
    const spec = SHADOW_SPECS[s];
    let trades = book.books[spec.id].trades.map(cloneTrade);
    for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
      const symbol = AVWAP_SYMBOLS[i];
      const snap = bySymbol.get(symbol) ?? null;
      trades = trades.map((trade) => {
        if (trade.symbol !== symbol || trade.status !== "open") return trade;
        const next = markOpen(trade, snap, now);
        if (next.status === "closed") {
          closed += 1;
          byBook[spec.id].closed += 1;
        }
        return next;
      });
    }
    const notes: Partial<Record<AvwapSymbol, string>> = {};
    const checks: Partial<Record<AvwapSymbol, AvwapSymbolCheck>> = {};
    for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
      const symbol = AVWAP_SYMBOLS[i];
      const snap = bySymbol.get(symbol) ?? null;
      const decision = decideEntry(spec, trades, snap, today, nowMs);
      notes[symbol] = decision.reason;
      checks[symbol] = {
        anchorDate: decision.anchorDate,
        gap: decision.gap,
        reason: decision.reason,
        entered: decision.trade != null,
      };
      if (decision.fresh) {
        touchSignal(signalById, decision.fresh, mainBook, spec.id, {
          action: decision.trade ? "taken" : "skipped",
          reason: decision.reason,
        }, nowMs);
      }
      if (!decision.trade) continue;
      trades.push(decision.trade);
      opened += 1;
      byBook[spec.id].opened += 1;
    }
    books[spec.id] = { trades: trimTrades(trades), notes, checks, updatedAt: nowMs };
  }

  return {
    book: {
      version: 1,
      books,
      signals: trimSignals(Array.from(signalById.values())),
      updatedAt: nowMs,
    },
    opened,
    closed,
    byBook,
  };
}

export interface AvwapShadowMonth {
  month: string;
  closed: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  netPnlDollars: number;
}

export interface AvwapShadowViewTrade extends AvwapShadowTrade {
  unrealizedPnlDollars: number | null;
  debitDollars: number;
  markCount: number;
}

export interface AvwapShadowBookView {
  id: AvwapShadowBookId;
  label: string;
  rule: string;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  netPnlDollars: number;
  openUnrealizedDollars: number;
  byMonth: AvwapShadowMonth[];
  notes: Partial<Record<AvwapSymbol, string>>;
  open: AvwapShadowViewTrade[];
  closed: AvwapShadowViewTrade[];
}

export interface AvwapShadowSection {
  label: "AVWAP shadow paper";
  note: string;
  paperOnly: true;
  telegram: false;
  stored: boolean;
  updatedAt: number | null;
  books: AvwapShadowBookView[];
  signals: AvwapSignalLog[];
}

export function avwapShadowSection(book: AvwapShadowBook, stored: boolean): AvwapShadowSection {
  const signals = book.signals.slice().sort((a, b) => b.signalAt - a.signalAt || a.symbol.localeCompare(b.symbol));
  return {
    label: "AVWAP shadow paper",
    note: AVWAP_SHADOW_NOTE,
    paperOnly: true,
    telegram: false,
    stored,
    updatedAt: book.updatedAt,
    books: SHADOW_SPECS.map((spec) => bookView(spec, book.books[spec.id])),
    signals,
  };
}

export function mainSignalDecision(mainBook: AvwapPaperBook, symbol: AvwapSymbol, signalAt: number): AvwapBookDecision {
  for (let i = 0; i < mainBook.trades.length; i++) {
    const trade = mainBook.trades[i];
    if (trade.symbol === symbol && trade.signalAt === signalAt) {
      return { action: "taken", reason: mainBook.checks[symbol]?.reason ?? "paper entry" };
    }
  }
  return { action: "skipped", reason: mainBook.checks[symbol]?.reason ?? mainBook.notes[symbol] ?? "not taken" };
}

interface Setup {
  gapDate: string;
  gap: number;
  signalAt: number | null;
  signalClose: number | null;
  signalVwap: number | null;
  fresh: boolean;
  covered: boolean;
  firstDate: string | null;
  spot: number | null;
  strike: number | null;
  points: number;
}

interface FreshSeen {
  symbol: AvwapSymbol;
  at: number;
  closeAt: number;
  close: number;
  vwap: number;
  gap: number;
  anchorDate: string;
  quote: AvwapMark | null;
}

interface EntryChoice {
  trade: AvwapShadowTrade | null;
  reason: string;
  anchorDate: string | null;
  gap: number | null;
  fresh: FreshSeen | null;
}

function bookView(spec: ShadowSpec, state: AvwapShadowBookState): AvwapShadowBookView {
  const open = state.trades.filter((trade) => trade.status === "open").map(viewTrade);
  const closed = state.trades.filter((trade) => trade.status === "closed").map(viewTrade);
  open.sort((a, b) => b.openedAt - a.openedAt);
  closed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const tally = tallyTrades(state.trades);
  return {
    id: spec.id,
    label: spec.label,
    rule: spec.rule,
    openCount: open.length,
    closedCount: closed.length,
    wins: tally.wins,
    losses: tally.losses,
    flats: tally.flats,
    winRate: winRate(tally.wins, tally.losses),
    netPnlDollars: tally.net,
    openUnrealizedDollars: roundCents(open.reduce((sum, trade) => sum + (trade.unrealizedPnlDollars ?? 0), 0)),
    byMonth: monthRows(state.trades),
    notes: state.notes,
    open,
    closed,
  };
}

function tallyTrades(trades: readonly AvwapShadowTrade[]): { wins: number; losses: number; flats: number; net: number } {
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let net = 0;
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.status !== "closed" || trade.pnlDollars == null) continue;
    net += trade.pnlDollars;
    if (trade.pnlDollars > 0) wins += 1;
    else if (trade.pnlDollars < 0) losses += 1;
    else flats += 1;
  }
  return { wins, losses, flats, net: roundCents(net) };
}

function monthRows(trades: readonly AvwapShadowTrade[]): AvwapShadowMonth[] {
  const buckets = new Map<string, AvwapShadowTrade[]>();
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.status !== "closed" || trade.closedAt == null || trade.pnlDollars == null) continue;
    const month = newYorkDate(new Date(trade.closedAt)).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const list = buckets.get(month);
    if (list) list.push(trade);
    else buckets.set(month, [trade]);
  }
  const months = Array.from(buckets.keys()).sort((a, b) => b.localeCompare(a));
  return months.map((month) => {
    const tally = tallyTrades(buckets.get(month) ?? []);
    return {
      month,
      closed: tally.wins + tally.losses + tally.flats,
      wins: tally.wins,
      losses: tally.losses,
      flats: tally.flats,
      winRate: winRate(tally.wins, tally.losses),
      netPnlDollars: tally.net,
    };
  });
}

function viewTrade(trade: AvwapShadowTrade): AvwapShadowViewTrade {
  const unrealized = trade.status === "open" && trade.lastBid != null
    ? avwapPnl(trade.entryAsk, trade.lastBid, trade.contracts)
    : null;
  return {
    ...trade,
    unrealizedPnlDollars: unrealized,
    debitDollars: roundCents(trade.entryAsk * 100 * trade.contracts),
    markCount: trade.marks.length,
  };
}

function decideEntry(
  spec: ShadowSpec,
  trades: readonly AvwapShadowTrade[],
  snap: AvwapSnapshot | null,
  today: string,
  nowMs: number,
): EntryChoice {
  const symbol = snap?.symbol;
  if (!snap || !symbol) return choice("no bars on this scan");
  if (snap.historyFailed) return choice("price history failed");
  const setup = readSetup(snap, today, nowMs);
  if (!setup) return choice("no gap of more than 1% in the daily bars");
  const anchorDate = setup.gapDate;
  const gap = setup.gap;
  if (setup.points === 0) return choice(`gap ${anchorDate} has no completed regular-hours bars in this fetch`, anchorDate, gap);
  if (!setup.covered) {
    return choice(`gap ${anchorDate} is before the 5-minute history (starts ${setup.firstDate}). Anchored VWAP was not computed.`, anchorDate, gap);
  }
  if (setup.signalAt == null || setup.signalClose == null || setup.signalVwap == null) {
    return choice(`anchored at ${anchorDate}; no close below the anchored VWAP after a prior close at or above it`, anchorDate, gap);
  }
  const fresh = setup.fresh ? freshSeen(snap, setup, today) : null;
  if (fresh && (nyWeekday(fresh.at) == null || !Number.isFinite(nyMinutes(fresh.closeAt)))) {
    return choice("signal bar has no New York time", anchorDate, gap, null, fresh);
  }
  if (fresh && spec.skips(fresh.at)) return choice(spec.skipReason, anchorDate, gap, null, fresh);
  if (hasOpen(trades, symbol)) return choice("one paper position is already open", anchorDate, gap, null, fresh);
  if (alreadySignaled(trades, symbol, setup.signalAt)) return choice("this cross was already papered", anchorDate, gap, null, fresh);
  if (!setup.fresh || !fresh) return choice("the latest cross below the anchored VWAP is older than this scan", anchorDate, gap);
  if (setup.strike == null || setup.spot == null) return choice("no underlying price for the at-the-money strike", anchorDate, gap, null, fresh);
  const trade = openTrade(spec, snap, setup, fresh, today, nowMs);
  if (!trade) {
    if (fresh.quote && avwapContractCount(fresh.quote.ask) === 0) return choice("one contract costs more than $875", anchorDate, gap, null, fresh);
    return choice("no put quote in the 5–10 day window", anchorDate, gap, null, fresh);
  }
  const noun = trade.contracts === 1 ? "contract" : "contracts";
  return choice(`paper entry, ${trade.contracts} ${noun}`, anchorDate, gap, trade, fresh);
}

function freshSeen(snap: AvwapSnapshot, setup: Setup, today: string): FreshSeen | null {
  if (setup.signalAt == null || setup.signalClose == null || setup.signalVwap == null) return null;
  const quote = setup.strike == null ? null : pickPrimary(snap.quotes, today, setup.strike);
  return {
    symbol: snap.symbol,
    at: setup.signalAt,
    closeAt: setup.signalAt + AVWAP_BAR_MS,
    close: setup.signalClose,
    vwap: setup.signalVwap,
    gap: setup.gap,
    anchorDate: setup.gapDate,
    quote,
  };
}

function openTrade(
  spec: ShadowSpec,
  snap: AvwapSnapshot,
  setup: Setup,
  fresh: FreshSeen,
  today: string,
  nowMs: number,
): AvwapShadowTrade | null {
  if (setup.strike == null || setup.spot == null || !fresh.quote) return null;
  const quote = fresh.quote;
  const contracts = avwapContractCount(quote.ask);
  if (contracts == null || contracts < 1) return null;
  const dte = calendarDaysBetween(today, quote.expiration);
  if (dte == null || dte < AVWAP_PRIMARY_DTE_MIN || dte > AVWAP_PRIMARY_DTE_MAX) return null;
  const spread = quoteSpread(quote.bid, quote.ask);
  const mark = { at: nowMs, bid: quote.bid, ask: quote.ask, spread };
  return {
    id: `avwap-shadow-${spec.id}-${snap.symbol}-${fresh.at}`,
    bookId: spec.id,
    symbol: snap.symbol,
    side: "put",
    putCall: "put",
    strike: setup.strike,
    expiration: quote.expiration,
    dte,
    contracts,
    openedAt: nowMs,
    signalAt: fresh.at,
    signalCloseAt: fresh.closeAt,
    anchorDate: fresh.anchorDate,
    gap: fresh.gap,
    spot: setup.spot,
    signalClose: fresh.close,
    signalVwap: fresh.vwap,
    entryBid: quote.bid,
    entryAsk: quote.ask,
    entrySpread: spread,
    marks: [mark],
    lastBid: quote.bid,
    lastAsk: quote.ask,
    lastQuoteAt: nowMs,
    status: "open",
    closedAt: null,
    exitBid: null,
    exitAsk: null,
    exitReason: null,
    exitNote: null,
    pnlDollars: null,
  };
}

function markOpen(trade: AvwapShadowTrade, snap: AvwapSnapshot | null, now: Date): AvwapShadowTrade {
  const nowMs = now.getTime();
  const quote = findMark(snap?.quotes ?? [], trade.expiration, trade.strike);
  if (quote) {
    const marked: AvwapShadowTrade = {
      ...trade,
      lastBid: quote.bid,
      lastAsk: quote.ask,
      lastQuoteAt: nowMs,
      marks: appendMark(trade.marks, {
        at: nowMs,
        bid: quote.bid,
        ask: quote.ask,
        spread: quoteSpread(quote.bid, quote.ask),
      }),
    };
    if (bidHitsTarget(quote.bid, trade.entryAsk, AVWAP_TARGET_FRACTION)) {
      return closeTrade(marked, quote.bid, quote.ask, "target50", null, nowMs);
    }
    if (isExpiryFinalScan(now, trade.expiration)) {
      return closeTrade(marked, quote.bid, quote.ask, "expiry", null, nowMs);
    }
    return marked;
  }
  if (isExpiryFinalScan(now, trade.expiration) && newYorkDate(now) > trade.expiration) {
    return closeTrade(trade, 0, null, "expiry", "No bid after expiration. Closed at 0.", nowMs);
  }
  return trade;
}

function closeTrade(
  trade: AvwapShadowTrade,
  bid: number,
  ask: number | null,
  reason: "target50" | "expiry",
  note: string | null,
  nowMs: number,
): AvwapShadowTrade {
  return {
    ...trade,
    status: "closed",
    closedAt: nowMs,
    exitBid: bid,
    exitAsk: ask,
    exitReason: reason,
    exitNote: note,
    pnlDollars: avwapPnl(trade.entryAsk, bid, trade.contracts),
    lastBid: bid,
    lastAsk: ask ?? trade.lastAsk,
    lastQuoteAt: nowMs,
  };
}

function touchSignal(
  signalById: Map<string, AvwapSignalLog>,
  fresh: FreshSeen,
  mainBook: AvwapPaperBook,
  bookId: AvwapShadowBookId,
  decision: AvwapBookDecision,
  nowMs: number,
): void {
  const day = nyWeekday(fresh.at);
  const nyDate = newYorkDate(new Date(fresh.at));
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(nyDate)) return;
  const id = `${fresh.symbol}-${fresh.at}`;
  const existing = signalById.get(id);
  const quote = fresh.quote;
  const row: AvwapSignalLog = existing ?? {
    id,
    symbol: fresh.symbol,
    side: "put",
    nyDate,
    dayOfWeek: day,
    signalAt: fresh.at,
    signalCloseAt: fresh.closeAt,
    anchorDate: fresh.anchorDate,
    gap: fresh.gap,
    gapDirection: fresh.gap < 0 ? "down" : "up",
    vwapDistance: roundDistance(fresh.close - fresh.vwap),
    signalClose: fresh.close,
    signalVwap: fresh.vwap,
    entryBid: null,
    entryAsk: null,
    entrySpread: null,
    books: {
      main: mainSignalDecision(mainBook, fresh.symbol, fresh.at),
      "skip-monday": { action: "skipped", reason: "not checked" },
      "skip-before-945": { action: "skipped", reason: "not checked" },
    },
    loggedAt: nowMs,
  };
  row.books.main = keepTaken(row.books.main, mainSignalDecision(mainBook, fresh.symbol, fresh.at));
  row.books[bookId] = keepTaken(row.books[bookId], decision);
  if (quote && (decision.action === "taken" || row.entryBid == null || row.entryAsk == null)) {
    row.entryBid = quote.bid;
    row.entryAsk = quote.ask;
    row.entrySpread = quoteSpread(quote.bid, quote.ask);
  }
  signalById.set(id, row);
}

function keepTaken(previous: AvwapBookDecision | undefined, next: AvwapBookDecision): AvwapBookDecision {
  if (previous?.action === "taken") return previous;
  return next;
}

function readSetup(market: AvwapMarket, today: string, nowMs: number): Setup | null {
  const gap = latestGapDay(market.daily, today);
  if (!gap) return null;
  const points = avwapPoints(market.bars, gap.date, nowMs);
  const coverage = anchorCovered(market.bars, gap.date, nowMs);
  const signal = coverage.covered ? latestAvwapCross(market.bars, gap.date, nowMs) : null;
  const spot = points.length > 0 ? points[points.length - 1].close : null;
  return {
    gapDate: gap.date,
    gap: gap.gap,
    signalAt: signal?.at ?? null,
    signalClose: signal?.close ?? null,
    signalVwap: signal?.vwap ?? null,
    fresh: signal != null && signalIsFresh(signal, nowMs),
    covered: coverage.covered,
    firstDate: coverage.firstDate,
    spot,
    strike: spot == null ? null : atmStrike(spot),
    points: points.length,
  };
}

function pickPrimary(quotes: readonly AvwapMark[], today: string, strike: number): AvwapMark | null {
  const order = expiryCandidates(today, AVWAP_PRIMARY_DTE_MIN, AVWAP_PRIMARY_DTE_MAX, AVWAP_PRIMARY_DTE_TARGET);
  for (let i = 0; i < order.length; i++) {
    const found = findMark(quotes, order[i], strike);
    if (found && found.ask > 0) return found;
  }
  return null;
}

function findMark(quotes: readonly AvwapMark[], expiration: string, strike: number): AvwapMark | null {
  for (let i = 0; i < quotes.length; i++) {
    const quote = quotes[i];
    if (quote.expiration !== expiration) continue;
    if (Math.abs(quote.strike - strike) > 1e-6) continue;
    if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) continue;
    if (quote.bid < 0 || quote.ask < 0 || quote.ask + 1e-9 < quote.bid) continue;
    return quote;
  }
  return null;
}

function hasOpen(trades: readonly AvwapShadowTrade[], symbol: AvwapSymbol): boolean {
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].symbol === symbol && trades[i].status === "open") return true;
  }
  return false;
}

function alreadySignaled(trades: readonly AvwapShadowTrade[], symbol: AvwapSymbol, signalAt: number): boolean {
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].symbol === symbol && trades[i].signalAt === signalAt) return true;
  }
  return false;
}

function appendMark(marks: readonly AvwapShadowMark[], mark: AvwapShadowMark): AvwapShadowMark[] {
  if (marks.length > 0 && marks[marks.length - 1].at === mark.at) {
    const copy = marks.slice();
    copy[copy.length - 1] = mark;
    return copy;
  }
  const next = marks.concat(mark);
  if (next.length <= AVWAP_SHADOW_MARK_CAP) return next;
  return [next[0]].concat(next.slice(next.length - (AVWAP_SHADOW_MARK_CAP - 1)));
}

function choice(
  reason: string,
  anchorDate: string | null = null,
  gap: number | null = null,
  trade: AvwapShadowTrade | null = null,
  fresh: FreshSeen | null = null,
): EntryChoice {
  return { trade, reason, anchorDate, gap, fresh };
}

function emptyCounts(): Record<AvwapShadowBookId, { opened: number; closed: number }> {
  return {
    "skip-monday": { opened: 0, closed: 0 },
    "skip-before-945": { opened: 0, closed: 0 },
  };
}

function cloneTrade(trade: AvwapShadowTrade): AvwapShadowTrade {
  return { ...trade, marks: trade.marks.map((mark) => ({ ...mark })) };
}

function trimTrades(trades: AvwapShadowTrade[]): AvwapShadowTrade[] {
  const active: AvwapShadowTrade[] = [];
  const done: AvwapShadowTrade[] = [];
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].status === "open") active.push(trades[i]);
    else done.push(trades[i]);
  }
  done.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  const room = Math.max(0, AVWAP_SHADOW_TRADE_CAP - active.length);
  return active.concat(done.slice(0, room));
}

function trimSignals(signals: AvwapSignalLog[]): AvwapSignalLog[] {
  const copy = signals.slice();
  copy.sort((a, b) => b.signalAt - a.signalAt || a.id.localeCompare(b.id));
  return copy.slice(0, AVWAP_SHADOW_SIGNAL_CAP);
}

function quoteSpread(bid: number, ask: number): number {
  return roundCents(ask - bid);
}

function winRate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  if (decided < 1) return null;
  return Math.round((wins / decided) * 10000) / 10000;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundDistance(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBookState(value: unknown): AvwapShadowBookState {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!row || !Array.isArray(row.trades)) return emptyShadowBookState();
  const trades: AvwapShadowTrade[] = [];
  for (let i = 0; i < row.trades.length; i++) {
    const trade = parseTrade(row.trades[i]);
    if (trade) trades.push(trade);
  }
  return {
    trades: trimTrades(trades),
    notes: parseNotes(row.notes),
    checks: parseChecks(row.checks),
    updatedAt: finiteNumber(row.updatedAt),
  };
}

function parseNotes(value: unknown): Partial<Record<AvwapSymbol, string>> {
  const notes: Partial<Record<AvwapSymbol, string>> = {};
  if (!value || typeof value !== "object") return notes;
  const row = value as Record<string, unknown>;
  for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
    const symbol = AVWAP_SYMBOLS[i];
    const note = row[symbol];
    if (typeof note === "string" && note.length > 0 && note.length < 400) notes[symbol] = note;
  }
  return notes;
}

function parseChecks(value: unknown): Partial<Record<AvwapSymbol, AvwapSymbolCheck>> {
  const checks: Partial<Record<AvwapSymbol, AvwapSymbolCheck>> = {};
  if (!value || typeof value !== "object") return checks;
  const row = value as Record<string, unknown>;
  for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
    const symbol = AVWAP_SYMBOLS[i];
    const item = row[symbol];
    if (!item || typeof item !== "object") continue;
    const check = item as Record<string, unknown>;
    if (typeof check.reason !== "string") continue;
    checks[symbol] = {
      anchorDate: typeof check.anchorDate === "string" ? check.anchorDate : null,
      gap: finiteNumber(check.gap),
      reason: check.reason,
      entered: check.entered === true,
    };
  }
  return checks;
}

function parseTrade(value: unknown): AvwapShadowTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!isBookId(row.bookId) || !isSymbol(row.symbol)) return null;
  if (row.side !== "put" && row.putCall !== "put") return null;
  if (row.status !== "open" && row.status !== "closed") return null;
  const strike = finiteNumber(row.strike);
  const contracts = finiteNumber(row.contracts);
  const entryBid = finiteNumber(row.entryBid);
  const entryAsk = finiteNumber(row.entryAsk);
  const openedAt = finiteNumber(row.openedAt);
  const signalAt = finiteNumber(row.signalAt);
  if (strike == null || contracts == null || entryBid == null || entryAsk == null) return null;
  if (openedAt == null || signalAt == null) return null;
  if (typeof row.expiration !== "string" || typeof row.id !== "string") return null;
  const marks = parseMarks(row.marks);
  const entrySpread = finiteNumber(row.entrySpread) ?? quoteSpread(entryBid, entryAsk);
  return {
    id: row.id,
    bookId: row.bookId,
    symbol: row.symbol,
    side: "put",
    putCall: "put",
    strike,
    expiration: row.expiration,
    dte: finiteNumber(row.dte) ?? 0,
    contracts,
    openedAt,
    signalAt,
    signalCloseAt: finiteNumber(row.signalCloseAt) ?? signalAt + AVWAP_BAR_MS,
    anchorDate: typeof row.anchorDate === "string" ? row.anchorDate : "",
    gap: finiteNumber(row.gap) ?? 0,
    spot: finiteNumber(row.spot) ?? strike,
    signalClose: finiteNumber(row.signalClose) ?? 0,
    signalVwap: finiteNumber(row.signalVwap) ?? 0,
    entryBid,
    entryAsk,
    entrySpread,
    marks,
    lastBid: finiteNumber(row.lastBid),
    lastAsk: finiteNumber(row.lastAsk),
    lastQuoteAt: finiteNumber(row.lastQuoteAt),
    status: row.status,
    closedAt: finiteNumber(row.closedAt),
    exitBid: finiteNumber(row.exitBid),
    exitAsk: finiteNumber(row.exitAsk),
    exitReason: row.exitReason === "target50" || row.exitReason === "expiry" ? row.exitReason : null,
    exitNote: typeof row.exitNote === "string" ? row.exitNote : null,
    pnlDollars: finiteNumber(row.pnlDollars),
  };
}

function parseMarks(value: unknown): AvwapShadowMark[] {
  if (!Array.isArray(value)) return [];
  const marks: AvwapShadowMark[] = [];
  for (let i = 0; i < value.length && marks.length < AVWAP_SHADOW_MARK_CAP; i++) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    const mark = row as Record<string, unknown>;
    const at = finiteNumber(mark.at);
    const bid = finiteNumber(mark.bid);
    const ask = finiteNumber(mark.ask);
    if (at == null || bid == null || ask == null) continue;
    if (bid < 0 || ask < 0 || ask + 1e-9 < bid) continue;
    marks.push({ at, bid, ask, spread: finiteNumber(mark.spread) ?? quoteSpread(bid, ask) });
  }
  return marks;
}

function parseSignal(value: unknown): AvwapSignalLog | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!isSymbol(row.symbol) || row.side !== "put") return null;
  if (typeof row.id !== "string" || typeof row.nyDate !== "string") return null;
  if (!isWeekday(row.dayOfWeek)) return null;
  const signalAt = finiteNumber(row.signalAt);
  const loggedAt = finiteNumber(row.loggedAt);
  if (signalAt == null || loggedAt == null) return null;
  const gap = finiteNumber(row.gap);
  if (gap == null) return null;
  const books = parseDecisions(row.books);
  if (!books) return null;
  return {
    id: row.id,
    symbol: row.symbol,
    side: "put",
    nyDate: row.nyDate,
    dayOfWeek: row.dayOfWeek,
    signalAt,
    signalCloseAt: finiteNumber(row.signalCloseAt) ?? signalAt + AVWAP_BAR_MS,
    anchorDate: typeof row.anchorDate === "string" ? row.anchorDate : "",
    gap,
    gapDirection: row.gapDirection === "down" ? "down" : "up",
    vwapDistance: finiteNumber(row.vwapDistance) ?? 0,
    signalClose: finiteNumber(row.signalClose) ?? 0,
    signalVwap: finiteNumber(row.signalVwap) ?? 0,
    entryBid: finiteNumber(row.entryBid),
    entryAsk: finiteNumber(row.entryAsk),
    entrySpread: finiteNumber(row.entrySpread),
    books,
    loggedAt,
  };
}

function parseDecisions(value: unknown): Record<AvwapSignalBookId, AvwapBookDecision> | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const ids: AvwapSignalBookId[] = ["main", "skip-monday", "skip-before-945"];
  const books = {} as Record<AvwapSignalBookId, AvwapBookDecision>;
  for (let i = 0; i < ids.length; i++) {
    const decision = parseDecision(row[ids[i]]);
    if (!decision) return null;
    books[ids[i]] = decision;
  }
  return books;
}

function parseDecision(value: unknown): AvwapBookDecision | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.action !== "taken" && row.action !== "skipped") return null;
  if (typeof row.reason !== "string") return null;
  return { action: row.action, reason: row.reason };
}

function isBookId(value: unknown): value is AvwapShadowBookId {
  return value === "skip-monday" || value === "skip-before-945";
}

function isSymbol(value: unknown): value is AvwapSymbol {
  return typeof value === "string" && (AVWAP_SYMBOLS as readonly string[]).includes(value);
}

function isWeekday(value: unknown): value is NyWeekday {
  return typeof value === "string" && (WEEKDAYS as readonly string[]).includes(value);
}
