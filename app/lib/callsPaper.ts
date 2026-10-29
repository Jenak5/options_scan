import type { CandleBar } from "@/app/lib/candleTypes";
import { calendarDaysBetween, newYorkDate } from "@/app/lib/flow";
import { nyMinutes } from "@/app/lib/featureBackfill";
import {
  chicagoDate,
  isChicagoMarketHours,
  isMarketDay,
  isNyseHoliday,
} from "@/app/lib/marketHours";
import { schwabOptionSymbol } from "@/app/lib/optionSymbol";
import {
  atmStrike,
  AVWAP_BAR_MS,
  expiryCandidates,
  fiveMinuteBars,
  timeStopDue,
} from "@/app/lib/avwapPaper";

/**
 * Paper-only flush-then-reclaim calls.
 * Reads nothing and places nothing. The scan runner supplies price history
 * and option quotes. No order, account, or transaction call lives here.
 *
 * Signal from the Oct 2026 call and spread backtests (RESULTS): during
 * regular hours, price trades at least 0.5% below today's open, then the
 * first 5-minute close back above the prior day's close. One signal per
 * symbol per day. Checks run from 9:45 through 3:25 PM ET (12:25 PM ET on
 * an early close).
 *
 * Setup A buys the ~0.30-delta call, 3–5 calendar days out, at the ask.
 * Setup S buys the at-the-money call at the ask and sells the call five
 * listed strikes higher at the bid. Both size whole contracts so the debit
 * is $875 or less. Fees are $0.65 per contract per side per leg.
 */

export const CALLS_SYMBOLS = ["SPY", "IWM", "QQQ"] as const;
export type CallsSymbol = (typeof CALLS_SYMBOLS)[number];
export type CallsSetupId = "A" | "S";

/** Inclusive. A drop of exactly 0.5% below the open is a flush. */
export const CALLS_FLUSH_FRACTION = 0.005;
export const CALLS_FEE_PER_SIDE = 0.65;
export const CALLS_BUDGET_DOLLARS = 875;
export const CALLS_DTE_MIN = 3;
export const CALLS_DTE_MAX = 5;
export const CALLS_DTE_TARGET = 4;
export const CALLS_DELTA_TARGET = 0.3;
export const CALLS_DELTA_BAND = 0.1;
export const CALLS_SPREAD_STEPS = 5;
/** A bid/ask wider than this fraction of the ask is skipped. Exactly 25% is kept. */
export const CALLS_MAX_SPREAD_FRACTION = 0.25;
export const CALLS_LONG_TARGET_FRACTION = 1;
export const CALLS_SPREAD_TARGET_FRACTION = 0.25;
export const CALLS_SPREAD_STOP_FRACTION = 0.5;
/** Next trading day's final scan. The entry day does not count. */
export const CALLS_TIME_STOP_DAYS = 1;
export const CALLS_DRAWDOWN_FLAG_DOLLARS = 1_500;
export const CALLS_DAILY_STOP_LOSSES = 2;
/** The reclaim bar can still be filled on this scan or the next 5-minute scan. */
export const CALLS_SIGNAL_FRESH_MS = 10 * 60_000;
export const CALLS_ROW_CAP = 1_500;
/** Strikes above and below the money. Wide enough to reach ~0.30 delta and five strikes up. */
export const CALLS_CHAIN_STRIKE_COUNT = 40;

const CHECK_START = 9 * 60 + 45;
const CHECK_END = 15 * 60 + 25;
const EARLY_CHECK_END = 12 * 60 + 25;

/** NYSE early closes. Cash session ends at 1:00 PM ET. Same dates as the other paper scans. */
const EARLY_CLOSE_ET = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

export const CALLS_PAPER_NOTE =
  `Paper only. No order is placed. Symbols are SPY, IWM, and QQQ. During regular hours, a flush is a trade at least ${CALLS_FLUSH_FRACTION * 100}% below today's open. The signal is the first 5-minute close after that flush back above the prior day's close, from 9:45 to 3:25 PM ET (12:25 PM ET on an early close). One signal per symbol per day. Setup A buys the call nearest 0.30 delta (within ${CALLS_DELTA_BAND.toFixed(2)}) whose expiry is nearest ${CALLS_DTE_TARGET} calendar days and inside ${CALLS_DTE_MIN}–${CALLS_DTE_MAX}, at the ask, in whole contracts whose debit is $${CALLS_BUDGET_DOLLARS} or less. Setup S buys the at-the-money call at the ask and sells the call ${CALLS_SPREAD_STEPS} listed strikes higher at the bid, same expiry window, whole spreads whose net debit is $${CALLS_BUDGET_DOLLARS} or less. A bid/ask wider than ${CALLS_MAX_SPREAD_FRACTION * 100}% of the ask is skipped. One open paper position per setup per symbol. Setup A sells at the bid at +100% or on the next trading day's final scan. Setup S closes at +25% of the debit, -50% of the debit, or that same scan, selling the long at the bid and buying the short at the ask. Fees are $${CALLS_FEE_PER_SIDE.toFixed(2)} per contract per side per leg. Two losing closes of one setup in a row block new entries of that setup for the rest of the Chicago day. Cumulative paper drawdown over $${CALLS_DRAWDOWN_FLAG_DOLLARS.toLocaleString("en-US")} is flagged per setup and does not block entries.`;

export function isCallsSymbol(value: string): value is CallsSymbol {
  return value === "SPY" || value === "IWM" || value === "QQQ";
}

export function isCallsSetup(value: string): value is CallsSetupId {
  return value === "A" || value === "S";
}

/** Weekday session inside America/Chicago 8:30–15:00, and not a full-day NYSE holiday. */
export function callsSessionOpen(now: Date): boolean {
  return isMarketDay(now) && isChicagoMarketHours(now);
}

export function callsSkipReason(now: Date): "holiday" | "closed" | null {
  if (!isMarketDay(now)) return isNyseHoliday(now) ? "holiday" : "closed";
  if (!isChicagoMarketHours(now)) return "closed";
  return null;
}

export interface CallsDailyBar {
  date?: string;
  t?: number;
  open: number;
  close: number;
}

/** True when the low is at least `fraction` below the open. An exact 0.5% counts. */
export function tradedBelowOpen(low: number, open: number, fraction: number = CALLS_FLUSH_FRACTION): boolean {
  if (!(low > 0) || !(open > 0) || !Number.isFinite(low) || !Number.isFinite(open)) return false;
  if (!(fraction > 0) || !Number.isFinite(fraction)) return false;
  return (open - low) / open >= fraction - 1e-9;
}

/** Strictly above the prior close. A close equal to the prior close is not a reclaim. */
export function reclaimedPriorClose(close: number, priorClose: number): boolean {
  if (!(close > 0) || !(priorClose > 0) || !Number.isFinite(close) || !Number.isFinite(priorClose)) return false;
  return close > priorClose;
}

export interface SessionLevels {
  open: number;
  priorClose: number;
}

/**
 * Today's regular-session open and the prior session's close.
 * The daily bar's open is used when that session is in the history.
 * Otherwise the first completed regular-hours 5-minute bar supplies the open.
 */
