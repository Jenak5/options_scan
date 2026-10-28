import {
  JG_VWAP_ATR_BAND_HIGH,
  JG_VWAP_ATR_BAND_LOW,
  JG_VWAP_BUDGET_DOLLARS,
  JG_VWAP_SIZE_0DTE_DOLLARS,
  JG_VWAP_SIZE_UNKNOWN_DOLLARS,
  JG_VWAP_TEST,
} from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import type { OptionContract, PutCall } from "@/app/lib/contract";
import { newYorkDate } from "@/app/lib/flow";
import { nyMinutes } from "@/app/lib/featureBackfill";
import { isChicagoMarketHours, isMarketDay, nextChicagoTradingDay } from "@/app/lib/marketHours";
import { DEFAULT_ACCOUNT_SIZE_DOLLARS } from "@/app/lib/risk";
import type { JgSignal } from "@/app/lib/jgSignal";
import { completedSessionMinutes } from "@/app/lib/vwapPut";

/**
 * Paper-only J.G. Banks 0DTE entry with a session-VWAP filter.
 * Direction comes from the backtest, not from which side of VWAP price is on.
 * See jgSignal.ts. A missing trend, level, or vol index is no trade.
 * Nothing here grades an alert, sends the A/B Telegram path, or places an order.
 *
 * Session VWAP matches the other paper rule: completed regular-hours minutes,
 * typical price (H+L+C)/3, volume floored at 1, anchored at 9:30 ET.
 * The day's implied move is spot × annualized IV × sqrt(1/365).
 *
 * 0DTE expires the same day. 1DTE uses the next NYSE trading day's expiry.
 * Both are entered and closed the same session: the implied-move stop, or
 * 3:45 PM ET (1:00 PM ET on an early close). They are not held overnight.
 * ATR used is today's range / ATR14. 0DTE size is $250 when that ratio is
 * known. 1DTE size is $875 inside 0.41–0.67 and $300 outside. A missing ATR
 * is $300 for both. The flat $875 size stays for comparison.
 */

export const JG_VWAP_TICKERS = ["QQQ", "SPX"] as const;
export type JgTicker = (typeof JG_VWAP_TICKERS)[number];
export type JgChainRoot = "QQQ" | "SPX" | "SPXW";
export type JgDte = "0DTE" | "1DTE";

/** Next NYSE session after `ymd`. Weekends and full-day holidays are skipped. Early closes count. */
export function jgNextTradingDay(ymd: string): string | null {
  return nextChicagoTradingDay(ymd);
}

/** NYSE early closes already listed in marketHours.ts. Cash session ends at 1:00 PM ET. */
const EARLY_CLOSE_ET = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const FLAT_EXIT_ET = 15 * 60 + 45;
const EARLY_FLAT_EXIT_ET = 13 * 60;
const ROW_CAP = 1_500;
const ATR_PERIOD = 14;
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;

export function jgChainRoots(ticker: JgTicker): readonly string[] {
  return ticker === "SPX" ? ["SPX", "SPXW"] : ["QQQ"];
}

/** Price-history symbol. SPX options may be SPXW; the index candles stay on SPX. */
export function jgHistorySymbol(ticker: JgTicker): string {
  return ticker;
}

export function jgVwapSessionOpen(now: Date): boolean {
  return isMarketDay(now) && isChicagoMarketHours(now);
}

export function jgFlatExitMinute(day: string): number {
  return EARLY_CLOSE_ET.has(day) ? EARLY_FLAT_EXIT_ET : FLAT_EXIT_ET;
}

/**
 * Call when price is on the call side of VWAP and not also on the put side.
 * Put when price is on the put side and not also on the call side.
 * Null inside the band, or when price or VWAP is missing.
 */
export function jgVwapSide(price: number, vwap: number): PutCall | null {
  if (!(price > 0) || !(vwap > 0) || !Number.isFinite(price) || !Number.isFinite(vwap)) return null;
  const band = JG_VWAP_TEST.vwapBand;
  const callSide = price >= vwap * (1 - band);
  const putSide = price <= vwap * (1 + band);
  if (callSide && !putSide) return "call";
  if (putSide && !callSide) return "put";
  return null;
}

/** floor(budget / (ask × 100)). Above the budget, log 1 contract and flag it. */
export function jgVwapSize(ask: number): { contracts: number; overBudget: boolean } | null {
  return jgBudgetSize(ask, JG_VWAP_BUDGET_DOLLARS);
}

/**
 * Contracts at a dollar size: floor(size / (ask × 100)).
 * Zero means the size does not buy one contract. Callers skip scoring that case.
 */
export function jgContractsForSize(ask: number, size: number): number | null {
  if (!(ask > 0) || !Number.isFinite(ask) || !(size > 0) || !Number.isFinite(size)) return null;
  const cost = ask * 100;
  if (!(cost > 0) || !Number.isFinite(cost)) return null;
  const fit = Math.floor(size / cost);
  return Number.isInteger(fit) && fit >= 0 ? fit : null;
}

function jgBudgetSize(ask: number, budget: number): { contracts: number; overBudget: boolean } | null {
  const fit = jgContractsForSize(ask, budget);
  if (fit == null) return null;
  if (fit >= 1) return { contracts: fit, overBudget: false };
  return { contracts: 1, overBudget: true };
}

/**
 * 14-day average true range from prior completed daily bars.
 * True range is max(high−low, |high−previous close|, |low−previous close|).
 * The value is the simple average of the last 14 true ranges. Today is excluded.
 * Fewer than 14 true ranges, or a non-positive average, is missing. Nothing is filled in.
 */
