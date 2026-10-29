import type { CandleBar } from "@/app/lib/candleTypes";
import { addCalendarDays, calendarDaysBetween, newYorkDate } from "@/app/lib/flow";
import { nyMinutes } from "@/app/lib/featureBackfill";
import {
  chicagoDate,
  chicagoTradingDaysElapsed,
  isChicagoMarketHours,
  isMarketDay,
  isNyseHoliday,
} from "@/app/lib/marketHours";
import { schwabOptionSymbol } from "@/app/lib/optionSymbol";

/**
 * Paper-only gap-day anchored VWAP put.
 * Reads nothing and places nothing. The scan runner supplies price history
 * and option quotes. No order, account, or transaction call lives here.
 *
 * Gap rule from the Oct 2026 backtest (RESULTS): the last session whose open
 * is more than 1% away from the prior close. The fraction is AVWAP_GAP_FRACTION.
 * Anchored VWAP starts at that session's regular-hours open. A signal is the
 * first completed 5-minute regular-hours close below that VWAP after the prior
 * completed close was at or above it. The paper fill is the ask, the exit is
 * the bid, and the debit cap is $875.
 */

export const AVWAP_SYMBOLS = ["SPY", "IWM", "QQQ"] as const;
export type AvwapSymbol = (typeof AVWAP_SYMBOLS)[number];

/** RESULTS.md: "the last gap of more than 1%". A gap equal to 1% is not a gap day. */
export const AVWAP_GAP_FRACTION = 0.01;

export const AVWAP_FEE_PER_SIDE = 0.65;
/** Whole-contract debit cap from the backtest. One contract above this is skipped. */
export const AVWAP_BUDGET_DOLLARS = 875;
export const AVWAP_TARGET_FRACTION = 0.5;
export const AVWAP_WHATIF_TARGET_FRACTION = 0.25;
export const AVWAP_WHATIF_TRADING_DAYS = 3;
export const AVWAP_PRIMARY_DTE_MIN = 5;
export const AVWAP_PRIMARY_DTE_MAX = 10;
export const AVWAP_PRIMARY_DTE_TARGET = 7;
export const AVWAP_ALT_DTE_MIN = 12;
export const AVWAP_ALT_DTE_MAX = 16;
export const AVWAP_ALT_DTE_TARGET = 14;
/** Flag when peak-to-trough paper equity exceeds this. It does not block entries. */
export const AVWAP_DRAWDOWN_FLAG_DOLLARS = 1_500;
export const AVWAP_DAILY_STOP_LOSSES = 2;
export const AVWAP_BAR_MS = 5 * 60_000;
/** The crossing bar can still be filled on this scan or the next 5-minute scan. */
export const AVWAP_SIGNAL_FRESH_MS = 10 * 60_000;
export const AVWAP_ROW_CAP = 1_500;

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const EARLY_CLOSE_MINUTE = 13 * 60;
const FINAL_SCAN_MINUTE = 15 * 60 + 55;
const EARLY_FINAL_SCAN_MINUTE = 12 * 60 + 55;

/** NYSE early closes. Cash session ends at 1:00 PM ET. Same dates as the other paper scans. */
const EARLY_CLOSE_ET = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

export const AVWAP_PAPER_NOTE =
  `Paper only. No order is placed. Symbols are SPY, IWM, and QQQ. A gap day is a session whose open is more than ${AVWAP_GAP_FRACTION * 100}% from the prior close. Anchored VWAP starts at that day's regular-hours open and uses 5-minute bars (1-minute bars are rolled up), typical price (high + low + close) / 3, with volume floored at 1. The signal is the first regular-hours 5-minute close below that VWAP after the prior close was at or above it. The paper trade buys the at-the-money put whose expiry is nearest 7 calendar days and inside 5–10 days, at the ask, in whole contracts whose debit is $${AVWAP_BUDGET_DOLLARS} or less. One contract over $${AVWAP_BUDGET_DOLLARS} is skipped. One open paper position per symbol. Sell at the bid when the bid is at least 50% above the entry ask, otherwise on the expiry-day final scan (3:55 PM ET, or 12:55 PM ET on an early close). What-ifs on the same signal: sell the 7-day put at +25% or after 3 trading days, and the same rule on a put nearest 14 calendar days (12–16). Fees are $${AVWAP_FEE_PER_SIDE.toFixed(2)} per contract per side. Two losing closes in a row block new entries for the rest of that Chicago day. Cumulative paper drawdown over $${AVWAP_DRAWDOWN_FLAG_DOLLARS.toLocaleString("en-US")} is flagged.`;

export function isAvwapSymbol(value: string): value is AvwapSymbol {
  return value === "SPY" || value === "IWM" || value === "QQQ";
}

/** Weekday session inside America/Chicago 8:30–15:00, and not a full-day NYSE holiday. */
export function avwapSessionOpen(now: Date): boolean {
  return isMarketDay(now) && isChicagoMarketHours(now);
}

export function avwapSkipReason(now: Date): "holiday" | "closed" | null {
  if (!isMarketDay(now)) return isNyseHoliday(now) ? "holiday" : "closed";
  if (!isChicagoMarketHours(now)) return "closed";
  return null;
}

export interface GapDay {
  date: string;
  open: number;
  prevClose: number;
  /** open / prior close − 1. Negative is a gap down. */
  gap: number;
}

export interface AvwapDailyBar {
  /** YYYY-MM-DD in America/New_York. Used when set. */
  date?: string;
  t?: number;
  open: number;
  close: number;
}

/** Signed gap. Null when either price is missing. */
export function gapFraction(open: number, prevClose: number): number | null {
  if (!(open > 0) || !(prevClose > 0) || !Number.isFinite(open) || !Number.isFinite(prevClose)) return null;
  const gap = open / prevClose - 1;
  return Number.isFinite(gap) ? gap : null;
}

/**
 * True when |open / prior close − 1| is greater than AVWAP_GAP_FRACTION.
 * A one-cent comparison is far larger than binary noise, so an exact 1% gap stays under the line.
 */
export function isGapSession(open: number, prevClose: number): boolean {
  const gap = gapFraction(open, prevClose);
  return gap != null && exceedsGap(gap);
}