export function sessionLevels(
  daily: readonly CallsDailyBar[],
  bars: readonly CandleBar[],
  today: string,
  nowMs: number,
): SessionLevels | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(nowMs)) return null;
  const days = normalizeDaily(daily);
  let prior: number | null = null;
  let open: number | null = null;
  for (let i = 0; i < days.length; i++) {
    if (days[i].date < today) prior = days[i].close;
    else if (days[i].date === today) {
      open = days[i].open;
      break;
    }
  }
  if (open == null) {
    const session = fiveMinuteBars(bars, nowMs).filter((bar) => newYorkDate(new Date(bar.t)) === today);
    if (session.length > 0 && session[0].o > 0) open = session[0].o;
  }
  if (open == null || prior == null || !(open > 0) || !(prior > 0)) return null;
  return { open, priorClose: prior };
}

export interface FlushReclaimSignal {
  /** Start of the 5-minute bar that closed back above the prior close. */
  at: number;
  close: number;
  /** Low of the bar that first traded at least 0.5% below the open. */
  flushLow: number;
  flushAt: number;
  sessionOpen: number;
  priorClose: number;
}

export interface FlushScan {
  signal: FlushReclaimSignal | null;
  flushed: boolean;
  /** The first reclaim finished outside 9:45–3:25 ET, so the day has no signal. */
  reclaimOutsideWindow: boolean;
}

/**
 * First regular-hours 5-minute close above the prior close after price has
 * traded at least 0.5% below today's open. A later close does not replace it.
 * The reclaim bar's close must land from 9:45 through 3:25 PM ET. On an early
 * close the window ends at 12:25 PM ET. A first reclaim outside that window
 * is not a signal, and no later bar becomes one.
 */
export function scanFlushReclaim(
  bars: readonly CandleBar[],
  sessionOpen: number,
  priorClose: number,
  today: string,
  nowMs: number,
): FlushScan {
  const empty: FlushScan = { signal: null, flushed: false, reclaimOutsideWindow: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(nowMs)) return empty;
  if (!(sessionOpen > 0) || !(priorClose > 0)) return empty;
  const session = fiveMinuteBars(bars, nowMs).filter((bar) => newYorkDate(new Date(bar.t)) === today);
  let flushed = false;
  let flushLow = 0;
  let flushAt = 0;
  for (let i = 0; i < session.length; i++) {
    const bar = session[i];
    if (!flushed && tradedBelowOpen(bar.l, sessionOpen)) {
      flushed = true;
      flushLow = bar.l;
      flushAt = bar.t;
    }
    if (!flushed || !reclaimedPriorClose(bar.c, priorClose)) continue;
    if (!inCheckWindow(bar.t, today)) {
      return { signal: null, flushed: true, reclaimOutsideWindow: true };
    }
    return {
      signal: {
        at: bar.t,
        close: bar.c,
        flushLow,
        flushAt,
        sessionOpen,
        priorClose,
      },
      flushed: true,
      reclaimOutsideWindow: false,
    };
  }
  return { signal: null, flushed, reclaimOutsideWindow: false };
}

/** True when the reclaim bar has finished and is still inside the scan window. */
export function signalIsFresh(signal: FlushReclaimSignal, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const done = signal.at + AVWAP_BAR_MS;
  return nowMs >= done && nowMs - done <= CALLS_SIGNAL_FRESH_MS;
}

/**
 * Whole contracts whose ask × 100 × contracts is within the debit cap.
 * 0 means one contract costs more than the cap. Null means the ask cannot be sized.
 */
export function callsContractCount(ask: number, budget: number = CALLS_BUDGET_DOLLARS): number | null {
  if (!(ask > 0) || !Number.isFinite(ask) || !(budget > 0) || !Number.isFinite(budget)) return null;
  const cost = ask * 100;
  if (!(cost > 0) || !Number.isFinite(cost)) return null;
  const fit = Math.floor((budget + 1e-6) / cost);
  if (!Number.isInteger(fit) || fit < 1) return 0;
  return fit * cost <= budget + 1e-6 ? fit : 0;
}

/**
 * Whole spreads whose net debit (long ask − short bid) × 100 is within the cap.
 * 0 means one spread costs more than the cap. Null means there is no debit to size.
 */
export function callsSpreadCount(longAsk: number, shortBid: number, budget: number = CALLS_BUDGET_DOLLARS): number | null {
  if (!(longAsk > 0) || !(shortBid >= 0) || !Number.isFinite(longAsk) || !Number.isFinite(shortBid)) return null;
  if (!(budget > 0) || !Number.isFinite(budget)) return null;
  const debit = longAsk - shortBid;
  if (!(debit > 0) || !Number.isFinite(debit)) return null;
  const cost = debit * 100;
  const fit = Math.floor((budget + 1e-6) / cost);
  if (!Number.isInteger(fit) || fit < 1) return 0;
  return fit * cost <= budget + 1e-6 ? fit : 0;
}

/** (exit bid − entry ask) × 100 × contracts, minus $0.65 per contract per side. One leg. */
export function longCallPnl(entryAsk: number, exitBid: number, contracts: number): number | null {
  if (!(entryAsk > 0) || !(exitBid >= 0) || !Number.isFinite(entryAsk) || !Number.isFinite(exitBid)) return null;
  if (!Number.isInteger(contracts) || contracts < 1) return null;
  const gross = (exitBid - entryAsk) * 100 * contracts;
  const fees = CALLS_FEE_PER_SIDE * 2 * contracts;
  const pnl = gross - fees;
  return Number.isFinite(pnl) ? roundCents(pnl) : null;
}

/**
 * Spread P&L. Entry debit and exit credit are per-share prices.
 * Exit credit is long bid minus short ask. Fees are $0.65 per contract per side on both legs.
 */
export function spreadPnl(entryDebit: number, exitCredit: number, contracts: number): number | null {
  if (!(entryDebit > 0) || !Number.isFinite(entryDebit) || !Number.isFinite(exitCredit)) return null;
  if (!Number.isInteger(contracts) || contracts < 1) return null;
  const gross = (exitCredit - entryDebit) * 100 * contracts;
  const fees = CALLS_FEE_PER_SIDE * 4 * contracts;
  const pnl = gross - fees;
  return Number.isFinite(pnl) ? roundCents(pnl) : null;
}

/** True when the quote is unusable or the bid/ask is wider than 25% of the ask. */
export function quoteSpreadTooWide(bid: number, ask: number, fraction: number = CALLS_MAX_SPREAD_FRACTION): boolean {
  if (!(ask > 0) || !(bid >= 0) || !Number.isFinite(bid) || !Number.isFinite(ask) || ask + 1e-9 < bid) return true;
  if (!(fraction > 0) || !Number.isFinite(fraction)) return true;
  return (ask - bid) / ask > fraction + 1e-9;
}

export function deltaNearTarget(delta: number | null, target: number = CALLS_DELTA_TARGET, band: number = CALLS_DELTA_BAND): boolean {
  if (delta == null || !Number.isFinite(delta) || !(delta > 0) || delta >= 1) return false;
  if (!Number.isFinite(target) || !Number.isFinite(band) || band < 0) return false;
  return Math.abs(delta - target) <= band + 1e-9;
}

export interface CallsContractQuote {
  expiration: string;
  strike: number;
  bid: number;
  ask: number;
  delta: number | null;
}

export interface LongPick {
  quote: CallsContractQuote | null;
  contracts: number;
  reason: string;
}