export function jgAtr14(bars: readonly CandleBar[], today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const byDay = new Map<string, CandleBar>();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!Number.isFinite(bar.t) || !usableDailyBar(bar)) continue;
    const date = newYorkDate(new Date(bar.t));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= today) continue;
    byDay.set(date, bar);
  }
  const days = Array.from(byDay.keys()).sort();
  if (days.length < ATR_PERIOD + 1) return null;
  const ranges: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const bar = byDay.get(days[i]);
    const prev = byDay.get(days[i - 1]);
    if (!bar || !prev) return null;
    const tr = Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c));
    if (!Number.isFinite(tr) || tr < 0) return null;
    ranges.push(tr);
  }
  const last = ranges.slice(-ATR_PERIOD);
  if (last.length < ATR_PERIOD) return null;
  let sum = 0;
  for (let i = 0; i < last.length; i++) sum += last[i];
  const atr = sum / ATR_PERIOD;
  return atr > 0 && Number.isFinite(atr) ? atr : null;
}

/** Today's high minus today's low so far, from regular-hours bars that have started. */
export function jgTodayRange(bars: readonly CandleBar[], nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) return null;
  const today = newYorkDate(new Date(nowMs));
  let high = -Infinity;
  let low = Infinity;
  let count = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!Number.isFinite(bar.t) || bar.t > nowMs) continue;
    if (newYorkDate(new Date(bar.t)) !== today) continue;
    const minutes = nyMinutes(bar.t);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    if (!(bar.h > 0) || !(bar.l > 0) || !Number.isFinite(bar.h) || !Number.isFinite(bar.l) || bar.h < bar.l) continue;
    if (bar.h > high) high = bar.h;
    if (bar.l < low) low = bar.l;
    count += 1;
  }
  if (count === 0 || !(high >= low)) return null;
  const range = high - low;
  return Number.isFinite(range) && range >= 0 ? range : null;
}

/** atr_used = today's range / ATR14. Null when either input is missing. */
export function jgAtrUsed(todayRange: number | null, atr14: number | null): number | null {
  if (todayRange == null || atr14 == null) return null;
  if (!(todayRange >= 0) || !Number.isFinite(todayRange) || !(atr14 > 0) || !Number.isFinite(atr14)) return null;
  const used = todayRange / atr14;
  return Number.isFinite(used) && used >= 0 ? used : null;
}

/**
 * Suggested dollars. A missing ATR is $300 for both variants.
 * 0DTE is $250 whenever ATR used is known. 1DTE is $875 inside the inclusive
 * band and $300 outside it.
 */
export function jgSuggestedSize(atrUsed: number | null, dte: JgDte = "0DTE"): number {
  if (atrUsed == null || !Number.isFinite(atrUsed) || atrUsed < 0) return JG_VWAP_SIZE_UNKNOWN_DOLLARS;
  if (dte === "1DTE") {
    if (atrUsed >= JG_VWAP_ATR_BAND_LOW && atrUsed <= JG_VWAP_ATR_BAND_HIGH) return JG_VWAP_BUDGET_DOLLARS;
    return JG_VWAP_SIZE_UNKNOWN_DOLLARS;
  }
  return JG_VWAP_SIZE_0DTE_DOLLARS;
}

export function formatAtrUsed(atrUsed: number | null): string {
  if (atrUsed == null || !Number.isFinite(atrUsed) || atrUsed < 0) return "unknown";
  const pct = Math.round(atrUsed * 1000) / 10;
  return Number.isInteger(pct) ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
}

export function formatAtrLine(atrUsed: number | null, suggestedSize: number): string {
  const size = Number.isFinite(suggestedSize) && suggestedSize > 0 ? suggestedSize : JG_VWAP_SIZE_UNKNOWN_DOLLARS;
  return `ATR used: ${formatAtrUsed(atrUsed)} | Suggested size: $${Math.round(size)}`;
}