/** Most recent gap day at or before `today`. `today` is a New York date. Null when none. */
export function latestGapDay(days: readonly AvwapDailyBar[], today?: string): GapDay | null {
  const rows = normalizeDaily(days);
  let found: GapDay | null = null;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const day = rows[i];
    if (today && day.date > today) continue;
    const gap = gapFraction(day.open, prev.close);
    if (gap == null || !exceedsGap(gap)) continue;
    found = { date: day.date, open: day.open, prevClose: prev.close, gap };
  }
  return found;
}

export interface AvwapPoint {
  /** 5-minute bucket start, epoch milliseconds. */
  t: number;
  close: number;
  vwap: number;
}

/**
 * Completed regular-hours 5-minute bars from the anchor date through `nowMs`.
 * 1-minute bars in the same bucket are rolled up. A bucket is included once
 * its 5 minutes have elapsed. Premarket and after-hours bars are left out.
 * On an early close, bars from 1:00 PM ET on are left out.
 */
export function fiveMinuteBars(bars: readonly CandleBar[], nowMs: number): CandleBar[] {
  if (!Number.isFinite(nowMs)) return [];
  const ordered = bars.filter(usableBar).slice().sort((a, b) => a.t - b.t);
  const buckets = new Map<number, CandleBar>();
  for (let i = 0; i < ordered.length; i++) {
    const bar = ordered[i];
    const start = bar.t - (bar.t % AVWAP_BAR_MS);
    if (start + AVWAP_BAR_MS > nowMs) continue;
    const day = newYorkDate(new Date(start));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const minutes = nyMinutes(start);
    const end = EARLY_CLOSE_ET.has(day) ? EARLY_CLOSE_MINUTE : RTH_CLOSE;
    if (minutes < RTH_OPEN || minutes >= end) continue;
    const volume = barVolume(bar);
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        t: start,
        o: bar.o > 0 ? bar.o : bar.c,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: volume,
      });
      continue;
    }
    if (bar.h > existing.h) existing.h = bar.h;
    if (bar.l < existing.l) existing.l = bar.l;
    existing.c = bar.c;
    existing.v = (existing.v ?? 0) + volume;
  }
  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

/** Anchored VWAP from the gap day's open through the last completed 5-minute bar. */
export function avwapPoints(bars: readonly CandleBar[], anchorDate: string, nowMs: number): AvwapPoint[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || !Number.isFinite(nowMs)) return [];
  const session = fiveMinuteBars(bars, nowMs).filter((bar) => newYorkDate(new Date(bar.t)) >= anchorDate);
  let weighted = 0;
  let volume = 0;
  const points: AvwapPoint[] = [];
  for (let i = 0; i < session.length; i++) {
    const bar = session[i];
    const typical = (bar.h + bar.l + bar.c) / 3;
    if (!Number.isFinite(typical) || !(typical > 0)) continue;
    const weight = weightOf(bar.v);
    weighted += typical * weight;
    volume += weight;
    if (!(volume > 0) || !(bar.c > 0)) continue;
    points.push({ t: bar.t, close: bar.c, vwap: weighted / volume });
  }
  return points;
}

export interface AvwapSignal {
  /** Start of the 5-minute bar that closed below the anchored VWAP. */
  at: number;
  close: number;
  vwap: number;
  priorClose: number;
  priorVwap: number;
}

/**
 * First completed 5-minute close below the anchored VWAP whose previous
 * completed close was at or above the VWAP at that previous bar.
 * Regular hours only. Later crosses of the same anchor are ignored.
 */
export function firstAvwapReject(bars: readonly CandleBar[], anchorDate: string, nowMs: number): AvwapSignal | null {
  const points = avwapPoints(bars, anchorDate, nowMs);
  for (let i = 1; i < points.length; i++) {
    const prior = points[i - 1];
    const current = points[i];
    if (prior.close >= prior.vwap && current.close < current.vwap) {
      return {
        at: current.t,
        close: current.close,
        vwap: current.vwap,
        priorClose: prior.close,
        priorVwap: prior.vwap,
      };
    }
  }
  return null;
}

/** True when the crossing bar has finished and is still inside the scan window. */
export function signalIsFresh(signal: AvwapSignal, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const done = signal.at + AVWAP_BAR_MS;
  return nowMs >= done && nowMs - done <= AVWAP_SIGNAL_FRESH_MS;
}

/** Nearest dollar. A .5 rounds away from zero via Math.round. */
export function atmStrike(spot: number): number | null {
  if (!(spot > 0) || !Number.isFinite(spot)) return null;
  const strike = Math.round(spot);
  if (!Number.isInteger(strike) || strike < 1 || strike > 99_999) return null;
  return strike;
}

/**
 * Trading-day expirations from `minDte` through `maxDte` calendar days after `today`,
 * nearest `target` first. A tie takes the earlier expiry. Weekends and full-day
 * NYSE holidays are left out. Early closes stay in.
 */
export function expiryCandidates(today: string, minDte: number, maxDte: number, target: number): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  const rows: { ymd: string; dte: number; distance: number }[] = [];
  for (let dte = minDte; dte <= maxDte; dte++) {
    const ymd = addCalendarDays(today, dte);
    if (!isTradingDayYmd(ymd)) continue;
    rows.push({ ymd, dte, distance: Math.abs(dte - target) });
  }
  rows.sort((a, b) => a.distance - b.distance || a.dte - b.dte);
  return rows.map((row) => row.ymd);
}

/**
 * Whole contracts whose ask × 100 × contracts is within the debit cap.
 * 0 means one contract costs more than the cap and the trade is skipped.
 * Null means the ask cannot be sized.
 */
export function avwapContractCount(ask: number, budget: number = AVWAP_BUDGET_DOLLARS): number | null {
  if (!(ask > 0) || !Number.isFinite(ask) || !(budget > 0) || !Number.isFinite(budget)) return null;
  const cost = ask * 100;
  if (!(cost > 0) || !Number.isFinite(cost)) return null;
  const fit = Math.floor((budget + 1e-6) / cost);
  if (!Number.isInteger(fit) || fit < 1) return 0;
  return fit * cost <= budget + 1e-6 ? fit : 0;
}

/** (exit bid − entry ask) × 100 × contracts, minus $0.65 per contract per side. */
export function avwapPnl(entryAsk: number, exitBid: number, contracts: number): number | null {
  if (!(entryAsk > 0) || !(exitBid >= 0) || !Number.isFinite(entryAsk) || !Number.isFinite(exitBid)) return null;
  if (!Number.isInteger(contracts) || contracts < 1) return null;
  const gross = (exitBid - entryAsk) * 100 * contracts;
  const fees = AVWAP_FEE_PER_SIDE * 2 * contracts;
  const pnl = gross - fees;
  return Number.isFinite(pnl) ? roundCents(pnl) : null;
}