export interface SpreadPick {
  long: CallsContractQuote | null;
  short: CallsContractQuote | null;
  contracts: number;
  debit: number | null;
  reason: string;
}

/**
 * Call nearest 0.30 delta inside the 3–5 day window, after dropping quotes
 * wider than 25% of the ask. The preferred expiry is nearest 4 calendar days.
 * One contract over $875 skips the trade.
 */
export function selectLongCall(quotes: readonly CallsContractQuote[], today: string): LongPick {
  const order = expiryCandidates(today, CALLS_DTE_MIN, CALLS_DTE_MAX, CALLS_DTE_TARGET);
  if (order.length === 0) return { quote: null, contracts: 0, reason: "no expiry in the 3–5 day window" };
  let sawBand = false;
  let sawWide = false;
  for (let i = 0; i < order.length; i++) {
    const band = quotesAt(quotes, order[i])
      .filter((quote) => deltaNearTarget(quote.delta))
      .sort((a, b) => Math.abs((a.delta ?? 0) - CALLS_DELTA_TARGET) - Math.abs((b.delta ?? 0) - CALLS_DELTA_TARGET) || a.strike - b.strike);
    if (band.length === 0) continue;
    sawBand = true;
    const liquid = band.filter((quote) => !quoteSpreadTooWide(quote.bid, quote.ask));
    if (liquid.length === 0) {
      sawWide = true;
      continue;
    }
    const best = liquid[0];
    const contracts = callsContractCount(best.ask);
    if (contracts == null) continue;
    if (contracts < 1) return { quote: best, contracts: 0, reason: "one contract costs more than $875" };
    return { quote: best, contracts, reason: "ok" };
  }
  if (sawWide) return { quote: null, contracts: 0, reason: "bid/ask wider than 25%" };
  if (!sawBand) return { quote: null, contracts: 0, reason: "no call within 0.10 of 0.30 delta in the 3–5 day window" };
  return { quote: null, contracts: 0, reason: "no call within 0.10 of 0.30 delta in the 3–5 day window" };
}

/**
 * At-the-money call and the call five listed strikes higher, same 3–5 day window.
 * Listed strikes come from the quotes. A missing strike is not filled with a $1 guess.
 */
export function selectBullCallSpread(quotes: readonly CallsContractQuote[], today: string, spot: number): SpreadPick {
  const none: SpreadPick = { long: null, short: null, contracts: 0, debit: null, reason: "no expiry in the 3–5 day window" };
  const order = expiryCandidates(today, CALLS_DTE_MIN, CALLS_DTE_MAX, CALLS_DTE_TARGET);
  if (order.length === 0) return none;
  const strike = atmStrike(spot);
  if (strike == null) return { ...none, reason: "no underlying price for the at-the-money strike" };
  let firstReason: string | null = null;
  for (let i = 0; i < order.length; i++) {
    const attempt = spreadAtExpiry(quotes, order[i], strike);
    if (attempt.reason === "ok" && attempt.long && attempt.short) return attempt;
    if (attempt.reason === "one spread costs more than $875") return attempt;
    if (!firstReason) firstReason = attempt.reason;
  }
  return { ...none, reason: firstReason ?? none.reason };
}

export type CallsExitReason = "target100" | "target25" | "stop50" | "nextDay";

export interface CallsLeg {
  side: "long" | "short";
  strike: number;
  expiration: string;
  delta: number | null;
  entryBid: number;
  entryAsk: number;
  exitBid: number | null;
  exitAsk: number | null;
  lastBid: number | null;
  lastAsk: number | null;
}

export interface CallsPaperTrade {
  id: string;
  setup: CallsSetupId;
  symbol: CallsSymbol;
  openedAt: number;
  signalAt: number;
  signalDay: string;
  sessionOpen: number;
  priorClose: number;
  flushLow: number;
  signalClose: number;
  spot: number;
  expiration: string;
  dte: number;
  contracts: number;
  /** Per-share debit. Setup A is the ask. Setup S is long ask minus short bid. */
  entryDebit: number;
  legs: CallsLeg[];
  status: "open" | "closed";
  closedAt: number | null;
  exitReason: CallsExitReason | null;
  exitNote: string | null;
  pnlDollars: number | null;
  lastQuoteAt: number | null;
}

export interface CallsPaperBook {
  version: 1;
  trades: CallsPaperTrade[];
  notes: Partial<Record<CallsSymbol, string>>;
  updatedAt: number | null;
}

export interface CallsMarket {
  symbol: CallsSymbol;
  daily: readonly CallsDailyBar[];
  bars: readonly CandleBar[];
}

export interface CallsSnapshot extends CallsMarket {
  quotes: readonly CallsContractQuote[];
  /** Set when this scan asked for a chain and did not get one. */
  chainProblem: "delayed" | "unavailable" | null;
}

export interface CallsQuoteRequest {
  occ: string;
  symbol: CallsSymbol;
  expiration: string;
  strike: number;
}

export interface CallsQuotePlan {
  chainSymbols: CallsSymbol[];
  marks: CallsQuoteRequest[];
}

export function emptyCallsPaperBook(): CallsPaperBook {
  return { version: 1, trades: [], notes: {}, updatedAt: null };
}

export function serializeCallsPaperBook(book: CallsPaperBook): string {
  return JSON.stringify({
    version: 1,
    trades: book.trades,
    notes: book.notes,
    updatedAt: book.updatedAt,
  });
}

export function parseCallsPaperBook(text: string | null | undefined): CallsPaperBook {
  if (!text) return emptyCallsPaperBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyCallsPaperBook();
  }
  const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  if (!row || !Array.isArray(row.trades)) return emptyCallsPaperBook();
  const trades: CallsPaperTrade[] = [];
  for (let i = 0; i < row.trades.length; i++) {
    const trade = parseTrade(row.trades[i]);
    if (trade) trades.push(trade);
  }
  return {
    version: 1,
    trades: trimTrades(trades),
    notes: parseNotes(row.notes),
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : null,
  };
}

export interface CallsAdvanceResult {
  book: CallsPaperBook;
  opened: CallsPaperTrade[];
  closed: CallsPaperTrade[];
}

/**
 * Mark open paper calls and, when the fresh reclaim is still this scan, open
 * one position per setup. A holiday or a closed session returns the book unchanged.
 */
export function advanceCallsPaper(
  book: CallsPaperBook,
  snapshots: readonly CallsSnapshot[],
  now: Date,
): CallsAdvanceResult {
  if (!callsSessionOpen(now)) return { book, opened: [], closed: [] };
  const nowMs = now.getTime();
  const today = newYorkDate(now);
  const bySymbol = new Map<CallsSymbol, CallsSnapshot>();
  for (let i = 0; i < snapshots.length; i++) bySymbol.set(snapshots[i].symbol, snapshots[i]);
  let trades = book.trades.map(cloneTrade);
  const closed: CallsPaperTrade[] = [];

  for (let i = 0; i < CALLS_SYMBOLS.length; i++) {
    const symbol = CALLS_SYMBOLS[i];
    const snap = bySymbol.get(symbol) ?? null;
    trades = trades.map((trade) => {
      if (trade.symbol !== symbol || trade.status !== "open") return trade;
      const next = markTrade(trade, snap?.quotes ?? [], now);
      if (next.status === "closed") closed.push(next);
      return next;
    });
  }

  const opened: CallsPaperTrade[] = [];
  const notes: Partial<Record<CallsSymbol, string>> = {};
  for (let i = 0; i < CALLS_SYMBOLS.length; i++) {
    const symbol = CALLS_SYMBOLS[i];
    const decision = entryDecision(trades, bySymbol.get(symbol) ?? null, symbol, today, nowMs, now);
    notes[symbol] = decision.note;
    for (let n = 0; n < decision.trades.length; n++) {
      trades.push(decision.trades[n]);
      opened.push(decision.trades[n]);
    }
  }

  return {
    book: {
      version: 1,
      trades: trimTrades(trades),
      notes,
      updatedAt: nowMs,
    },
    opened,
    closed,
  };
}