/** True when the bid/ask is wider than 10% of the mid. A spread equal to 10% is kept. */
export function jgSpreadTooWide(bid: number, ask: number): boolean {
  if (!(ask > 0) || !(bid >= 0) || !Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return true;
  const mid = (ask + bid) / 2;
  if (!(mid > 0)) return true;
  return (ask - bid) / mid > JG_VWAP_TEST.maxSpreadOfMid + 1e-12;
}

/** Prior close × (VXN or VIX / 100) / sqrt(252). volIndex is the index level, such as 18.5. */
export function jgImpliedMove(priorClose: number, volIndex: number): number | null {
  if (!(priorClose > 0) || !(volIndex > 0) || !Number.isFinite(priorClose) || !Number.isFinite(volIndex)) return null;
  const move = priorClose * (volIndex / 100) / Math.sqrt(252);
  return move > 0 && Number.isFinite(move) ? move : null;
}

export function jgStopUnderlying(putCall: PutCall, entry: number, move: number): number | null {
  if (!(entry > 0) || !(move > 0)) return null;
  const distance = JG_VWAP_TEST.stopFractionOfImpliedMove * move;
  const stop = putCall === "call" ? entry - distance : entry + distance;
  if (!Number.isFinite(stop) || stop <= 0) return null;
  return stop;
}

export function jgVwapPnl(ask: number, bid: number, contracts: number): number {
  const gross = (bid - ask) * 100 * contracts;
  const fees = JG_VWAP_TEST.feePerSide * 2 * contracts;
  return roundCents(gross - fees);
}

export function jgSessionVwap(bars: readonly CandleBar[], nowMs: number): { vwap: number; close: number } | null {
  if (!Number.isFinite(nowMs)) return null;
  const today = newYorkDate(new Date(nowMs));
  const session = completedSessionMinutes(bars, nowMs).filter((bar) => newYorkDate(new Date(bar.t)) === today);
  if (session.length === 0) return null;
  let weighted = 0;
  let volume = 0;
  for (let i = 0; i < session.length; i++) {
    const bar = session[i];
    const typical = (bar.h + bar.l + bar.c) / 3;
    if (!Number.isFinite(typical) || !(typical > 0)) continue;
    const weight = bar.v != null && Number.isFinite(bar.v) && bar.v >= 1 ? bar.v : 1;
    weighted += typical * weight;
    volume += weight;
  }
  if (!(volume > 0)) return null;
  const close = session[session.length - 1].c;
  if (!(close > 0)) return null;
  return { vwap: weighted / volume, close };
}

export interface JgVwapTrade {
  id: string;
  ticker: JgTicker;
  /** 0DTE expires the entry day. 1DTE expires the next trading day. Legacy rows are 0DTE. */
  dte: JgDte;
  root: string;
  putCall: PutCall;
  strike: number;
  expiration: string;
  openedAt: number;
  /** Contracts at the suggested size. Zero is stored and not scored. */
  contracts: number;
  /** Contracts at the flat $875 size. Always at least 1 when the trade is logged. */
  budgetContracts: number;
  overBudget: boolean;
  /** Null when ATR used could not be computed. Legacy rows are also null. */
  atrUsed: number | null;
  /** Dollars. Null on a row saved before suggested sizing. */
  suggestedSize: number | null;
  entryAsk: number;
  entryBid: number;
  entryUnderlying: number;
  vwap: number;
  /** Retest level. Null on a row saved before the backtest entry. */
  level: number | null;
  iv: number;
  impliedMove: number;
  stopUnderlying: number;
  status: "open" | "closed";
  closedAt: number | null;
  exitBid: number | null;
  exitReason: "stop" | "flat" | null;
  /** Suggested-size P/L. Null while open, and null when the suggested size buys zero contracts. */
  pnlDollars: number | null;
  /** Flat $875 P/L. Null while open. Legacy rows copy pnlDollars. */
  pnlBudgetDollars: number | null;
}

export interface JgVwapBook {
  version: 1;
  trades: JgVwapTrade[];
  /** Last chain root that returned SPX contracts. Null until one does. */
  spxRoot: "SPX" | "SPXW" | null;
  /** Latest run found neither an SPX nor an SPXW chain. */
  spxUnavailable: boolean;
  /** Latest run had no SPX session VWAP from 1-minute candles. */
  spxVwapMiss: boolean;
  /** Latest run had a 1DTE signal but no contract for the next trading day. Empty when none. */
  oneDteNote: string;
}

export interface JgSnapshot {
  ticker: JgTicker;
  root: string | null;
  spot: number | null;
  vwap: number | null;
  contracts: readonly OptionContract[];
  /** Null when today's range or ATR14 is missing. */
  atrUsed: number | null;
  /** Backtest signal for this pass. Null when there is nothing to paper. */
  signal: JgSignal | null;
  /** Why this pass did not signal, including a VWAP rejection. */
  signalNote: string;
  /** Today's 5-minute bars, used to see if the implied-move stop traded. */
  bars?: readonly CandleBar[];
}

export interface JgRunMeta {
  /** Chain root that worked on this run. Null when both SPX and SPXW missed. */
  spxRoot: "SPX" | "SPXW" | null;
  spxChainMiss: boolean;
  spxVwapMiss: boolean;
}

export function emptyJgVwapBook(): JgVwapBook {
  return { version: 1, trades: [], spxRoot: null, spxUnavailable: false, spxVwapMiss: false, oneDteNote: "" };
}

export function serializeJgVwapBook(book: JgVwapBook): string {
  return JSON.stringify({
    version: 1,
    trades: book.trades,
    spxRoot: book.spxRoot,
    spxUnavailable: book.spxUnavailable,
    spxVwapMiss: book.spxVwapMiss,
    oneDteNote: book.oneDteNote,
  });
}

export function parseJgVwapBook(text: string | null | undefined): JgVwapBook {
  if (!text) return emptyJgVwapBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyJgVwapBook();
  }
  const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  if (!row || !Array.isArray(row.trades)) return emptyJgVwapBook();
  const trades: JgVwapTrade[] = [];
  for (let i = 0; i < row.trades.length; i++) {
    const trade = parseTrade(row.trades[i]);
    if (trade) trades.push(trade);
  }
  const spxRoot = row.spxRoot === "SPX" || row.spxRoot === "SPXW" ? row.spxRoot : null;
  return {
    version: 1,
    trades: trimTrades(trades),
    spxRoot,
    spxUnavailable: row.spxUnavailable === true,
    spxVwapMiss: row.spxVwapMiss === true,
    oneDteNote: typeof row.oneDteNote === "string" ? row.oneDteNote.slice(0, 400) : "",
  };
}

export interface JgOneDteSkip {
  ticker: JgTicker;
  expiration: string;
}