export function bidHitsTarget(bid: number, entryAsk: number, fraction: number): boolean {
  if (!(bid >= 0) || !(entryAsk > 0) || !Number.isFinite(bid) || !Number.isFinite(entryAsk)) return false;
  if (!(fraction > 0) || !Number.isFinite(fraction)) return false;
  return bid + 1e-9 >= entryAsk * (1 + fraction);
}

/** 3:55 PM ET, or 12:55 PM ET on an early close. */
export function isSessionFinalScan(now: Date): boolean {
  const day = newYorkDate(now);
  const minutes = nyMinutes(now.getTime());
  if (!day || !Number.isFinite(minutes)) return false;
  const cutoff = EARLY_CLOSE_ET.has(day) ? EARLY_FINAL_SCAN_MINUTE : FINAL_SCAN_MINUTE;
  return minutes >= cutoff;
}

/**
 * Expiry day at the final scan, or any later session when that scan was missed.
 * A date before expiration is false.
 */
export function isExpiryFinalScan(now: Date, expiration: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return false;
  const day = newYorkDate(now);
  if (!day) return false;
  if (day > expiration) return true;
  if (day < expiration) return false;
  return isSessionFinalScan(now);
}

/**
 * True at the final scan of the trading day on which `tradingDays` Chicago
 * trading days have elapsed after the entry date, or on any later scan.
 * The entry date does not count. Weekends and full-day holidays do not count.
 */
export function timeStopDue(openedAt: number, now: Date, tradingDays: number = AVWAP_WHATIF_TRADING_DAYS): boolean {
  if (!Number.isFinite(openedAt)) return false;
  const elapsed = chicagoTradingDaysElapsed(new Date(openedAt), now);
  if (elapsed > tradingDays) return true;
  if (elapsed < tradingDays) return false;
  return isSessionFinalScan(now);
}

export type AvwapExitReason = "target50" | "target25" | "time3" | "expiry";
export type AvwapWhatIfId = "target25-or-3d" | "dte14";

export interface AvwapWhatIf {
  id: AvwapWhatIfId;
  label: string;
  expiration: string;
  strike: number;
  contracts: number;
  entryAsk: number;
  entryBid: number;
  status: "open" | "closed" | "skipped";
  skipReason: string | null;
  closedAt: number | null;
  exitBid: number | null;
  exitAsk: number | null;
  exitReason: AvwapExitReason | null;
  /** Set when the expiry fill had no bid and was marked at 0. */
  exitNote: string | null;
  pnlDollars: number | null;
  lastBid: number | null;
  lastAsk: number | null;
}

export interface AvwapPaperTrade {
  id: string;
  symbol: AvwapSymbol;
  putCall: "put";
  strike: number;
  expiration: string;
  /** Calendar days from the New York entry date to expiration. */
  dte: number;
  contracts: number;
  openedAt: number;
  signalAt: number;
  anchorDate: string;
  /** open / prior close − 1 for the anchor day. */
  gap: number;
  spot: number;
  signalClose: number;
  signalVwap: number;
  entryAsk: number;
  entryBid: number;
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
  whatIfs: AvwapWhatIf[];
}

export interface AvwapPaperBook {
  version: 1;
  trades: AvwapPaperTrade[];
  notes: Partial<Record<AvwapSymbol, string>>;
  updatedAt: number | null;
}

export interface AvwapMark {
  expiration: string;
  strike: number;
  bid: number;
  ask: number;
}

export interface AvwapMarket {
  symbol: AvwapSymbol;
  daily: readonly AvwapDailyBar[];
  bars: readonly CandleBar[];
}

export interface AvwapSnapshot extends AvwapMarket {
  quotes: readonly AvwapMark[];
}

export interface AvwapQuoteRequest {
  occ: string;
  symbol: AvwapSymbol;
  expiration: string;
  strike: number;
}

export function emptyAvwapPaperBook(): AvwapPaperBook {
  return { version: 1, trades: [], notes: {}, updatedAt: null };
}

export function serializeAvwapPaperBook(book: AvwapPaperBook): string {
  return JSON.stringify({
    version: 1,
    trades: book.trades,
    notes: book.notes,
    updatedAt: book.updatedAt,
  });
}

export function parseAvwapPaperBook(text: string | null | undefined): AvwapPaperBook {
  if (!text) return emptyAvwapPaperBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyAvwapPaperBook();
  }
  const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  if (!row || !Array.isArray(row.trades)) return emptyAvwapPaperBook();
  const trades: AvwapPaperTrade[] = [];
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

export interface AvwapAdvanceResult {
  book: AvwapPaperBook;
  opened: AvwapPaperTrade[];
  closed: AvwapPaperTrade[];
}

/**
 * Mark open paper puts and, when the fresh cross is still this scan, open one.
 * A holiday or a closed session returns the book unchanged.
 */
export function advanceAvwapPaper(
  book: AvwapPaperBook,
  snapshots: readonly AvwapSnapshot[],
  now: Date,
): AvwapAdvanceResult {
  if (!avwapSessionOpen(now)) return { book, opened: [], closed: [] };
  const nowMs = now.getTime();
  const today = newYorkDate(now);
  const bySymbol = new Map<AvwapSymbol, AvwapSnapshot>();
  for (let i = 0; i < snapshots.length; i++) bySymbol.set(snapshots[i].symbol, snapshots[i]);
  let trades = book.trades.map(cloneTrade);
  const closed: AvwapPaperTrade[] = [];
  const notes: Partial<Record<AvwapSymbol, string>> = {};

  for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
    const symbol = AVWAP_SYMBOLS[i];
    const snap = bySymbol.get(symbol) ?? null;
    trades = trades.map((trade) => {
      if (trade.symbol !== symbol) return trade;
      const next = markTrade(trade, snap, now);
      if (trade.status === "open" && next.status === "closed") closed.push(next);
      return next;
    });
  }

  const opened: AvwapPaperTrade[] = [];
  const stopped = avwapDailyStop(trades, now).dailyStop;
  for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
    const symbol = AVWAP_SYMBOLS[i];
    const snap = bySymbol.get(symbol) ?? null;
    const decision = entryDecision(trades, snap, today, nowMs, stopped);
    notes[symbol] = decision.note;
    if (!decision.trade) continue;
    trades.push(decision.trade);
    opened.push(decision.trade);
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