/** Chains to read for a fresh signal, and option symbols to quote for open legs. */
export function callsQuotePlan(book: CallsPaperBook, markets: readonly CallsMarket[], now: Date): CallsQuotePlan {
  const empty: CallsQuotePlan = { chainSymbols: [], marks: [] };
  if (!callsSessionOpen(now)) return empty;
  const nowMs = now.getTime();
  const today = newYorkDate(now);
  const marks: CallsQuoteRequest[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < book.trades.length; i++) {
    const trade = book.trades[i];
    if (trade.status !== "open") continue;
    for (let n = 0; n < trade.legs.length; n++) {
      const leg = trade.legs[n];
      const occ = schwabOptionSymbol({ ticker: trade.symbol, expiration: leg.expiration, strike: leg.strike, putCall: "call" });
      if (!occ || seen.has(occ)) continue;
      seen.add(occ);
      marks.push({ occ, symbol: trade.symbol, expiration: leg.expiration, strike: leg.strike });
    }
  }

  const chainSymbols: CallsSymbol[] = [];
  const bySymbol = new Map<CallsSymbol, CallsMarket>();
  for (let i = 0; i < markets.length; i++) bySymbol.set(markets[i].symbol, markets[i]);
  for (let i = 0; i < CALLS_SYMBOLS.length; i++) {
    const symbol = CALLS_SYMBOLS[i];
    const market = bySymbol.get(symbol);
    if (!market) continue;
    const levels = sessionLevels(market.daily, market.bars, today, nowMs);
    if (!levels) continue;
    const scan = scanFlushReclaim(market.bars, levels.open, levels.priorClose, today, nowMs);
    if (!scan.signal || !signalIsFresh(scan.signal, nowMs)) continue;
    const needA = setupCanEnter(book.trades, "A", symbol, today, now);
    const needS = setupCanEnter(book.trades, "S", symbol, today, now);
    if (needA || needS) chainSymbols.push(symbol);
  }
  return { chainSymbols, marks };
}

export interface CallsDailyStop {
  tradingDay: string;
  consecutiveLosses: number;
  dailyStop: boolean;
}

/** Two losing closes of this setup in a row on this Chicago day block that setup. A later win does not clear it. */
export function callsDailyStop(trades: readonly CallsPaperTrade[], setup: CallsSetupId, now: Date): CallsDailyStop {
  const tradingDay = chicagoDate(now);
  const closed = trades.filter((trade) => {
    if (trade.setup !== setup || trade.status !== "closed" || trade.closedAt == null || trade.pnlDollars == null) return false;
    return chicagoDate(new Date(trade.closedAt)) === tradingDay;
  });
  closed.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.id.localeCompare(b.id));
  let streak = 0;
  let maxStreak = 0;
  for (let i = 0; i < closed.length; i++) {
    const pnl = closed[i].pnlDollars ?? 0;
    if (pnl < 0) {
      streak += 1;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      streak = 0;
    }
  }
  const dailyStop = maxStreak >= CALLS_DAILY_STOP_LOSSES;
  return {
    tradingDay,
    consecutiveLosses: dailyStop ? maxStreak : streak,
    dailyStop,
  };
}

export interface CallsDrawdown {
  cumulativePnlDollars: number;
  peakPnlDollars: number;
  maxDrawdownDollars: number;
  currentDrawdownDollars: number;
  openUnrealizedDollars: number;
  flagged: boolean;
}

/** Peak-to-trough of one setup. An open mark uses the current bid and charges every fee, as if closed now. */
export function callsDrawdown(trades: readonly CallsPaperTrade[], setup: CallsSetupId): CallsDrawdown {
  const closed = trades.filter((trade) => trade.setup === setup && trade.status === "closed" && trade.pnlDollars != null && trade.closedAt != null);
  closed.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.id.localeCompare(b.id));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (let i = 0; i < closed.length; i++) {
    equity += closed[i].pnlDollars ?? 0;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  let openUnrealized = 0;
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.setup !== setup || trade.status !== "open") continue;
    const pnl = unrealizedPnl(trade);
    if (pnl != null) openUnrealized += pnl;
  }
  const marked = equity + openUnrealized;
  const markedPeak = Math.max(peak, marked);
  const currentDrawdown = markedPeak - marked;
  const worst = Math.max(maxDrawdown, currentDrawdown);
  return {
    cumulativePnlDollars: roundCents(equity),
    peakPnlDollars: roundCents(peak),
    maxDrawdownDollars: roundCents(maxDrawdown),
    currentDrawdownDollars: roundCents(currentDrawdown),
    openUnrealizedDollars: roundCents(openUnrealized),
    flagged: worst > CALLS_DRAWDOWN_FLAG_DOLLARS + 1e-6,
  };
}

export interface CallsSetupHealth {
  open: number;
  closed: number;
  cumulativePnlDollars: number;
  maxDrawdownDollars: number;
  currentDrawdownDollars: number;
  openUnrealizedDollars: number;
  drawdownFlag: boolean;
  dailyStop: boolean;
  todayLossStreak: number;
}

export interface CallsPaperHealth {
  paperOnly: true;
  lastCheckAt: string | null;
  drawdownFlag: boolean;
  dailyStop: boolean;
  setups: { A: CallsSetupHealth; S: CallsSetupHealth };
}

export function emptyCallsSetupHealth(): CallsSetupHealth {
  return {
    open: 0,
    closed: 0,
    cumulativePnlDollars: 0,
    maxDrawdownDollars: 0,
    currentDrawdownDollars: 0,
    openUnrealizedDollars: 0,
    drawdownFlag: false,
    dailyStop: false,
    todayLossStreak: 0,
  };
}

export function emptyCallsPaperHealth(): CallsPaperHealth {
  return {
    paperOnly: true,
    lastCheckAt: null,
    drawdownFlag: false,
    dailyStop: false,
    setups: { A: emptyCallsSetupHealth(), S: emptyCallsSetupHealth() },
  };
}

export function callsPaperHealth(book: CallsPaperBook, now: Date): CallsPaperHealth {
  const a = setupHealth(book.trades, "A", now);
  const s = setupHealth(book.trades, "S", now);
  return {
    paperOnly: true,
    lastCheckAt: book.updatedAt == null ? null : new Date(book.updatedAt).toISOString(),
    drawdownFlag: a.drawdownFlag || s.drawdownFlag,
    dailyStop: a.dailyStop || s.dailyStop,
    setups: { A: a, S: s },
  };
}

export interface CallsBriefLeg {
  side: "long" | "short";
  strike: number;
  entryBid: number;
  entryAsk: number;
  exitBid: number | null;
  exitAsk: number | null;
  lastBid: number | null;
  lastAsk: number | null;
}