export function advanceJgVwap(
  book: JgVwapBook,
  snapshots: readonly JgSnapshot[],
  now: Date,
  meta?: JgRunMeta,
): { book: JgVwapBook; opened: JgVwapTrade[]; closed: JgVwapTrade[]; oneDteSkips: JgOneDteSkip[] } {
  if (!jgVwapSessionOpen(now)) return { book, opened: [], closed: [], oneDteSkips: [] };
  const day = newYorkDate(now);
  const nextDay = jgNextTradingDay(day);
  const exitMinute = jgFlatExitMinute(day);
  const minutes = nyMinutes(now.getTime());
  const byTicker = new Map<JgTicker, JgSnapshot>();
  for (let i = 0; i < snapshots.length; i++) byTicker.set(snapshots[i].ticker, snapshots[i]);
  const closed: JgVwapTrade[] = [];
  const opened: JgVwapTrade[] = [];
  const oneDteSkips: JgOneDteSkip[] = [];
  let trades = book.trades.map((trade) => ({ ...trade }));

  for (let i = 0; i < JG_VWAP_TICKERS.length; i++) {
    const ticker = JG_VWAP_TICKERS[i];
    const snap = byTicker.get(ticker) ?? null;
    trades = trades.map((trade) => {
      if (trade.ticker !== ticker || trade.status !== "open") return trade;
      const next = markOpen(trade, snap, now, day, minutes);
      if (next.status === "closed" && trade.status === "open") closed.push(next);
      return next;
    });
    if (minutes >= exitMinute) continue;
    if (!enteredToday(trades, ticker, "0DTE", day)) {
      const trade = openTrade(ticker, snap, now, day, "0DTE", day);
      if (trade) {
        trades.push(trade);
        opened.push(trade);
      }
    }
    if (nextDay && !enteredToday(trades, ticker, "1DTE", day)) {
      const side = snap?.signal?.vwapOk ? snap.signal.direction : null;
      if (side && !listedExpiry(snap?.contracts ?? [], nextDay)) {
        oneDteSkips.push({ ticker, expiration: nextDay });
      } else {
        const trade = openTrade(ticker, snap, now, day, "1DTE", nextDay);
        if (trade) {
          trades.push(trade);
          opened.push(trade);
        }
      }
    }
  }

  return {
    book: {
      version: 1,
      trades: trimTrades(trades),
      spxRoot: meta ? (meta.spxRoot ?? book.spxRoot) : book.spxRoot,
      spxUnavailable: meta ? meta.spxChainMiss : book.spxUnavailable,
      spxVwapMiss: meta ? meta.spxVwapMiss : book.spxVwapMiss,
      oneDteNote: oneDteSkipNote(oneDteSkips),
    },
    opened,
    closed,
    oneDteSkips,
  };
}

export interface JgVwapBucket {
  key: "QQQ" | "SPX" | "SPX-over-budget";
  label: string;
  trades: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  pnlBudget: number;
  budgetTrades: number;
  pnlWithoutTop3: number | null;
  maxDrawdownDollars: number;
  maxDrawdownVsAccount: number;
}

export interface JgVwapSection {
  label: string;
  note: string;
  trustNote: string;
  tooFew: boolean;
  targetSample: number;
  budgetDollars: number;
  accountDollars: number;
  spxRoot: "SPX" | "SPXW" | null;
  spxUnavailable: boolean;
  spxVwapMiss: boolean;
  buckets: JgVwapBucket[];
  byDte: JgDteSummary[];
  oneDteNote: string;
  rows: JgVwapTrade[];
  /** Closed trades in time order. Running totals for the scorecard chart. */
  pnlSeries: JgPnlPoint[];
}

export interface JgDteSummary {
  dte: JgDte;
  trades: number;
  open: number;
  pnl: number;
  pnlBudget: number;
  budgetTrades: number;
}

export interface JgPnlPoint {
  at: number;
  /** Running suggested-size P/L for both variants. Null until the first scored trade. */
  suggested: number | null;
  /** Running flat $875 P/L for both variants. */
  budget: number | null;
  suggested0: number | null;
  budget0: number | null;
  suggested1: number | null;
  budget1: number | null;
}

export function jgVwapSection(book: JgVwapBook): JgVwapSection {
  const qqq = bucketOf(book.trades, "QQQ", "QQQ", (trade) => trade.ticker === "QQQ" && !trade.overBudget);
  const spx = bucketOf(book.trades, "SPX", "SPX", (trade) => trade.ticker === "SPX" && !trade.overBudget);
  const over = bucketOf(
    book.trades,
    "SPX-over-budget",
    "SPX over budget",
    (trade) => trade.ticker === "SPX" && trade.overBudget,
  );
  const closedAll = book.trades.filter((trade) => suggestedPnl(trade) != null).length;
  return {
    label: JG_VWAP_TEST.label,
    note: sectionNote(book),
    trustNote: trustNote(closedAll),
    tooFew: closedAll < JG_VWAP_TEST.minTrust,
    targetSample: JG_VWAP_TEST.minTrust,
    budgetDollars: JG_VWAP_BUDGET_DOLLARS,
    accountDollars: DEFAULT_ACCOUNT_SIZE_DOLLARS,
    spxRoot: book.spxRoot,
    spxUnavailable: book.spxUnavailable,
    spxVwapMiss: book.spxVwapMiss,
    buckets: [qqq, spx, over],
    byDte: [dteSummary(book.trades, "0DTE"), dteSummary(book.trades, "1DTE")],
    oneDteNote: book.oneDteNote,
    rows: book.trades.slice().sort((a, b) => b.openedAt - a.openedAt).slice(0, 24),
    pnlSeries: jgVwapPnlSeries(book.trades),
  };
}

/** Cumulative P/L after each close. Suggested size skips a zero-contract trade. $875 does not. */
export function jgVwapPnlSeries(trades: readonly JgVwapTrade[]): JgPnlPoint[] {
  const closed = trades.filter((trade) => trade.status === "closed" && trade.closedAt != null);
  closed.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.id.localeCompare(b.id));
  const suggested = freshRun();
  const budget = freshRun();
  const suggested0 = freshRun();
  const budget0 = freshRun();
  const suggested1 = freshRun();
  const budget1 = freshRun();
  const points: JgPnlPoint[] = [];
  for (let i = 0; i < closed.length; i++) {
    const trade = closed[i];
    const suggestedPnlValue = suggestedPnl(trade);
    const budgetPnlValue = budgetPnl(trade);
    if (suggestedPnlValue == null && budgetPnlValue == null) continue;
    const one = tradeDte(trade) === "1DTE";
    points.push({
      at: trade.closedAt as number,
      suggested: bumpRun(suggested, suggestedPnlValue),
      budget: bumpRun(budget, budgetPnlValue),
      suggested0: bumpRun(suggested0, one ? null : suggestedPnlValue),
      budget0: bumpRun(budget0, one ? null : budgetPnlValue),
      suggested1: bumpRun(suggested1, one ? suggestedPnlValue : null),
      budget1: bumpRun(budget1, one ? budgetPnlValue : null),
    });
  }
  return points;
}