/** Option symbols to quote this scan. Puts only. Empty when nothing is open and nothing just signaled. */
export function quotePlan(book: AvwapPaperBook, markets: readonly AvwapMarket[], now: Date): AvwapQuoteRequest[] {
  if (!avwapSessionOpen(now)) return [];
  const nowMs = now.getTime();
  const today = newYorkDate(now);
  const stopped = avwapDailyStop(book.trades, now).dailyStop;
  const requests: AvwapQuoteRequest[] = [];
  const seen = new Set<string>();
  const add = (symbol: AvwapSymbol, expiration: string, strike: number) => {
    const occ = schwabOptionSymbol({ ticker: symbol, expiration, strike, putCall: "put" });
    if (!occ || seen.has(occ)) return;
    seen.add(occ);
    requests.push({ occ, symbol, expiration, strike });
  };

  for (let i = 0; i < book.trades.length; i++) {
    const trade = book.trades[i];
    if (trade.status === "open") add(trade.symbol, trade.expiration, trade.strike);
    for (let w = 0; w < trade.whatIfs.length; w++) {
      const leg = trade.whatIfs[w];
      if (leg.status === "open") add(trade.symbol, leg.expiration, leg.strike);
    }
  }
  if (stopped) return requests;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    if (hasOpen(book.trades, market.symbol)) continue;
    const setup = setupOf(market, today, nowMs);
    if (!setup || !setup.fresh || setup.strike == null || setup.signal == null) continue;
    if (alreadySignaled(book.trades, market.symbol, setup.signal.at)) continue;
    const primary = expiryCandidates(today, AVWAP_PRIMARY_DTE_MIN, AVWAP_PRIMARY_DTE_MAX, AVWAP_PRIMARY_DTE_TARGET);
    const alt = expiryCandidates(today, AVWAP_ALT_DTE_MIN, AVWAP_ALT_DTE_MAX, AVWAP_ALT_DTE_TARGET);
    for (let e = 0; e < primary.length; e++) add(market.symbol, primary[e], setup.strike);
    for (let e = 0; e < alt.length; e++) add(market.symbol, alt[e], setup.strike);
  }
  return requests;
}

export interface AvwapDailyStop {
  tradingDay: string;
  consecutiveLosses: number;
  dailyStop: boolean;
}

/** Two primary losing closes in a row on this Chicago day block new entries. A later win does not clear it. */
export function avwapDailyStop(trades: readonly AvwapPaperTrade[], now: Date): AvwapDailyStop {
  const tradingDay = chicagoDate(now);
  const closed = trades.filter((trade) => {
    if (trade.status !== "closed" || trade.closedAt == null || trade.pnlDollars == null) return false;
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
  const dailyStop = maxStreak >= AVWAP_DAILY_STOP_LOSSES;
  return {
    tradingDay,
    consecutiveLosses: dailyStop ? maxStreak : streak,
    dailyStop,
  };
}

export interface AvwapDrawdown {
  cumulativePnlDollars: number;
  peakPnlDollars: number;
  maxDrawdownDollars: number;
  currentDrawdownDollars: number;
  openUnrealizedDollars: number;
  /** True when peak-to-trough paper equity is greater than $1,500. */
  flagged: boolean;
}

/**
 * Peak-to-trough of closed primary P&L, then the same curve with open marks.
 * An open mark uses the last bid and charges both sides of the fee, as if sold now.
 */
export function avwapDrawdown(trades: readonly AvwapPaperTrade[]): AvwapDrawdown {
  const closed = trades.filter((trade) => trade.status === "closed" && trade.pnlDollars != null && trade.closedAt != null);
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
    if (trade.status !== "open" || trade.lastBid == null) continue;
    const pnl = avwapPnl(trade.entryAsk, trade.lastBid, trade.contracts);
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
    flagged: worst > AVWAP_DRAWDOWN_FLAG_DOLLARS + 1e-6,
  };
}

export interface AvwapPaperHealth {
  paperOnly: true;
  open: number;
  closed: number;
  cumulativePnlDollars: number;
  maxDrawdownDollars: number;
  drawdownFlag: boolean;
  dailyStop: boolean;
  todayLossStreak: number;
}

export function emptyAvwapPaperHealth(): AvwapPaperHealth {
  return {
    paperOnly: true,
    open: 0,
    closed: 0,
    cumulativePnlDollars: 0,
    maxDrawdownDollars: 0,
    drawdownFlag: false,
    dailyStop: false,
    todayLossStreak: 0,
  };
}

export function avwapPaperHealth(trades: readonly AvwapPaperTrade[], now: Date): AvwapPaperHealth {
  const drawdown = avwapDrawdown(trades);
  const stop = avwapDailyStop(trades, now);
  let open = 0;
  let closed = 0;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].status === "open") open += 1;
    else closed += 1;
  }
  return {
    paperOnly: true,
    open,
    closed,
    cumulativePnlDollars: drawdown.cumulativePnlDollars,
    maxDrawdownDollars: drawdown.maxDrawdownDollars,
    drawdownFlag: drawdown.flagged,
    dailyStop: stop.dailyStop,
    todayLossStreak: stop.consecutiveLosses,
  };
}

export interface AvwapBriefRow {
  symbol: AvwapSymbol;
  strike: number;
  expiration: string;
  contracts: number;
  status: "open" | "closed";
  entryBid: number;
  entryAsk: number;
  exitBid: number | null;
  exitAsk: number | null;
  lastBid: number | null;
  lastAsk: number | null;
  pnlDollars: number | null;
  unrealizedPnlDollars: number | null;
  exitReason: AvwapPaperTrade["exitReason"];
  openedAt: string;
  closedAt: string | null;
}

export interface AvwapPaperBrief extends AvwapPaperHealth {
  label: "AVWAP Paper";
  note: string;
  whatIf25PnlDollars: number;
  whatIf14PnlDollars: number;
  openRows: AvwapBriefRow[];
  closedToday: AvwapBriefRow[];
}