export interface CallsBriefRow {
  setup: CallsSetupId;
  symbol: CallsSymbol;
  contracts: number;
  expiration: string;
  status: "open" | "closed";
  entryDebit: number;
  debitDollars: number;
  legs: CallsBriefLeg[];
  pnlDollars: number | null;
  unrealizedPnlDollars: number | null;
  exitReason: CallsExitReason | null;
  openedAt: string;
  closedAt: string | null;
}

export interface CallsPaperBrief extends CallsPaperHealth {
  label: "Calls Paper";
  note: string;
  openRows: CallsBriefRow[];
  closedToday: CallsBriefRow[];
}

export function callsPaperBrief(book: CallsPaperBook, now: Date): CallsPaperBrief {
  const health = callsPaperHealth(book, now);
  const day = chicagoDate(now);
  const openRows = book.trades.filter((trade) => trade.status === "open").map(briefRow);
  const closedToday = book.trades.filter((trade) => {
    if (trade.status !== "closed" || trade.closedAt == null) return false;
    return chicagoDate(new Date(trade.closedAt)) === day;
  }).map(briefRow);
  openRows.sort((a, b) => b.openedAt.localeCompare(a.openedAt) || a.setup.localeCompare(b.setup));
  closedToday.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "") || a.setup.localeCompare(b.setup));
  return {
    ...health,
    label: "Calls Paper",
    note: CALLS_PAPER_NOTE,
    openRows,
    closedToday,
  };
}

export interface CallsRunningPoint {
  at: number;
  id: string;
  setup: CallsSetupId;
  symbol: CallsSymbol;
  pnlDollars: number;
  runningPnlDollars: number;
}

export interface CallsViewTrade extends CallsPaperTrade {
  unrealizedPnlDollars: number | null;
  debitDollars: number;
  runningPnlDollars: number | null;
}

export interface CallsPaperSection {
  label: "Calls Paper";
  note: string;
  paperOnly: true;
  stored: boolean;
  symbols: readonly CallsSymbol[];
  budgetDollars: number;
  feePerSide: number;
  drawdownFlagDollars: number;
  flushFraction: number;
  health: CallsPaperHealth;
  notes: Partial<Record<CallsSymbol, string>>;
  updatedAt: number | null;
  open: CallsViewTrade[];
  closed: CallsViewTrade[];
}

export function callsPaperSection(book: CallsPaperBook, now: Date, stored: boolean): CallsPaperSection {
  const running = new Map<string, number>();
  for (const setup of ["A", "S"] as const) {
    const points = runningPoints(book.trades, setup);
    for (let i = 0; i < points.length; i++) running.set(points[i].id, points[i].runningPnlDollars);
  }
  const views = book.trades.map((trade) => viewTrade(trade, running.get(trade.id) ?? null));
  const open = views.filter((trade) => trade.status === "open").sort((a, b) => b.openedAt - a.openedAt || a.setup.localeCompare(b.setup));
  const closed = views.filter((trade) => trade.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0) || a.setup.localeCompare(b.setup));
  return {
    label: "Calls Paper",
    note: CALLS_PAPER_NOTE,
    paperOnly: true,
    stored,
    symbols: CALLS_SYMBOLS,
    budgetDollars: CALLS_BUDGET_DOLLARS,
    feePerSide: CALLS_FEE_PER_SIDE,
    drawdownFlagDollars: CALLS_DRAWDOWN_FLAG_DOLLARS,
    flushFraction: CALLS_FLUSH_FRACTION,
    health: callsPaperHealth(book, now),
    notes: book.notes,
    updatedAt: book.updatedAt,
    open,
    closed,
  };
}

export function formatCallsPaperAlert(trade: CallsPaperTrade): string {
  const long = trade.legs.find((leg) => leg.side === "long") ?? trade.legs[0];
  const short = trade.legs.find((leg) => leg.side === "short") ?? null;
  const debit = trade.entryDebit * 100 * trade.contracts;
  if (trade.setup === "A") {
    const target = trade.entryDebit * (1 + CALLS_LONG_TARGET_FRACTION);
    const delta = long?.delta == null ? "delta unavailable" : `delta ${long.delta.toFixed(2)}`;
    return `<b>PAPER ONLY</b>
${escapeHtml(trade.symbol)} <b>CALL</b> setup A · $${money(long?.strike ?? 0)} exp ${escapeHtml(trade.expiration)}
Paper only. No order is placed.

Flush then reclaim. Open $${money(trade.sessionOpen)}, prior close $${money(trade.priorClose)}. Low $${money(trade.flushLow)} was at least 0.5% below the open. 5-minute close $${money(trade.signalClose)} back above the prior close.
Buy <b>${trade.contracts}</b> ${delta} at the ask $${money(long?.entryAsk ?? trade.entryDebit)} (bid $${money(long?.entryBid ?? 0)}). Debit $${money(debit)}, within the $${CALLS_BUDGET_DOLLARS} cap.
Sell at the bid when the bid is at least $${money(target)} (+100%). Otherwise close on the next trading day's final scan.
Fees $${CALLS_FEE_PER_SIDE.toFixed(2)} per contract per side.`;
  }
  const target = trade.entryDebit * (1 + CALLS_SPREAD_TARGET_FRACTION);
  const stop = trade.entryDebit * (1 - CALLS_SPREAD_STOP_FRACTION);
  return `<b>PAPER ONLY</b>
${escapeHtml(trade.symbol)} <b>BULL CALL SPREAD</b> setup S · exp ${escapeHtml(trade.expiration)}
Paper only. No order is placed.

Flush then reclaim. Open $${money(trade.sessionOpen)}, prior close $${money(trade.priorClose)}. Low $${money(trade.flushLow)} was at least 0.5% below the open. 5-minute close $${money(trade.signalClose)} back above the prior close.
Buy <b>${trade.contracts}</b> $${money(long?.strike ?? 0)} call at the ask $${money(long?.entryAsk ?? 0)} (bid $${money(long?.entryBid ?? 0)}). Sell <b>${trade.contracts}</b> $${money(short?.strike ?? 0)} call at the bid $${money(short?.entryBid ?? 0)} (ask $${money(short?.entryAsk ?? 0)}).
Net debit $${money(trade.entryDebit)} per spread, $${money(debit)} total, within the $${CALLS_BUDGET_DOLLARS} cap.
Exit when the close price (long bid minus short ask) is at least $${money(target)} (+25% of the debit) or at most $${money(stop)} (−50% of the debit). Otherwise close on the next trading day's final scan. Sell the long at the bid and buy the short at the ask.
Fees $${CALLS_FEE_PER_SIDE.toFixed(2)} per contract per side per leg.`;
}