export function formatJgVwapAlert(trade: JgVwapTrade): string {
  const right = trade.putCall.toUpperCase();
  const budget = JG_VWAP_BUDGET_DOLLARS.toFixed(0);
  const stopWord = trade.putCall === "call" ? "at or below" : "at or above";
  const suggestedSize = trade.suggestedSize != null && trade.suggestedSize > 0
    ? trade.suggestedSize
    : JG_VWAP_SIZE_UNKNOWN_DOLLARS;
  const atrLine = formatAtrLine(trade.atrUsed, suggestedSize);
  const over = trade.overBudget
    ? `\n<b>Over budget.</b> One contract costs more than $${budget}. Logged as 1 contract${trade.ticker === "SPX" ? ", in the SPX over-budget scorecard bucket" : ", and left out of the QQQ totals"}.`
    : "";
  const root = trade.root !== trade.ticker ? `\nContract root <b>${escapeHtml(trade.root)}</b>.` : "";
  const variant = tradeDte(trade);
  const buy = trade.contracts >= 1
    ? `Buy <b>${trade.contracts}</b> at the ask $${trimPrice(trade.entryAsk)} (bid $${trimPrice(trade.entryBid)}). Flat $${budget} sizing would buy <b>${trade.budgetContracts}</b>.`
    : `Suggested size $${Math.round(suggestedSize)} does not cover one contract at the ask $${trimPrice(trade.entryAsk)}, so the ATR-sized paper P/L is not scored. Flat $${budget} sizing would buy <b>${trade.budgetContracts}</b>.`;
  const exitLine = "If it is still open, sell at the bid by 3:45 PM ET the same day (1:00 PM ET on an early close).";
  return `<b>PAPER TEST - JG-VWAP ${variant}</b>
${escapeHtml(trade.ticker)} <b>${right}</b> · $${trimPrice(trade.strike)} exp ${escapeHtml(trade.expiration)}
Paper only. This is not an A or a B, and it is outside the daily A/B alert cap. No order is placed.${over}

${atrLine}
${buy}
Underlying $${trimPrice(trade.entryUnderlying)} vs session VWAP $${trimPrice(trade.vwap)}. Level $${trimPrice(trade.level ?? trade.vwap)}.
Stop if the underlying trades ${stopWord} $${trimPrice(trade.stopUnderlying)} (0.75× the day's implied move from the prior close and the vol index).
${exitLine}${root}`;
}

function openTrade(
  ticker: JgTicker,
  snap: JgSnapshot | null,
  now: Date,
  entryDay: string,
  dte: JgDte,
  expiration: string,
): JgVwapTrade | null {
  const signal = snap?.signal;
  if (!snap || snap.root == null || !signal || !signal.vwapOk) return null;
  if (!(signal.entry > 0) || !(signal.vwap > 0) || !(signal.stop > 0)) return null;
  const side = signal.direction;
  const contract = pickExpiry(snap.contracts, side, expiration, signal.entry);
  if (!contract) return null;
  const atrUsed = signal.atrUsed;
  const suggestedSize = jgSuggestedSize(atrUsed, dte);
  const suggestedContracts = jgContractsForSize(contract.ask, suggestedSize);
  const size = jgVwapSize(contract.ask);
  if (suggestedContracts == null || !size) return null;
  return {
    id: `jgvwap-${ticker}-${dte}-${entryDay}`,
    ticker,
    dte,
    root: snap.root,
    putCall: side,
    strike: contract.strike,
    expiration,
    openedAt: signal.signalAt > 0 ? signal.signalAt : now.getTime(),
    contracts: suggestedContracts,
    budgetContracts: size.contracts,
    overBudget: size.overBudget,
    atrUsed,
    suggestedSize,
    entryAsk: contract.ask,
    entryBid: contract.bid,
    entryUnderlying: signal.entry,
    vwap: signal.vwap,
    level: signal.level,
    iv: signal.volIndex / 100,
    impliedMove: signal.impliedMove,
    stopUnderlying: signal.stop,
    status: "open",
    closedAt: null,
    exitBid: null,
    exitReason: null,
    pnlDollars: null,
    pnlBudgetDollars: null,
  };
}

function markOpen(
  trade: JgVwapTrade,
  snap: JgSnapshot | null,
  now: Date,
  day: string,
  minutes: number,
): JgVwapTrade {
  const expired = trade.expiration < day;
  const quote = snap ? findQuote(snap.contracts, trade) : null;
  const spot = snap?.spot != null && snap.spot > 0 ? snap.spot : null;
  const stopped = (spot != null && hitStop(trade, spot)) || barsHitStop(trade, snap?.bars);
  // Both variants exit the entry session. A later session closes anything still open.
  const flatDue = minutes >= jgFlatExitMinute(day) || entryDayOf(trade) < day;
  if (!expired && !stopped && !flatDue) return trade;
  if (!expired && !quote) return trade;
  const bid = quote && quote.bid >= 0 ? quote.bid : 0;
  const reason = stopped ? "stop" : "flat";
  const budgetContracts = trade.budgetContracts >= 1
    ? trade.budgetContracts
    : trade.suggestedSize == null && trade.contracts >= 1
      ? trade.contracts
      : 0;
  return {
    ...trade,
    status: "closed",
    closedAt: now.getTime(),
    exitBid: bid,
    exitReason: reason,
    pnlDollars: trade.contracts >= 1 ? jgVwapPnl(trade.entryAsk, bid, trade.contracts) : null,
    pnlBudgetDollars: budgetContracts >= 1 ? jgVwapPnl(trade.entryAsk, bid, budgetContracts) : null,
  };
}