export function avwapPaperBrief(trades: readonly AvwapPaperTrade[], now: Date): AvwapPaperBrief {
  const health = avwapPaperHealth(trades, now);
  const day = chicagoDate(now);
  const openRows = trades.filter((trade) => trade.status === "open").map(briefRow);
  const closedToday = trades.filter((trade) => {
    if (trade.status !== "closed" || trade.closedAt == null) return false;
    return chicagoDate(new Date(trade.closedAt)) === day;
  }).map(briefRow);
  openRows.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  closedToday.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  return {
    ...health,
    label: "AVWAP Paper",
    note: AVWAP_PAPER_NOTE,
    whatIf25PnlDollars: whatIfTotal(trades, "target25-or-3d"),
    whatIf14PnlDollars: whatIfTotal(trades, "dte14"),
    openRows,
    closedToday,
  };
}

export interface AvwapRunningPoint {
  at: number;
  id: string;
  symbol: AvwapSymbol;
  pnlDollars: number;
  runningPnlDollars: number;
}

export interface AvwapPaperSection {
  label: "AVWAP Paper";
  note: string;
  paperOnly: true;
  stored: boolean;
  symbols: readonly AvwapSymbol[];
  gapFraction: number;
  budgetDollars: number;
  feePerSide: number;
  drawdownFlagDollars: number;
  health: AvwapPaperHealth;
  drawdown: AvwapDrawdown;
  whatIf25PnlDollars: number;
  whatIf14PnlDollars: number;
  notes: Partial<Record<AvwapSymbol, string>>;
  updatedAt: number | null;
  open: AvwapViewTrade[];
  closed: AvwapViewTrade[];
  running: AvwapRunningPoint[];
}

export interface AvwapViewTrade extends AvwapPaperTrade {
  unrealizedPnlDollars: number | null;
  debitDollars: number;
  runningPnlDollars: number | null;
  whatIfs: AvwapViewWhatIf[];
}

export interface AvwapViewWhatIf extends AvwapWhatIf {
  unrealizedPnlDollars: number | null;
}