function spreadAtExpiry(quotes: readonly CallsContractQuote[], expiration: string, atm: number): SpreadPick {
  const rows = quotesAt(quotes, expiration);
  const byStrike = new Map<number, CallsContractQuote>();
  for (let i = 0; i < rows.length; i++) {
    const quote = rows[i];
    const key = strikeKey(quote.strike);
    if (!byStrike.has(key)) byStrike.set(key, quote);
  }
  const strikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
  const index = strikeIndex(strikes, atm);
  if (index < 0 || index + CALLS_SPREAD_STEPS >= strikes.length) {
    return { long: null, short: null, contracts: 0, debit: null, reason: "not enough listed strikes above the money" };
  }
  const long = byStrike.get(strikes[index]) ?? null;
  const short = byStrike.get(strikes[index + CALLS_SPREAD_STEPS]) ?? null;
  if (!long || !short) {
    return { long: null, short: null, contracts: 0, debit: null, reason: "not enough listed strikes above the money" };
  }
  if (quoteSpreadTooWide(long.bid, long.ask) || quoteSpreadTooWide(short.bid, short.ask)) {
    return { long, short, contracts: 0, debit: null, reason: "bid/ask wider than 25%" };
  }
  const debit = long.ask - short.bid;
  if (!(debit > 0)) {
    return { long, short, contracts: 0, debit: null, reason: "net debit is not positive" };
  }
  const contracts = callsSpreadCount(long.ask, short.bid);
  if (contracts == null) {
    return { long, short, contracts: 0, debit: null, reason: "net debit is not positive" };
  }
  if (contracts < 1) {
    return { long, short, contracts: 0, debit: roundCents(debit), reason: "one spread costs more than $875" };
  }
  return { long, short, contracts, debit: roundCents(debit), reason: "ok" };
}

function entryDecision(
  trades: readonly CallsPaperTrade[],
  snap: CallsSnapshot | null,
  symbol: CallsSymbol,
  today: string,
  nowMs: number,
  now: Date,
): { trades: CallsPaperTrade[]; note: string } {
  if (!snap) return { trades: [], note: "no bars on this scan" };
  const levels = sessionLevels(snap.daily, snap.bars, today, nowMs);
  if (!levels) return { trades: [], note: "no session open and prior close" };
  const scan = scanFlushReclaim(snap.bars, levels.open, levels.priorClose, today, nowMs);
  if (!scan.flushed) return { trades: [], note: "no flush of at least 0.5% below the open" };
  if (scan.reclaimOutsideWindow) return { trades: [], note: "the first close back above the prior close was outside 9:45–3:25 ET" };
  if (!scan.signal) return { trades: [], note: "flushed; no 5-minute close back above the prior close" };
  if (!signalIsFresh(scan.signal, nowMs)) return { trades: [], note: "the first reclaim is older than this scan" };
  const opened: CallsPaperTrade[] = [];
  const notes: string[] = [];
  for (const setup of ["A", "S"] as const) {
    const decision = openSetup(trades, snap, setup, scan.signal, today, nowMs, now);
    notes.push(`${setup}: ${decision.note}`);
    if (decision.trade) opened.push(decision.trade);
  }
  return { trades: opened, note: notes.join(" ") };
}

function openSetup(
  trades: readonly CallsPaperTrade[],
  snap: CallsSnapshot,
  setup: CallsSetupId,
  signal: FlushReclaimSignal,
  today: string,
  nowMs: number,
  now: Date,
): { trade: CallsPaperTrade | null; note: string } {
  if (hasOpen(trades, setup, snap.symbol)) return { trade: null, note: "one paper position is already open" };
  if (alreadySignaled(trades, setup, snap.symbol, today)) return { trade: null, note: "this signal was already papered" };
  if (callsDailyStop(trades, setup, now).dailyStop) return { trade: null, note: "daily stop: two losing paper closes in a row" };
  if (snap.chainProblem === "delayed") return { trade: null, note: "Schwab option chain was delayed" };
  if (snap.chainProblem === "unavailable") return { trade: null, note: "option chain was not read" };
  if (setup === "A") return openLong(snap, signal, today, nowMs);
  return openSpread(snap, signal, today, nowMs);
}

function openLong(snap: CallsSnapshot, signal: FlushReclaimSignal, today: string, nowMs: number): { trade: CallsPaperTrade | null; note: string } {
  const pick = selectLongCall(snap.quotes, today);
  if (pick.reason !== "ok" || !pick.quote || pick.contracts < 1) return { trade: null, note: pick.reason };
  const dte = calendarDaysBetween(today, pick.quote.expiration);
  if (dte == null || dte < CALLS_DTE_MIN || dte > CALLS_DTE_MAX) return { trade: null, note: "no expiry in the 3–5 day window" };
  const leg = liveLeg("long", pick.quote);
  return {
    trade: baseTrade(snap.symbol, "A", signal, today, nowMs, pick.quote.expiration, dte, pick.contracts, pick.quote.ask, [leg]),
    note: `paper entry, ${pick.contracts} contract${pick.contracts === 1 ? "" : "s"}`,
  };
}

function openSpread(snap: CallsSnapshot, signal: FlushReclaimSignal, today: string, nowMs: number): { trade: CallsPaperTrade | null; note: string } {
  const pick = selectBullCallSpread(snap.quotes, today, signal.close);
  if (pick.reason !== "ok" || !pick.long || !pick.short || pick.contracts < 1 || pick.debit == null) {
    return { trade: null, note: pick.reason };
  }
  const dte = calendarDaysBetween(today, pick.long.expiration);
  if (dte == null || dte < CALLS_DTE_MIN || dte > CALLS_DTE_MAX) return { trade: null, note: "no expiry in the 3–5 day window" };
  const debit = pick.long.ask - pick.short.bid;
  if (!(debit > 0)) return { trade: null, note: "net debit is not positive" };
  return {
    trade: baseTrade(snap.symbol, "S", signal, today, nowMs, pick.long.expiration, dte, pick.contracts, debit, [
      liveLeg("long", pick.long),
      liveLeg("short", pick.short),
    ]),
    note: `paper entry, ${pick.contracts} spread${pick.contracts === 1 ? "" : "s"}`,
  };
}

function baseTrade(
  symbol: CallsSymbol,
  setup: CallsSetupId,
  signal: FlushReclaimSignal,
  today: string,
  nowMs: number,
  expiration: string,
  dte: number,
  contracts: number,
  entryDebit: number,
  legs: CallsLeg[],
): CallsPaperTrade {
  return {
    id: `calls-${setup}-${symbol}-${today}`,
    setup,
    symbol,
    openedAt: nowMs,
    signalAt: signal.at,
    signalDay: today,
    sessionOpen: signal.sessionOpen,
    priorClose: signal.priorClose,
    flushLow: signal.flushLow,
    signalClose: signal.close,
    spot: signal.close,
    expiration,
    dte,
    contracts,
    entryDebit,
    legs,
    status: "open",
    closedAt: null,
    exitReason: null,
    exitNote: null,
    pnlDollars: null,
    lastQuoteAt: nowMs,
  };
}

function liveLeg(side: "long" | "short", quote: CallsContractQuote): CallsLeg {
  return {
    side,
    strike: quote.strike,
    expiration: quote.expiration,
    delta: quote.delta,
    entryBid: quote.bid,
    entryAsk: quote.ask,
    exitBid: null,
    exitAsk: null,
    lastBid: quote.bid,
    lastAsk: quote.ask,
  };
}