function hitStop(trade: JgVwapTrade, spot: number): boolean {
  return trade.putCall === "call" ? spot <= trade.stopUnderlying : spot >= trade.stopUnderlying;
}

function barsHitStop(trade: JgVwapTrade, bars: readonly CandleBar[] | undefined): boolean {
  if (!bars) return false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.t + 5 * 60_000 < trade.openedAt - 60_000) continue;
    if (trade.putCall === "call" && bar.l <= trade.stopUnderlying) return true;
    if (trade.putCall === "put" && bar.h >= trade.stopUnderlying) return true;
  }
  return false;
}

function pickExpiry(
  contracts: readonly OptionContract[],
  side: PutCall,
  expiration: string,
  spot: number,
): OptionContract | null {
  const same = contracts.filter((contract) => (
    contract.putCall === side
    && contract.expiration === expiration
    && contract.strike > 0
    && contract.ask > 0
    && contract.bid >= 0
    && !jgSpreadTooWide(contract.bid, contract.ask)
  ));
  if (same.length === 0) return null;
  same.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  return same[0];
}

function contractIv(contracts: readonly OptionContract[], chosen: OptionContract): number | null {
  if (chosen.iv != null && chosen.iv > 0) return chosen.iv;
  const sameStrike = contracts.find((contract) => (
    contract.expiration === chosen.expiration
    && contract.strike === chosen.strike
    && contract.iv != null
    && contract.iv > 0
  ));
  if (sameStrike?.iv != null && sameStrike.iv > 0) return sameStrike.iv;
  let best: OptionContract | null = null;
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    if (contract.expiration !== chosen.expiration || contract.iv == null || !(contract.iv > 0)) continue;
    if (!best || Math.abs(contract.strike - chosen.strike) < Math.abs(best.strike - chosen.strike)) best = contract;
  }
  return best?.iv != null && best.iv > 0 ? best.iv : null;
}

function findQuote(contracts: readonly OptionContract[], trade: JgVwapTrade): OptionContract | null {
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    if (contract.putCall !== trade.putCall) continue;
    if (contract.expiration !== trade.expiration) continue;
    if (contract.strike !== trade.strike) continue;
    if (!(contract.bid >= 0) || !Number.isFinite(contract.bid)) continue;
    return contract;
  }
  return null;
}

function bucketOf(
  trades: readonly JgVwapTrade[],
  key: JgVwapBucket["key"],
  label: string,
  keep: (trade: JgVwapTrade) => boolean,
): JgVwapBucket {
  const rows = trades.filter(keep);
  const closed = rows.filter((trade) => suggestedPnl(trade) != null);
  const ordered = closed.slice().sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const pnls = ordered.map((trade) => suggestedPnl(trade) as number);
  const budgetPnls = rows
    .filter((trade) => budgetPnl(trade) != null)
    .slice()
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
    .map((trade) => budgetPnl(trade) as number);
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  for (let i = 0; i < pnls.length; i++) {
    pnl += pnls[i];
    if (pnls[i] > 0) wins += 1;
    else if (pnls[i] < 0) losses += 1;
  }
  const decided = wins + losses;
  const drawdown = maxDrawdown(pnls, DEFAULT_ACCOUNT_SIZE_DOLLARS);
  return {
    key,
    label,
    trades: closed.length,
    open: rows.filter((trade) => trade.status === "open").length,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : null,
    pnl: roundCents(pnl),
    pnlBudget: roundCents(budgetPnls.reduce((sum, value) => sum + value, 0)),
    budgetTrades: budgetPnls.length,
    pnlWithoutTop3: pnlWithoutTop(pnls, 3),
    maxDrawdownDollars: drawdown.dollars,
    maxDrawdownVsAccount: drawdown.fraction,
  };
}

function maxDrawdown(pnls: readonly number[], account: number): { dollars: number; fraction: number } {
  let equity = account;
  let peak = account;
  let max = 0;
  for (let i = 0; i < pnls.length; i++) {
    equity += pnls[i];
    if (equity > peak) peak = equity;
    const drop = peak - equity;
    if (drop > max) max = drop;
  }
  return {
    dollars: roundCents(max),
    fraction: account > 0 ? max / account : 0,
  };
}

function pnlWithoutTop(pnls: readonly number[], drop: number): number | null {
  if (pnls.length <= drop) return null;
  const sorted = pnls.slice().sort((a, b) => b - a);
  let sum = 0;
  for (let i = drop; i < sorted.length; i++) sum += sorted[i];
  return roundCents(sum);
}

function trustNote(closed: number): string {
  if (closed < JG_VWAP_TEST.minTrust) {
    return `${closed} closed paper trades scored at the suggested size. Fewer than ${JG_VWAP_TEST.minTrust} is too few to read as a result.`;
  }
  return `${closed} closed paper trades scored at the suggested size. That is enough to describe. It does not change a live alert or an exit.`;
}