export function avwapPaperSection(book: AvwapPaperBook, now: Date, stored: boolean): AvwapPaperSection {
  const drawdown = avwapDrawdown(book.trades);
  const running = runningPoints(book.trades);
  const runningById = new Map<string, number>();
  for (let i = 0; i < running.length; i++) runningById.set(running[i].id, running[i].runningPnlDollars);
  const views = book.trades.map((trade) => viewTrade(trade, runningById.get(trade.id) ?? null));
  const open = views.filter((trade) => trade.status === "open").sort((a, b) => b.openedAt - a.openedAt);
  const closed = views.filter((trade) => trade.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  return {
    label: "AVWAP Paper",
    note: AVWAP_PAPER_NOTE,
    paperOnly: true,
    stored,
    symbols: AVWAP_SYMBOLS,
    gapFraction: AVWAP_GAP_FRACTION,
    budgetDollars: AVWAP_BUDGET_DOLLARS,
    feePerSide: AVWAP_FEE_PER_SIDE,
    drawdownFlagDollars: AVWAP_DRAWDOWN_FLAG_DOLLARS,
    health: avwapPaperHealth(book.trades, now),
    drawdown,
    whatIf25PnlDollars: whatIfTotal(book.trades, "target25-or-3d"),
    whatIf14PnlDollars: whatIfTotal(book.trades, "dte14"),
    notes: book.notes,
    updatedAt: book.updatedAt,
    open,
    closed,
    running,
  };
}

export function formatAvwapPaperAlert(trade: AvwapPaperTrade): string {
  const target = trade.entryAsk * (1 + AVWAP_TARGET_FRACTION);
  const debit = trade.entryAsk * 100 * trade.contracts;
  const alt = trade.whatIfs.find((leg) => leg.id === "dte14");
  const altLine = !alt || alt.status === "skipped"
    ? `14-day what-if skipped${alt?.skipReason ? `: ${escapeHtml(alt.skipReason)}` : "."}`
    : `14-day what-if: ${alt.contracts} ${escapeHtml(trade.symbol)} put $${money(alt.strike)} exp ${escapeHtml(alt.expiration)} at the ask $${money(alt.entryAsk)}.`;
  return `<b>PAPER ONLY</b>
${escapeHtml(trade.symbol)} <b>PUT</b> $${money(trade.strike)} exp ${escapeHtml(trade.expiration)}
Paper only. No order is placed. This is not an A or a B alert.

Gap-day anchored VWAP reject. Anchor ${escapeHtml(trade.anchorDate)} (${(trade.gap * 100).toFixed(2)}% vs the prior close). 5-minute close $${money(trade.signalClose)} below AVWAP $${money(trade.signalVwap)}.
Buy <b>${trade.contracts}</b> at the ask $${money(trade.entryAsk)} (bid $${money(trade.entryBid)}). Debit $${money(debit)}, within the $${AVWAP_BUDGET_DOLLARS} cap.
Sell at the bid when the bid is at least $${money(target)} (+50%). Otherwise close on the expiry-day final scan.
What-if on this contract: +25% or sell after 3 trading days. ${altLine}`;
}

interface Setup {
  gap: GapDay;
  signal: AvwapSignal | null;
  fresh: boolean;
  spot: number | null;
  strike: number | null;
  points: number;
}

function setupOf(market: AvwapMarket, today: string, nowMs: number): Setup | null {
  const gap = latestGapDay(market.daily, today);
  if (!gap) return null;
  const points = avwapPoints(market.bars, gap.date, nowMs);
  const signal = firstAvwapReject(market.bars, gap.date, nowMs);
  const spot = points.length > 0 ? points[points.length - 1].close : null;
  return {
    gap,
    signal,
    fresh: signal != null && signalIsFresh(signal, nowMs),
    spot,
    strike: spot == null ? null : atmStrike(spot),
    points: points.length,
  };
}

function entryDecision(
  trades: readonly AvwapPaperTrade[],
  snap: AvwapSnapshot | null,
  today: string,
  nowMs: number,
  stopped: boolean,
): { trade: AvwapPaperTrade | null; note: string } {
  const symbol = snap?.symbol;
  if (!snap || !symbol) return { trade: null, note: "no bars on this scan" };
  const setup = setupOf(snap, today, nowMs);
  if (!setup) return { trade: null, note: "no gap of more than 1% in the daily bars" };
  if (setup.points === 0) return { trade: null, note: `gap ${setup.gap.date} has no completed regular-hours bars in this fetch` };
  if (!setup.signal) return { trade: null, note: `anchored at ${setup.gap.date}; no close below the anchored VWAP yet` };
  if (hasOpen(trades, symbol)) return { trade: null, note: "one paper position is already open" };
  if (setup.signal && alreadySignaled(trades, symbol, setup.signal.at)) {
    return { trade: null, note: "this cross was already papered" };
  }
  if (!setup.fresh) return { trade: null, note: "the first cross below the anchored VWAP is older than this scan" };
  if (stopped) return { trade: null, note: "daily stop: two losing paper closes in a row" };
  if (setup.strike == null || setup.spot == null) return { trade: null, note: "no underlying price for the at-the-money strike" };
  const trade = openTrade(snap, setup, today, nowMs);
  if (!trade) {
    const priced = pickQuote(snap.quotes, today, AVWAP_PRIMARY_DTE_MIN, AVWAP_PRIMARY_DTE_MAX, AVWAP_PRIMARY_DTE_TARGET, setup.strike);
    if (priced && avwapContractCount(priced.ask) === 0) return { trade: null, note: "one contract costs more than $875" };
    return { trade: null, note: "no put quote in the 5–10 day window" };
  }
  return { trade, note: `paper entry, ${trade.contracts} contract${trade.contracts === 1 ? "" : "s"}` };
}

function openTrade(snap: AvwapSnapshot, setup: Setup, today: string, nowMs: number): AvwapPaperTrade | null {
  if (!setup.signal || !setup.fresh || setup.strike == null || setup.spot == null) return null;
  const quote = pickQuote(snap.quotes, today, AVWAP_PRIMARY_DTE_MIN, AVWAP_PRIMARY_DTE_MAX, AVWAP_PRIMARY_DTE_TARGET, setup.strike);
  if (!quote) return null;
  const contracts = avwapContractCount(quote.ask);
  if (contracts == null || contracts < 1) return null;
  const dte = calendarDaysBetween(today, quote.expiration);
  if (dte == null || dte < AVWAP_PRIMARY_DTE_MIN || dte > AVWAP_PRIMARY_DTE_MAX) return null;
  const primary = liveWhatIf("target25-or-3d", "7 DTE, +25% or 3 trading days", quote, contracts);
  const altQuote = pickQuote(snap.quotes, today, AVWAP_ALT_DTE_MIN, AVWAP_ALT_DTE_MAX, AVWAP_ALT_DTE_TARGET, setup.strike);
  const alt = altLeg(altQuote, setup.strike);
  return {
    id: `avwap-${snap.symbol}-${setup.signal.at}`,
    symbol: snap.symbol,
    putCall: "put",
    strike: setup.strike,
    expiration: quote.expiration,
    dte,
    contracts,
    openedAt: nowMs,
    signalAt: setup.signal.at,
    anchorDate: setup.gap.date,
    gap: setup.gap.gap,
    spot: setup.spot,
    signalClose: setup.signal.close,
    signalVwap: setup.signal.vwap,
    entryAsk: quote.ask,
    entryBid: quote.bid,
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
    whatIfs: [primary, alt],
  };
}

function altLeg(quote: AvwapMark | null, strike: number): AvwapWhatIf {
  if (!quote) {
    return skippedWhatIf("dte14", "14 DTE, +50% or 3 trading days", "No put quote in the 12–16 day window.", strike);
  }
  const contracts = avwapContractCount(quote.ask);
  if (contracts == null || contracts < 1) {
    return skippedWhatIf("dte14", "14 DTE, +50% or 3 trading days", "One 14-day contract costs more than $875.", quote.strike);
  }
  return liveWhatIf("dte14", "14 DTE, +50% or 3 trading days", quote, contracts);
}

function liveWhatIf(id: AvwapWhatIfId, label: string, quote: AvwapMark, contracts: number): AvwapWhatIf {
  return {
    id,
    label,
    expiration: quote.expiration,
    strike: quote.strike,
    contracts,
    entryAsk: quote.ask,
    entryBid: quote.bid,
    status: "open",
    skipReason: null,
    closedAt: null,
    exitBid: null,
    exitAsk: null,
    exitReason: null,
    exitNote: null,
    pnlDollars: null,
    lastBid: quote.bid,
    lastAsk: quote.ask,
  };
}

function skippedWhatIf(id: AvwapWhatIfId, label: string, reason: string, strike: number): AvwapWhatIf {
  return {
    id,
    label,
    expiration: "",
    strike,
    contracts: 0,
    entryAsk: 0,
    entryBid: 0,
    status: "skipped",
    skipReason: reason,
    closedAt: null,
    exitBid: null,
    exitAsk: null,
    exitReason: null,
    exitNote: null,
    pnlDollars: null,
    lastBid: null,
    lastAsk: null,
  };
}

function markTrade(trade: AvwapPaperTrade, snap: AvwapSnapshot | null, now: Date): AvwapPaperTrade {
  const quotes = snap?.quotes ?? [];
  const nowMs = now.getTime();
  let next = trade;
  if (trade.status === "open") {
    const quote = findMark(quotes, trade.expiration, trade.strike);
    const bid = quote ? quote.bid : null;
    const ask = quote ? quote.ask : null;
    const withMark: AvwapPaperTrade = quote
      ? { ...trade, lastBid: bid, lastAsk: ask, lastQuoteAt: nowMs }
      : trade;
    const target = bid != null && bidHitsTarget(bid, trade.entryAsk, AVWAP_TARGET_FRACTION);
    const expiry = isExpiryFinalScan(now, trade.expiration);
    if (target && bid != null && ask != null) {
      next = closePrimary(withMark, bid, ask, "target50", null, nowMs);
    } else if (expiry && bid != null && ask != null) {
      next = closePrimary(withMark, bid, ask, "expiry", null, nowMs);
    } else if (expiry && newYorkDate(now) > trade.expiration) {
      next = closePrimary(withMark, 0, ask, "expiry", "No bid after expiration. Closed at 0.", nowMs);
    } else {
      next = withMark;
    }
  }
  return { ...next, whatIfs: next.whatIfs.map((leg) => markWhatIf(leg, quotes, now, trade.openedAt)) };
}

function closePrimary(
  trade: AvwapPaperTrade,
  bid: number,
  ask: number | null,
  reason: "target50" | "expiry",
  note: string | null,
  nowMs: number,
): AvwapPaperTrade {
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
    lastAsk: ask,
    lastQuoteAt: nowMs,
  };
}