function markTrade(trade: CallsPaperTrade, quotes: readonly CallsContractQuote[], now: Date): CallsPaperTrade {
  let quoted = 0;
  const legs = trade.legs.map((leg) => {
    const quote = findQuote(quotes, leg.expiration, leg.strike);
    if (!quote) return leg;
    quoted += 1;
    return { ...leg, lastBid: quote.bid, lastAsk: quote.ask };
  });
  const marked: CallsPaperTrade = quoted > 0 ? { ...trade, legs, lastQuoteAt: now.getTime() } : { ...trade, legs };
  if (quoted !== trade.legs.length || trade.legs.length === 0) return marked;
  if (trade.setup === "A") return markLong(marked, now);
  return markSpread(marked, now);
}

function markLong(trade: CallsPaperTrade, now: Date): CallsPaperTrade {
  const leg = trade.legs[0];
  if (!leg || leg.lastBid == null || leg.lastAsk == null) return trade;
  if (leg.lastBid + 1e-9 >= trade.entryDebit * (1 + CALLS_LONG_TARGET_FRACTION)) {
    return closeTrade(trade, "target100", null, now.getTime());
  }
  if (timeStopDue(trade.openedAt, now, CALLS_TIME_STOP_DAYS)) {
    return closeTrade(trade, "nextDay", null, now.getTime());
  }
  return trade;
}

function markSpread(trade: CallsPaperTrade, now: Date): CallsPaperTrade {
  const long = trade.legs.find((leg) => leg.side === "long");
  const short = trade.legs.find((leg) => leg.side === "short");
  if (!long || !short || long.lastBid == null || short.lastAsk == null) return trade;
  const credit = long.lastBid - short.lastAsk;
  if (credit + 1e-9 >= trade.entryDebit * (1 + CALLS_SPREAD_TARGET_FRACTION)) {
    return closeTrade(trade, "target25", null, now.getTime());
  }
  if (credit <= trade.entryDebit * (1 - CALLS_SPREAD_STOP_FRACTION) + 1e-9) {
    return closeTrade(trade, "stop50", null, now.getTime());
  }
  if (timeStopDue(trade.openedAt, now, CALLS_TIME_STOP_DAYS)) {
    return closeTrade(trade, "nextDay", null, now.getTime());
  }
  return trade;
}

function closeTrade(trade: CallsPaperTrade, reason: CallsExitReason, note: string | null, nowMs: number): CallsPaperTrade {
  const legs = trade.legs.map((leg) => ({
    ...leg,
    exitBid: leg.lastBid,
    exitAsk: leg.lastAsk,
  }));
  const long = legs.find((leg) => leg.side === "long");
  const short = legs.find((leg) => leg.side === "short");
  let pnl: number | null = null;
  if (trade.setup === "A" && long?.exitBid != null) pnl = longCallPnl(trade.entryDebit, long.exitBid, trade.contracts);
  if (trade.setup === "S" && long?.exitBid != null && short?.exitAsk != null) {
    pnl = spreadPnl(trade.entryDebit, long.exitBid - short.exitAsk, trade.contracts);
  }
  return {
    ...trade,
    legs,
    status: "closed",
    closedAt: nowMs,
    exitReason: reason,
    exitNote: note,
    pnlDollars: pnl,
    lastQuoteAt: nowMs,
  };
}

function setupCanEnter(trades: readonly CallsPaperTrade[], setup: CallsSetupId, symbol: CallsSymbol, today: string, now: Date): boolean {
  if (hasOpen(trades, setup, symbol)) return false;
  if (alreadySignaled(trades, setup, symbol, today)) return false;
  if (callsDailyStop(trades, setup, now).dailyStop) return false;
  return true;
}

function hasOpen(trades: readonly CallsPaperTrade[], setup: CallsSetupId, symbol: CallsSymbol): boolean {
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].setup === setup && trades[i].symbol === symbol && trades[i].status === "open") return true;
  }
  return false;
}

function alreadySignaled(trades: readonly CallsPaperTrade[], setup: CallsSetupId, symbol: CallsSymbol, today: string): boolean {
  const id = `calls-${setup}-${symbol}-${today}`;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].id === id) return true;
  }
  return false;
}

function setupHealth(trades: readonly CallsPaperTrade[], setup: CallsSetupId, now: Date): CallsSetupHealth {
  const drawdown = callsDrawdown(trades, setup);
  const stop = callsDailyStop(trades, setup, now);
  let open = 0;
  let closed = 0;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].setup !== setup) continue;
    if (trades[i].status === "open") open += 1;
    else closed += 1;
  }
  return {
    open,
    closed,
    cumulativePnlDollars: drawdown.cumulativePnlDollars,
    maxDrawdownDollars: drawdown.maxDrawdownDollars,
    currentDrawdownDollars: drawdown.currentDrawdownDollars,
    openUnrealizedDollars: drawdown.openUnrealizedDollars,
    drawdownFlag: drawdown.flagged,
    dailyStop: stop.dailyStop,
    todayLossStreak: stop.consecutiveLosses,
  };
}

function unrealizedPnl(trade: CallsPaperTrade): number | null {
  const long = trade.legs.find((leg) => leg.side === "long");
  const short = trade.legs.find((leg) => leg.side === "short");
  if (trade.setup === "A") {
    if (long?.lastBid == null) return null;
    return longCallPnl(trade.entryDebit, long.lastBid, trade.contracts);
  }
  if (long?.lastBid == null || short?.lastAsk == null) return null;
  return spreadPnl(trade.entryDebit, long.lastBid - short.lastAsk, trade.contracts);
}

function runningPoints(trades: readonly CallsPaperTrade[], setup: CallsSetupId): CallsRunningPoint[] {
  const closed = trades.filter((trade) => trade.setup === setup && trade.status === "closed" && trade.pnlDollars != null && trade.closedAt != null);
  closed.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.id.localeCompare(b.id));
  let running = 0;
  const points: CallsRunningPoint[] = [];
  for (let i = 0; i < closed.length; i++) {
    const trade = closed[i];
    running = roundCents(running + (trade.pnlDollars ?? 0));
    points.push({
      at: trade.closedAt ?? 0,
      id: trade.id,
      setup,
      symbol: trade.symbol,
      pnlDollars: trade.pnlDollars ?? 0,
      runningPnlDollars: running,
    });
  }
  return points;
}

function viewTrade(trade: CallsPaperTrade, runningPnl: number | null): CallsViewTrade {
  return {
    ...trade,
    unrealizedPnlDollars: trade.status === "open" ? unrealizedPnl(trade) : null,
    debitDollars: roundCents(trade.entryDebit * 100 * trade.contracts),
    runningPnlDollars: runningPnl,
  };
}

function briefRow(trade: CallsPaperTrade): CallsBriefRow {
  return {
    setup: trade.setup,
    symbol: trade.symbol,
    contracts: trade.contracts,
    expiration: trade.expiration,
    status: trade.status,
    entryDebit: trade.entryDebit,
    debitDollars: roundCents(trade.entryDebit * 100 * trade.contracts),
    legs: trade.legs.map((leg) => ({
      side: leg.side,
      strike: leg.strike,
      entryBid: leg.entryBid,
      entryAsk: leg.entryAsk,
      exitBid: leg.exitBid,
      exitAsk: leg.exitAsk,
      lastBid: leg.lastBid,
      lastAsk: leg.lastAsk,
    })),
    pnlDollars: trade.pnlDollars,
    unrealizedPnlDollars: trade.status === "open" ? unrealizedPnl(trade) : null,
    exitReason: trade.exitReason,
    openedAt: new Date(trade.openedAt).toISOString(),
    closedAt: trade.closedAt == null ? null : new Date(trade.closedAt).toISOString(),
  };
}