function sectionNote(book: JgVwapBook): string {
  const budget = JG_VWAP_BUDGET_DOLLARS;
  const known = JG_VWAP_SIZE_0DTE_DOLLARS;
  const unknown = JG_VWAP_SIZE_UNKNOWN_DOLLARS;
  const spx = spxNote(book);
  return `${JG_VWAP_TEST.label}. These rows are left out of the A and B totals above. Each entry sends a Telegram message labeled PAPER TEST - JG-VWAP 0DTE or PAPER TEST - JG-VWAP 1DTE, and that message is outside the daily A/B cap. QQQ uses VXN and SPX uses VIX. One 0DTE and one 1DTE paper entry per ticker per day. 0DTE expires that day. 1DTE uses the next trading day's expiry, skipping weekends and full-day NYSE holidays. Both close the same day, at the implied-move stop or at 3:45 PM ET (1:00 PM ET on an early close). If that next-day expiry is not in the chain, 1DTE is skipped and the scan log says so. The logged strike is the nearest strike of that expiry whose spread is within ${JG_VWAP_TEST.maxSpreadOfMid * 100}% of the mid. Buy at the ask, sell at the bid, $${JG_VWAP_TEST.feePerSide.toFixed(2)} a contract each side. ATR used is today's high minus today's low so far, divided by the 14-day average true range of completed daily bars. 0DTE suggested size is $${known} when ATR used is known. 1DTE suggested size is $${budget} when ATR used is from ${JG_VWAP_ATR_BAND_LOW} through ${JG_VWAP_ATR_BAND_HIGH}, and $${unknown} otherwise. Both use $${unknown} when ATR cannot be computed. Scored contracts are floor(suggested size / (ask × 100)). A size that buys zero contracts is not scored. The flat $${budget} size stays as a comparison: floor(${budget} / (ask × 100)), and a contract above $${budget} is logged as 1 and flagged over budget. Over-budget SPX stays in its own bucket. Over-budget QQQ is flagged on the row and left out of the QQQ totals. The stop is ${JG_VWAP_TEST.stopFractionOfImpliedMove}× the implied move (prior close × VXN or VIX / 100 / sqrt(252)) against the 5-minute close. Direction is prior-day EMA8/EMA21 agreeing with the last completed week. The entry is the first 5-minute retest of an hourly pivot break between 9:45 and 14:30 ET, with close×volume VWAP still on the trade side (aligned distance at least -0.10). Anything still open is sold at the bid at 3:45 PM ET the same day, or at 1:00 PM ET on an NYSE early close. Full-day NYSE holidays are skipped. Market hours only. No order is placed. ${spx}`;
}

function spxNote(book: JgVwapBook): string {
  const root = book.spxRoot === "SPXW"
    ? "SPX option contracts are read on the SPXW root."
    : book.spxRoot === "SPX"
      ? "SPX option contracts are read on the SPX symbol."
      : "SPX has not returned a chain yet.";
  const chain = book.spxUnavailable
    ? " The latest run found no SPX chain and no SPXW chain, so a new SPX entry waits. QQQ still logs."
    : "";
  const vwap = book.spxVwapMiss
    ? " The latest run had no SPX 1-minute candles, so session VWAP for SPX was missing and a new SPX entry waits."
    : "";
  return `${root}${chain}${vwap}`;
}

function trimTrades(trades: JgVwapTrade[]): JgVwapTrade[] {
  if (trades.length <= ROW_CAP) return trades;
  const drop = new Set<string>();
  let extra = trades.length - ROW_CAP;
  const closed = trades.filter((trade) => trade.status === "closed").slice().sort((a, b) => a.openedAt - b.openedAt);
  for (let i = 0; i < closed.length && extra > 0; i++) {
    drop.add(closed[i].id);
    extra -= 1;
  }
  return trades.filter((trade) => !drop.has(trade.id));
}

function parseTrade(value: unknown): JgVwapTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const ticker = row.ticker === "QQQ" || row.ticker === "SPX" ? row.ticker : null;
  if (!ticker) return null;
  const putCall = row.putCall === "call" || row.putCall === "put" ? row.putCall : null;
  if (!putCall) return null;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const idDte = dteFromId(id);
  if (idDte === undefined) return null;
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  const strike = asPositive(row.strike);
  const openedAt = asTime(row.openedAt);
  const suggestedSize = row.suggestedSize == null ? null : asPositive(row.suggestedSize);
  if (row.suggestedSize != null && suggestedSize == null) return null;
  const atrUsed = row.atrUsed == null ? null : asNonNegative(row.atrUsed);
  if (row.atrUsed != null && atrUsed == null) return null;
  const contracts = suggestedSize == null ? asWhole(row.contracts) : asCount(row.contracts);
  const entryAsk = asPositive(row.entryAsk);
  const entryBid = asNonNegative(row.entryBid);
  const entryUnderlying = asPositive(row.entryUnderlying);
  const vwap = asPositive(row.vwap);
  const level = row.level == null ? null : asPositive(row.level);
  if (row.level != null && level == null) return null;
  const iv = asPositive(row.iv);
  const impliedMove = asPositive(row.impliedMove);
  const stopUnderlying = asPositive(row.stopUnderlying);
  if (
    strike == null || openedAt == null || contracts == null || entryAsk == null || entryBid == null
    || entryUnderlying == null || vwap == null || iv == null || impliedMove == null || stopUnderlying == null
  ) return null;
  const status = row.status === "closed" ? "closed" : row.status === "open" ? "open" : null;
  if (!status || contracts == null) return null;
  const closedAt = row.closedAt == null ? null : asTime(row.closedAt);
  const exitBid = row.exitBid == null ? null : asNonNegative(row.exitBid);
  const exitReason = row.exitReason === "stop" || row.exitReason === "flat" ? row.exitReason : null;
  const pnlDollars = row.pnlDollars == null ? null : asFinite(row.pnlDollars);
  let budgetContracts = row.budgetContracts == null ? null : asWhole(row.budgetContracts);
  if (row.budgetContracts != null && budgetContracts == null) return null;
  if (budgetContracts == null) {
    if (suggestedSize == null && contracts >= 1) budgetContracts = contracts;
    else return null;
  }
  let pnlBudgetDollars = row.pnlBudgetDollars == null ? null : asFinite(row.pnlBudgetDollars);
  if (row.pnlBudgetDollars != null && pnlBudgetDollars == null) return null;
  if (status === "open" && (closedAt != null || exitBid != null || exitReason != null || pnlDollars != null || pnlBudgetDollars != null)) return null;
  if (status === "closed" && (closedAt == null || exitBid == null || exitReason == null)) return null;
  if (status === "closed" && contracts >= 1 && pnlDollars == null) return null;
  if (status === "closed" && contracts === 0 && pnlDollars != null) return null;
  if (status === "closed" && pnlBudgetDollars == null && suggestedSize == null && pnlDollars != null) pnlBudgetDollars = pnlDollars;
  if (status === "closed" && suggestedSize != null && pnlBudgetDollars == null) return null;
  const fieldDte = row.dte == null ? null : row.dte === "0DTE" || row.dte === "1DTE" ? row.dte : null;
  if (row.dte != null && fieldDte == null) return null;
  if (idDte && fieldDte && idDte !== fieldDte) return null;
  const dte: JgDte = idDte ?? fieldDte ?? "0DTE";
  const root = typeof row.root === "string" && row.root.trim() ? row.root.trim().toUpperCase() : ticker;
  return {
    id,
    ticker,
    dte,
    root,
    putCall,
    strike,
    expiration,
    openedAt,
    contracts,
    budgetContracts,
    overBudget: row.overBudget === true,
    atrUsed,
    suggestedSize,
    entryAsk,
    entryBid,
    entryUnderlying,
    vwap,
    level,
    iv,
    impliedMove,
    stopUnderlying,
    status,
    closedAt,
    exitBid,
    exitReason,
    pnlDollars,
    pnlBudgetDollars,
  };
}