function markWhatIf(leg: AvwapWhatIf, quotes: readonly AvwapMark[], now: Date, openedAt: number): AvwapWhatIf {
  if (leg.status !== "open") return leg;
  const quote = findMark(quotes, leg.expiration, leg.strike);
  const marked: AvwapWhatIf = quote
    ? { ...leg, lastBid: quote.bid, lastAsk: quote.ask }
    : leg;
  const bid = quote ? quote.bid : null;
  const ask = quote ? quote.ask : null;
  if (leg.id === "target25-or-3d") {
    if (bid != null && ask != null && bidHitsTarget(bid, leg.entryAsk, AVWAP_WHATIF_TARGET_FRACTION)) {
      return closeWhatIf(marked, bid, ask, "target25", null, now.getTime());
    }
  } else if (bid != null && ask != null && bidHitsTarget(bid, leg.entryAsk, AVWAP_TARGET_FRACTION)) {
    return closeWhatIf(marked, bid, ask, "target50", null, now.getTime());
  }
  if (timeStopDue(openedAt, now) && bid != null && ask != null) {
    return closeWhatIf(marked, bid, ask, "time3", null, now.getTime());
  }
  if (leg.expiration && isExpiryFinalScan(now, leg.expiration)) {
    if (bid != null && ask != null) return closeWhatIf(marked, bid, ask, "expiry", null, now.getTime());
    if (newYorkDate(now) > leg.expiration) return closeWhatIf(marked, 0, ask, "expiry", "No bid after expiration. Closed at 0.", now.getTime());
  }
  return marked;
}

function closeWhatIf(
  leg: AvwapWhatIf,
  bid: number,
  ask: number | null,
  reason: AvwapExitReason,
  note: string | null,
  nowMs: number,
): AvwapWhatIf {
  return {
    ...leg,
    status: "closed",
    closedAt: nowMs,
    exitBid: bid,
    exitAsk: ask,
    exitReason: reason,
    exitNote: note,
    pnlDollars: avwapPnl(leg.entryAsk, bid, leg.contracts),
    lastBid: bid,
    lastAsk: ask,
  };
}

function pickQuote(
  quotes: readonly AvwapMark[],
  today: string,
  minDte: number,
  maxDte: number,
  target: number,
  strike: number,
): AvwapMark | null {
  const order = expiryCandidates(today, minDte, maxDte, target);
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

function hasOpen(trades: readonly AvwapPaperTrade[], symbol: AvwapSymbol): boolean {
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].symbol === symbol && trades[i].status === "open") return true;
  }
  return false;
}

function alreadySignaled(trades: readonly AvwapPaperTrade[], symbol: AvwapSymbol, signalAt: number): boolean {
  const id = `avwap-${symbol}-${signalAt}`;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].id === id) return true;
  }
  return false;
}

function whatIfTotal(trades: readonly AvwapPaperTrade[], id: AvwapWhatIfId): number {
  let total = 0;
  for (let i = 0; i < trades.length; i++) {
    const leg = trades[i].whatIfs.find((item) => item.id === id);
    if (leg?.status === "closed" && leg.pnlDollars != null) total += leg.pnlDollars;
  }
  return roundCents(total);
}

function runningPoints(trades: readonly AvwapPaperTrade[]): AvwapRunningPoint[] {
  const closed = trades.filter((trade) => trade.status === "closed" && trade.pnlDollars != null && trade.closedAt != null);
  closed.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.id.localeCompare(b.id));
  let running = 0;
  const points: AvwapRunningPoint[] = [];
  for (let i = 0; i < closed.length; i++) {
    const trade = closed[i];
    running = roundCents(running + (trade.pnlDollars ?? 0));
    points.push({
      at: trade.closedAt ?? 0,
      id: trade.id,
      symbol: trade.symbol,
      pnlDollars: trade.pnlDollars ?? 0,
      runningPnlDollars: running,
    });
  }
  return points;
}

function viewTrade(trade: AvwapPaperTrade, runningPnl: number | null): AvwapViewTrade {
  const unrealized = trade.status === "open" && trade.lastBid != null
    ? avwapPnl(trade.entryAsk, trade.lastBid, trade.contracts)
    : null;
  return {
    ...trade,
    unrealizedPnlDollars: unrealized,
    debitDollars: roundCents(trade.entryAsk * 100 * trade.contracts),
    runningPnlDollars: runningPnl,
    whatIfs: trade.whatIfs.map((leg) => ({
      ...leg,
      unrealizedPnlDollars: leg.status === "open" && leg.lastBid != null && leg.contracts >= 1
        ? avwapPnl(leg.entryAsk, leg.lastBid, leg.contracts)
        : null,
    })),
  };
}

function briefRow(trade: AvwapPaperTrade): AvwapBriefRow {
  const unrealized = trade.status === "open" && trade.lastBid != null
    ? avwapPnl(trade.entryAsk, trade.lastBid, trade.contracts)
    : null;
  return {
    symbol: trade.symbol,
    strike: trade.strike,
    expiration: trade.expiration,
    contracts: trade.contracts,
    status: trade.status,
    entryBid: trade.entryBid,
    entryAsk: trade.entryAsk,
    exitBid: trade.exitBid,
    exitAsk: trade.exitAsk,
    lastBid: trade.lastBid,
    lastAsk: trade.lastAsk,
    pnlDollars: trade.pnlDollars,
    unrealizedPnlDollars: unrealized,
    exitReason: trade.exitReason,
    openedAt: new Date(trade.openedAt).toISOString(),
    closedAt: trade.closedAt == null ? null : new Date(trade.closedAt).toISOString(),
  };
}

function cloneTrade(trade: AvwapPaperTrade): AvwapPaperTrade {
  return { ...trade, whatIfs: trade.whatIfs.map((leg) => ({ ...leg })) };
}

function trimTrades(trades: AvwapPaperTrade[]): AvwapPaperTrade[] {
  const active: AvwapPaperTrade[] = [];
  const done: AvwapPaperTrade[] = [];
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const whatIfOpen = trade.whatIfs.some((leg) => leg.status === "open");
    if (trade.status === "open" || whatIfOpen) active.push(trade);
    else done.push(trade);
  }
  done.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  const room = Math.max(0, AVWAP_ROW_CAP - active.length);
  return active.concat(done.slice(0, room));
}