function quotesAt(quotes: readonly CallsContractQuote[], expiration: string): CallsContractQuote[] {
  const rows: CallsContractQuote[] = [];
  for (let i = 0; i < quotes.length; i++) {
    const quote = quotes[i];
    if (quote.expiration !== expiration) continue;
    if (!usableQuote(quote)) continue;
    rows.push(quote);
  }
  return rows;
}

function usableQuote(quote: CallsContractQuote): boolean {
  return Number.isFinite(quote.strike)
    && quote.strike > 0
    && Number.isFinite(quote.bid)
    && Number.isFinite(quote.ask)
    && quote.bid >= 0
    && quote.ask > 0
    && quote.ask + 1e-9 >= quote.bid;
}

function findQuote(quotes: readonly CallsContractQuote[], expiration: string, strike: number): CallsContractQuote | null {
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

function strikeIndex(strikes: readonly number[], atm: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const dist = Math.abs(strikes[i] - atm);
    if (dist <= 1e-6) return i;
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && (best < 0 || strikes[i] < strikes[best]))) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function strikeKey(strike: number): number {
  return Math.round(strike * 1000) / 1000;
}

function inCheckWindow(barStart: number, day: string): boolean {
  const minute = nyMinutes(barStart + AVWAP_BAR_MS);
  if (!Number.isFinite(minute)) return false;
  const end = EARLY_CLOSE_ET.has(day) ? EARLY_CHECK_END : CHECK_END;
  return minute >= CHECK_START && minute <= end;
}

function cloneTrade(trade: CallsPaperTrade): CallsPaperTrade {
  return { ...trade, legs: trade.legs.map((leg) => ({ ...leg })) };
}

function trimTrades(trades: CallsPaperTrade[]): CallsPaperTrade[] {
  const active: CallsPaperTrade[] = [];
  const done: CallsPaperTrade[] = [];
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].status === "open") active.push(trades[i]);
    else done.push(trades[i]);
  }
  done.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  const room = Math.max(0, CALLS_ROW_CAP - active.length);
  return active.concat(done.slice(0, room));
}

interface NormalizedDay {
  date: string;
  open: number;
  close: number;
}

function normalizeDaily(days: readonly CallsDailyBar[]): NormalizedDay[] {
  const byDate = new Map<string, NormalizedDay>();
  for (let i = 0; i < days.length; i++) {
    const bar = days[i];
    if (!(bar.open > 0) || !(bar.close > 0) || !Number.isFinite(bar.open) || !Number.isFinite(bar.close)) continue;
    const date = dayOf(bar);
    if (!date) continue;
    byDate.set(date, { date, open: bar.open, close: bar.close });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function dayOf(bar: CallsDailyBar): string | null {
  if (bar.date && /^\d{4}-\d{2}-\d{2}$/.test(bar.date)) return bar.date;
  if (bar.t == null || !Number.isFinite(bar.t)) return null;
  const date = newYorkDate(new Date(bar.t));
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(value: number): string {
  return value.toFixed(2);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseNotes(value: unknown): Partial<Record<CallsSymbol, string>> {
  const notes: Partial<Record<CallsSymbol, string>> = {};
  if (!value || typeof value !== "object") return notes;
  const row = value as Record<string, unknown>;
  for (let i = 0; i < CALLS_SYMBOLS.length; i++) {
    const symbol = CALLS_SYMBOLS[i];
    const note = row[symbol];
    if (typeof note === "string" && note.trim()) notes[symbol] = note.slice(0, 240);
  }
  return notes;
}

function parseTrade(value: unknown): CallsPaperTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const symbol = typeof row.symbol === "string" ? row.symbol : "";
  const setup = typeof row.setup === "string" ? row.setup : "";
  if (!isCallsSymbol(symbol) || !isCallsSetup(setup)) return null;
  const strikeFields = ["sessionOpen", "priorClose", "flushLow", "signalClose", "spot", "entryDebit"] as const;
  const numbers: Record<string, number> = {};
  for (let i = 0; i < strikeFields.length; i++) {
    const key = strikeFields[i];
    const parsed = finiteNumber(row[key]);
    if (parsed == null) return null;
    numbers[key] = parsed;
  }
  const openedAt = finiteNumber(row.openedAt);
  const signalAt = finiteNumber(row.signalAt);
  const contracts = finiteNumber(row.contracts);
  const dte = finiteNumber(row.dte);
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  const signalDay = typeof row.signalDay === "string" ? row.signalDay : "";
  const id = typeof row.id === "string" ? row.id : "";
  if (openedAt == null || signalAt == null || contracts == null || dte == null) return null;
  if (!Number.isInteger(contracts) || contracts < 1) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration) || !/^\d{4}-\d{2}-\d{2}$/.test(signalDay)) return null;
  if (!(numbers.entryDebit > 0) || !id) return null;
  const status = row.status === "closed" ? "closed" : row.status === "open" ? "open" : null;
  if (!status) return null;
  const legs = Array.isArray(row.legs) ? row.legs.map(parseLeg).filter((leg): leg is CallsLeg => leg != null) : [];
  if (setup === "A" && (legs.length !== 1 || legs[0].side !== "long")) return null;
  if (setup === "S" && (legs.length !== 2 || legs[0].side !== "long" || legs[1].side !== "short")) return null;
  if (setup === "S" && !(legs[1].strike > legs[0].strike)) return null;
  const closed = status === "closed";
  const exitReason = closed && isExitReason(row.exitReason) ? row.exitReason : null;
  return {
    id: id.slice(0, 120),
    setup,
    symbol,
    openedAt,
    signalAt,
    signalDay,
    sessionOpen: numbers.sessionOpen,
    priorClose: numbers.priorClose,
    flushLow: numbers.flushLow,
    signalClose: numbers.signalClose,
    spot: numbers.spot,
    expiration,
    dte,
    contracts,
    entryDebit: numbers.entryDebit,
    legs,
    status,
    closedAt: closed ? finiteNumber(row.closedAt) : null,
    exitReason,
    exitNote: typeof row.exitNote === "string" ? row.exitNote.slice(0, 200) : null,
    pnlDollars: closed ? finiteNumber(row.pnlDollars) : null,
    lastQuoteAt: finiteNumber(row.lastQuoteAt),
  };
}

function parseLeg(value: unknown): CallsLeg | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const side = row.side === "long" || row.side === "short" ? row.side : null;
  const strike = finiteNumber(row.strike);
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  const entryBid = finiteNumber(row.entryBid);
  const entryAsk = finiteNumber(row.entryAsk);
  if (!side || strike == null || !(strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  if (entryBid == null || entryAsk == null || entryBid < 0 || !(entryAsk > 0)) return null;
  const delta = finiteNumber(row.delta);
  return {
    side,
    strike,
    expiration,
    delta,
    entryBid,
    entryAsk,
    exitBid: finiteNumber(row.exitBid),
    exitAsk: finiteNumber(row.exitAsk),
    lastBid: finiteNumber(row.lastBid),
    lastAsk: finiteNumber(row.lastAsk),
  };
}

function isExitReason(value: unknown): value is CallsExitReason {
  return value === "target100" || value === "target25" || value === "stop50" || value === "nextDay";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