function dteFromId(id: string): JgDte | null | undefined {
  if (/^jgvwap-(QQQ|SPX)-(0DTE|1DTE)-\d{4}-\d{2}-\d{2}$/.test(id)) return id.includes("-1DTE-") ? "1DTE" : "0DTE";
  if (/^jgvwap-(QQQ|SPX)-\d{4}-\d{2}-\d{2}$/.test(id)) return null;
  return undefined;
}

function tradeDte(trade: JgVwapTrade): JgDte {
  return trade.dte === "1DTE" ? "1DTE" : "0DTE";
}

function entryDayOf(trade: JgVwapTrade): string {
  return trade.id.slice(-10);
}

function enteredToday(trades: readonly JgVwapTrade[], ticker: JgTicker, dte: JgDte, day: string): boolean {
  return trades.some((trade) => trade.ticker === ticker && tradeDte(trade) === dte && entryDayOf(trade) === day);
}

function listedExpiry(contracts: readonly OptionContract[], expiration: string): boolean {
  for (let i = 0; i < contracts.length; i++) {
    if (contracts[i].expiration === expiration) return true;
  }
  return false;
}

function oneDteSkipNote(skips: readonly JgOneDteSkip[]): string {
  if (skips.length === 0) return "";
  const expiration = skips[0].expiration;
  const names = skips.map((skip) => skip.ticker).join(" and ");
  return `1DTE skipped for ${names}: no contract expiring ${expiration}.`;
}

function dteSummary(trades: readonly JgVwapTrade[], dte: JgDte): JgDteSummary {
  const rows = trades.filter((trade) => tradeDte(trade) === dte);
  let pnl = 0;
  let pnlBudget = 0;
  let scored = 0;
  let budgetTrades = 0;
  for (let i = 0; i < rows.length; i++) {
    const suggested = suggestedPnl(rows[i]);
    const budget = budgetPnl(rows[i]);
    if (suggested != null) {
      pnl += suggested;
      scored += 1;
    }
    if (budget != null) {
      pnlBudget += budget;
      budgetTrades += 1;
    }
  }
  return {
    dte,
    trades: scored,
    open: rows.filter((trade) => trade.status === "open").length,
    pnl: roundCents(pnl),
    pnlBudget: roundCents(pnlBudget),
    budgetTrades,
  };
}

function freshRun(): { value: number; seen: boolean } {
  return { value: 0, seen: false };
}

function bumpRun(run: { value: number; seen: boolean }, pnl: number | null): number | null {
  if (pnl != null) {
    run.value += pnl;
    run.seen = true;
  }
  return run.seen ? roundCents(run.value) : null;
}

function suggestedPnl(trade: JgVwapTrade): number | null {
  if (trade.status !== "closed" || trade.suggestedSize == null || trade.contracts < 1 || trade.pnlDollars == null) return null;
  return trade.pnlDollars;
}

function budgetPnl(trade: JgVwapTrade): number | null {
  if (trade.status !== "closed") return null;
  if (trade.pnlBudgetDollars != null) return trade.pnlBudgetDollars;
  if (trade.suggestedSize == null && trade.pnlDollars != null) return trade.pnlDollars;
  return null;
}

function normalizeAtrUsed(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function usableDailyBar(bar: CandleBar): boolean {
  return bar.h > 0 && bar.l > 0 && bar.c > 0
    && Number.isFinite(bar.h) && Number.isFinite(bar.l) && Number.isFinite(bar.c)
    && bar.h >= bar.l;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function trimPrice(value: number): string {
  const rounded = roundCents(value);
  return Number.isInteger(rounded) ? rounded.toFixed(2) : String(rounded);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function asPositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asWhole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