interface NormalizedDay {
  date: string;
  open: number;
  close: number;
}

function normalizeDaily(days: readonly AvwapDailyBar[]): NormalizedDay[] {
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

function dayOf(bar: AvwapDailyBar): string | null {
  if (bar.date && /^\d{4}-\d{2}-\d{2}$/.test(bar.date)) return bar.date;
  if (bar.t == null || !Number.isFinite(bar.t)) return null;
  const date = newYorkDate(new Date(bar.t));
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function usableBar(bar: CandleBar): boolean {
  return Number.isFinite(bar.t)
    && bar.h > 0
    && bar.l > 0
    && bar.c > 0
    && bar.h >= bar.l
    && Number.isFinite(bar.h)
    && Number.isFinite(bar.l)
    && Number.isFinite(bar.c);
}

function barVolume(bar: CandleBar): number {
  return bar.v != null && Number.isFinite(bar.v) && bar.v > 0 ? bar.v : 0;
}

function weightOf(volume: number | undefined): number {
  return volume != null && Number.isFinite(volume) && volume >= 1 ? volume : 1;
}

function isTradingDayYmd(ymd: string): boolean {
  const probe = new Date(`${ymd}T17:00:00.000Z`);
  return isMarketDay(probe) && newYorkDate(probe) === ymd;
}

function exceedsGap(gap: number): boolean {
  return Math.abs(gap) > AVWAP_GAP_FRACTION + 1e-8;
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

function parseNotes(value: unknown): Partial<Record<AvwapSymbol, string>> {
  const notes: Partial<Record<AvwapSymbol, string>> = {};
  if (!value || typeof value !== "object") return notes;
  const row = value as Record<string, unknown>;
  for (let i = 0; i < AVWAP_SYMBOLS.length; i++) {
    const symbol = AVWAP_SYMBOLS[i];
    const note = row[symbol];
    if (typeof note === "string" && note.trim()) notes[symbol] = note.slice(0, 240);
  }
  return notes;
}

function parseTrade(value: unknown): AvwapPaperTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const symbol = typeof row.symbol === "string" ? row.symbol : "";
  if (!isAvwapSymbol(symbol)) return null;
  if (row.putCall != null && row.putCall !== "put") return null;
  const strike = finiteNumber(row.strike);
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  const contracts = finiteNumber(row.contracts);
  const openedAt = finiteNumber(row.openedAt);
  const signalAt = finiteNumber(row.signalAt);
  const entryAsk = finiteNumber(row.entryAsk);
  const entryBid = finiteNumber(row.entryBid);
  const dte = finiteNumber(row.dte);
  const gap = finiteNumber(row.gap);
  const spot = finiteNumber(row.spot);
  const signalClose = finiteNumber(row.signalClose);
  const signalVwap = finiteNumber(row.signalVwap);
  const anchorDate = typeof row.anchorDate === "string" ? row.anchorDate : "";
  const id = typeof row.id === "string" ? row.id : "";
  if (strike == null || !(strike > 0)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  if (contracts == null || !Number.isInteger(contracts) || contracts < 1) return null;
  if (openedAt == null || signalAt == null || entryAsk == null || !(entryAsk > 0)) return null;
  if (entryBid == null || entryBid < 0 || dte == null || gap == null || spot == null) return null;
  if (signalClose == null || signalVwap == null || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return null;
  if (!id) return null;
  const status = row.status === "closed" ? "closed" : row.status === "open" ? "open" : null;
  if (!status) return null;
  const whatIfs = Array.isArray(row.whatIfs) ? row.whatIfs.map(parseWhatIf).filter((leg): leg is AvwapWhatIf => leg != null) : [];
  const closed = status === "closed";
  const exitBid = finiteNumber(row.exitBid);
  const pnl = finiteNumber(row.pnlDollars);
  return {
    id: id.slice(0, 120),
    symbol,
    putCall: "put",
    strike,
    expiration,
    dte,
    contracts,
    openedAt,
    signalAt,
    anchorDate,
    gap,
    spot,
    signalClose,
    signalVwap,
    entryAsk,
    entryBid,
    lastBid: finiteNumber(row.lastBid),
    lastAsk: finiteNumber(row.lastAsk),
    lastQuoteAt: finiteNumber(row.lastQuoteAt),
    status,
    closedAt: closed ? finiteNumber(row.closedAt) : null,
    exitBid: closed ? exitBid : null,
    exitAsk: closed ? finiteNumber(row.exitAsk) : null,
    exitReason: closed && (row.exitReason === "target50" || row.exitReason === "expiry") ? row.exitReason : null,
    exitNote: typeof row.exitNote === "string" ? row.exitNote.slice(0, 200) : null,
    pnlDollars: closed ? pnl : null,
    whatIfs,
  };
}

function parseWhatIf(value: unknown): AvwapWhatIf | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = row.id === "target25-or-3d" || row.id === "dte14" ? row.id : null;
  if (!id) return null;
  const status = row.status === "open" || row.status === "closed" || row.status === "skipped" ? row.status : null;
  if (!status) return null;
  const label = typeof row.label === "string" && row.label ? row.label.slice(0, 80) : id;
  const closed = status === "closed";
  return {
    id,
    label,
    expiration: typeof row.expiration === "string" ? row.expiration : "",
    strike: finiteNumber(row.strike) ?? 0,
    contracts: Math.max(0, Math.floor(finiteNumber(row.contracts) ?? 0)),
    entryAsk: finiteNumber(row.entryAsk) ?? 0,
    entryBid: finiteNumber(row.entryBid) ?? 0,
    status,
    skipReason: typeof row.skipReason === "string" ? row.skipReason.slice(0, 200) : null,
    closedAt: closed ? finiteNumber(row.closedAt) : null,
    exitBid: closed ? finiteNumber(row.exitBid) : null,
    exitAsk: closed ? finiteNumber(row.exitAsk) : null,
    exitReason: closed && isExitReason(row.exitReason) ? row.exitReason : null,
    exitNote: typeof row.exitNote === "string" ? row.exitNote.slice(0, 200) : null,
    pnlDollars: closed ? finiteNumber(row.pnlDollars) : null,
    lastBid: finiteNumber(row.lastBid),
    lastAsk: finiteNumber(row.lastAsk),
  };
}

function isExitReason(value: unknown): value is AvwapExitReason {
  return value === "target50" || value === "target25" || value === "time3" || value === "expiry";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
