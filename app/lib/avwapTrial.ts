import type { CandleBar } from "@/app/lib/candleTypes";
import { calendarDaysBetween, newYorkDate } from "@/app/lib/flow";
import { chicagoDate } from "@/app/lib/marketHours";
import { schwabOptionSymbol } from "@/app/lib/optionSymbol";
import {
  AVWAP_BUDGET_DOLLARS,
  AVWAP_DAILY_STOP_LOSSES,
  AVWAP_FEE_PER_SIDE,
  AVWAP_GAP_FRACTION,
  AVWAP_PRIMARY_DTE_MAX,
  AVWAP_PRIMARY_DTE_MIN,
  AVWAP_PRIMARY_DTE_TARGET,
  AVWAP_SYMBOLS,
  AVWAP_TARGET_FRACTION,
  atmStrike,
  avwapContractCount,
  avwapPnl,
  avwapPoints,
  avwapSkipReason,
  bidHitsTarget,
  expiryCandidates,
  isExpiryFinalScan,
  latestAvwapCross,
  latestGapDay,
  signalIsFresh,
  type AvwapDailyBar,
  type AvwapSignal,
} from "@/app/lib/avwapPaper";

/**
 * Paper trial for AMD, MSFT, and AMZN. Puts and calls.
 * This book is not the live seven-name AVWAP log.
 */

export const AVWAP_TRIAL_SYMBOLS = ["AMD", "MSFT", "AMZN"] as const;
export type AvwapTrialSymbol = (typeof AVWAP_TRIAL_SYMBOLS)[number];
export type AvwapTrialSide = "put" | "call";
export type AvwapTrialOutcome = "checked" | "no-gap" | "no-signal" | "entered" | "skipped" | "data-error";

export interface AvwapTrialTrade {
  id: string;
  symbol: AvwapTrialSymbol;
  putCall: AvwapTrialSide;
  strike: number;
  expiration: string;
  dte: number;
  contracts: number;
  openedAt: number;
  signalAt: number;
  anchorDate: string;
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
}

export interface AvwapTrialSideCheck {
  outcome: AvwapTrialOutcome;
  reason: string;
}

export interface AvwapTrialSymbolCheck {
  at: number;
  put: AvwapTrialSideCheck;
  call: AvwapTrialSideCheck;
}

export interface AvwapTrialSkip {
  id: string;
  symbol: AvwapTrialSymbol;
  putCall: AvwapTrialSide;
  at: number;
  reason: string;
}

export interface AvwapTrialBook {
  version: 1;
  trades: AvwapTrialTrade[];
  checks: Partial<Record<AvwapTrialSymbol, AvwapTrialSymbolCheck>>;
  skips: AvwapTrialSkip[];
  updatedAt: number | null;
}

export interface AvwapTrialMark {
  expiration: string;
  strike: number;
  bid: number;
  ask: number;
  putCall: AvwapTrialSide;
}

export interface AvwapTrialMarket {
  symbol: AvwapTrialSymbol;
  daily: readonly AvwapDailyBar[];
  bars: readonly CandleBar[];
  historyFailed?: boolean;
  quotes: readonly AvwapTrialMark[];
}

export interface AvwapTrialAdvance {
  book: AvwapTrialBook;
  opened: AvwapTrialTrade[];
  closed: AvwapTrialTrade[];
}

export interface AvwapTrialSideSummary {
  open: number;
  closed: number;
  pnlDollars: number;
  wins: number;
  losses: number;
}

export interface AvwapTrialSection {
  label: string;
  paperOnly: true;
  stored: boolean;
  symbols: readonly AvwapTrialSymbol[];
  budgetDollars: number;
  feePerSide: number;
  puts: AvwapTrialSideSummary;
  calls: AvwapTrialSideSummary;
  totalPnlDollars: number;
  wins: number;
  losses: number;
  checks: Partial<Record<AvwapTrialSymbol, AvwapTrialSymbolCheck>>;
  skips: AvwapTrialSkip[];
  openPuts: AvwapTrialTrade[];
  openCalls: AvwapTrialTrade[];
  closedPuts: AvwapTrialTrade[];
  closedCalls: AvwapTrialTrade[];
  updatedAt: number | null;
}

const SKIP_CAP = 60;

export function isAvwapTrialSymbol(value: string): value is AvwapTrialSymbol {
  return (AVWAP_TRIAL_SYMBOLS as readonly string[]).includes(value);
}

/** A 5-minute close above AVWAP after a completed close at or below it. */
export function avwapCallCrosses(bars: readonly CandleBar[], anchorDate: string, nowMs: number): AvwapSignal[] {
  const points = avwapPoints(bars, anchorDate, nowMs);
  const found: AvwapSignal[] = [];
  for (let i = 1; i < points.length; i++) {
    const prior = points[i - 1];
    const current = points[i];
    if (prior.close <= prior.vwap && current.close > current.vwap) {
      found.push({
        at: current.t,
        close: current.close,
        vwap: current.vwap,
        priorClose: prior.close,
        priorVwap: prior.vwap,
      });
    }
  }
  return found;
}

export function latestAvwapCallCross(bars: readonly CandleBar[], anchorDate: string, nowMs: number): AvwapSignal | null {
  const found = avwapCallCrosses(bars, anchorDate, nowMs);
  return found.length > 0 ? found[found.length - 1] : null;
}

export function emptyAvwapTrialBook(): AvwapTrialBook {
  return { version: 1, trades: [], checks: {}, skips: [], updatedAt: null };
}

export function serializeAvwapTrialBook(book: AvwapTrialBook): string {
  return JSON.stringify({
    version: 1,
    trades: book.trades,
    checks: book.checks,
    skips: book.skips,
    updatedAt: book.updatedAt,
  });
}

export function parseAvwapTrialBook(text: string | null | undefined): AvwapTrialBook {
  if (!text) return emptyAvwapTrialBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyAvwapTrialBook();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyAvwapTrialBook();
  const row = parsed as Record<string, unknown>;
  if (!Array.isArray(row.trades)) return emptyAvwapTrialBook();
  const trades: AvwapTrialTrade[] = [];
  for (let i = 0; i < row.trades.length; i++) {
    const trade = parseTrade(row.trades[i]);
    if (trade) trades.push(trade);
  }
  return {
    version: 1,
    trades,
    checks: parseChecks(row.checks),
    skips: parseSkips(row.skips),
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : null,
  };
}

export function advanceAvwapTrial(
  book: AvwapTrialBook,
  markets: readonly AvwapTrialMarket[],
  now: Date,
): AvwapTrialAdvance {
  if (avwapSkipReason(now)) return { book, opened: [], closed: [] };
  const nowMs = now.getTime();
  const today = newYorkDate(now);
  const bySymbol = new Map<AvwapTrialSymbol, AvwapTrialMarket>();
  for (let i = 0; i < markets.length; i++) bySymbol.set(markets[i].symbol, markets[i]);
  let trades = book.trades.map((trade) => ({ ...trade }));
  const closed: AvwapTrialTrade[] = [];
  for (let i = 0; i < AVWAP_TRIAL_SYMBOLS.length; i++) {
    const symbol = AVWAP_TRIAL_SYMBOLS[i];
    const market = bySymbol.get(symbol) ?? null;
    trades = trades.map((trade) => {
      if (trade.symbol !== symbol || trade.status !== "open") return trade;
      const next = markTrade(trade, market, now);
      if (next.status === "closed") closed.push(next);
      return next;
    });
  }
  const stopped = trialDailyStop(trades, now);
  const opened: AvwapTrialTrade[] = [];
  const checks: Partial<Record<AvwapTrialSymbol, AvwapTrialSymbolCheck>> = {};
  const skips = book.skips.slice();
  for (let i = 0; i < AVWAP_TRIAL_SYMBOLS.length; i++) {
    const symbol = AVWAP_TRIAL_SYMBOLS[i];
    const result = enterSymbol(trades, bySymbol.get(symbol) ?? null, symbol, today, nowMs, stopped);
    checks[symbol] = { at: nowMs, put: result.put, call: result.call };
    for (let s = 0; s < result.skips.length; s++) skips.push(result.skips[s]);
    if (result.trade) {
      trades.push(result.trade);
      opened.push(result.trade);
    }
  }
  return {
    book: {
      version: 1,
      trades,
      checks,
      skips: skips.slice(-SKIP_CAP),
      updatedAt: nowMs,
    },
    opened,
    closed,
  };
}

export interface AvwapTrialQuoteRequest {
  occ: string;
  symbol: AvwapTrialSymbol;
  expiration: string;
  strike: number;
  putCall: AvwapTrialSide;
}

export function trialQuotePlan(book: AvwapTrialBook, markets: readonly AvwapTrialMarket[], now: Date): AvwapTrialQuoteRequest[] {
  if (avwapSkipReason(now)) return [];
  const nowMs = now.getTime();
  const today = newYorkDate(now);
  const stopped = trialDailyStop(book.trades, now);
  const seen = new Set<string>();
  const out: AvwapTrialQuoteRequest[] = [];
  const add = (symbol: AvwapTrialSymbol, expiration: string, strike: number, putCall: AvwapTrialSide) => {
    const occ = schwabOptionSymbol({ ticker: symbol, expiration, strike, putCall });
    if (!occ || seen.has(occ)) return;
    seen.add(occ);
    out.push({ occ, symbol, expiration, strike, putCall });
  };
  for (let i = 0; i < book.trades.length; i++) {
    const trade = book.trades[i];
    if (trade.status === "open") add(trade.symbol, trade.expiration, trade.strike, trade.putCall);
  }
  if (stopped) return out;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    if (hasOpen(book.trades, market.symbol)) continue;
    const setup = readSetup(market, today, nowMs);
    if (!setup) continue;
    for (let s = 0; s < setup.fresh.length; s++) {
      const side = setup.fresh[s];
      if (side.strike == null) continue;
      const expiries = expiryCandidates(today, AVWAP_PRIMARY_DTE_MIN, AVWAP_PRIMARY_DTE_MAX, AVWAP_PRIMARY_DTE_TARGET);
      for (let e = 0; e < expiries.length; e++) add(market.symbol, expiries[e], side.strike, side.putCall);
    }
  }
  return out;
}

export function avwapTrialSection(book: AvwapTrialBook, stored: boolean): AvwapTrialSection {
  const puts = summarize(book.trades, "put");
  const calls = summarize(book.trades, "call");
  return {
    label: "AVWAP trial: AMD, MSFT, AMZN (paper)",
    paperOnly: true,
    stored,
    symbols: AVWAP_TRIAL_SYMBOLS,
    budgetDollars: AVWAP_BUDGET_DOLLARS,
    feePerSide: AVWAP_FEE_PER_SIDE,
    puts,
    calls,
    totalPnlDollars: roundCents(puts.pnlDollars + calls.pnlDollars),
    wins: puts.wins + calls.wins,
    losses: puts.losses + calls.losses,
    checks: book.checks,
    skips: book.skips.slice().reverse(),
    openPuts: book.trades.filter((trade) => trade.status === "open" && trade.putCall === "put"),
    openCalls: book.trades.filter((trade) => trade.status === "open" && trade.putCall === "call"),
    closedPuts: book.trades.filter((trade) => trade.status === "closed" && trade.putCall === "put"),
    closedCalls: book.trades.filter((trade) => trade.status === "closed" && trade.putCall === "call"),
    updatedAt: book.updatedAt,
  };
}

export function formatAvwapTrialAlert(trade: AvwapTrialTrade): string {
  const side = trade.putCall === "call" ? "CALL" : "PUT";
  const target = trade.entryAsk * (1 + AVWAP_TARGET_FRACTION);
  const debit = trade.entryAsk * 100 * trade.contracts;
  const word = trade.putCall === "call" ? "above" : "below";
  const prior = trade.putCall === "call" ? "at or below" : "at or above";
  return [
    `<b>PAPER TRIAL: ${trade.symbol} ${side}</b>`,
    `${escapeHtml(trade.symbol)} <b>${side}</b> $${money(trade.strike)} exp ${escapeHtml(trade.expiration)}`,
    "Paper only. No order is placed. This is not a live AVWAP book alert.",
    "",
    `Gap-day anchored VWAP. Anchor ${trade.anchorDate} (${(trade.gap * 100).toFixed(2)}% vs the prior close). 5-minute close $${money(trade.signalClose)} ${word} AVWAP $${money(trade.signalVwap)} after a prior close ${prior} it.`,
    `Buy <b>${trade.contracts}</b> at the ask $${money(trade.entryAsk)} (bid $${money(trade.entryBid)}). Debit $${money(debit)}, within the $${AVWAP_BUDGET_DOLLARS} cap.`,
    `Sell at the bid when the bid is at least $${money(target)} (+50%). Otherwise close on the expiry-day final scan.`,
  ].join("\n");
}

export function trialSymbolsLeaveLiveBookAlone(): boolean {
  const live = AVWAP_SYMBOLS as readonly string[];
  for (let i = 0; i < AVWAP_TRIAL_SYMBOLS.length; i++) {
    if (live.includes(AVWAP_TRIAL_SYMBOLS[i])) return false;
  }
  return live.length === 7;
}

function enterSymbol(
  trades: readonly AvwapTrialTrade[],
  market: AvwapTrialMarket | null,
  symbol: AvwapTrialSymbol,
  today: string,
  nowMs: number,
  stopped: boolean,
): { put: AvwapTrialSideCheck; call: AvwapTrialSideCheck; trade: AvwapTrialTrade | null; skips: AvwapTrialSkip[] } {
  if (!market || market.historyFailed) {
    const side = { outcome: "data-error" as const, reason: "price history failed" };
    return { put: side, call: side, trade: null, skips: [] };
  }
  const gap = latestGapDay(market.daily, today);
  if (!gap) {
    const side = { outcome: "no-gap" as const, reason: "no gap of more than 1% in the daily bars" };
    return { put: side, call: side, trade: null, skips: [] };
  }
  const points = avwapPoints(market.bars, gap.date, nowMs);
  if (points.length === 0) {
    const side = { outcome: "no-signal" as const, reason: `gap ${gap.date} has no completed regular-hours bars in this fetch` };
    return { put: side, call: side, trade: null, skips: [] };
  }
  const spot = points[points.length - 1].close;
  const strike = atmStrike(spot);
  const putSignal = latestAvwapCross(market.bars, gap.date, nowMs);
  const callSignal = latestAvwapCallCross(market.bars, gap.date, nowMs);
  const ranked = rankFresh(putSignal, callSignal, nowMs);
  let opened: AvwapTrialTrade | null = null;
  const skips: AvwapTrialSkip[] = [];
  const checks: Record<AvwapTrialSide, AvwapTrialSideCheck> = {
    put: restingCheck("put", putSignal, gap.date, trades, symbol, nowMs),
    call: restingCheck("call", callSignal, gap.date, trades, symbol, nowMs),
  };
  for (let i = 0; i < ranked.length; i++) {
    const putCall = ranked[i];
    const signal = putCall === "put" ? putSignal : callSignal;
    if (!signal) continue;
    if (checks[putCall].outcome === "skipped" && checks[putCall].reason === "this cross was already papered") continue;
    if (hasOpen(trades, symbol) || opened) {
      const blocked = skipCheck(symbol, putCall, nowMs, "one paper position is already open");
      checks[putCall] = blocked.check;
      skips.push(blocked.skip);
      continue;
    }
    if (stopped) {
      const blocked = skipCheck(symbol, putCall, nowMs, "daily stop: two losing paper closes in a row");
      checks[putCall] = blocked.check;
      skips.push(blocked.skip);
      continue;
    }
    const attempt = openSide(putCall, signal, market, symbol, gap, spot, strike, today, nowMs);
    checks[putCall] = attempt.check;
    if (attempt.skip) skips.push(attempt.skip);
    if (attempt.trade) opened = attempt.trade;
  }
  return { put: checks.put, call: checks.call, trade: opened, skips };
}

function restingCheck(
  putCall: AvwapTrialSide,
  signal: AvwapSignal | null,
  anchor: string,
  trades: readonly AvwapTrialTrade[],
  symbol: AvwapTrialSymbol,
  nowMs: number,
): AvwapTrialSideCheck {
  if (!signal) return { outcome: "no-signal", reason: noCrossReason(putCall, anchor) };
  if (!signalIsFresh(signal, nowMs)) return { outcome: "no-signal", reason: "the latest cross is older than this scan" };
  if (alreadySignaled(trades, symbol, putCall, signal.at)) return { outcome: "skipped", reason: "this cross was already papered" };
  return { outcome: "checked", reason: "signal is fresh" };
}

function openSide(
  putCall: AvwapTrialSide,
  signal: AvwapSignal,
  market: AvwapTrialMarket,
  symbol: AvwapTrialSymbol,
  gap: { date: string; gap: number },
  spot: number,
  strike: number | null,
  today: string,
  nowMs: number,
): { check: AvwapTrialSideCheck; trade: AvwapTrialTrade | null; skip: AvwapTrialSkip | null } {
  if (strike == null) return skipCheck(symbol, putCall, nowMs, "no underlying price for the at-the-money strike");
  const quote = pickQuote(market.quotes, today, strike, putCall);
  if (!quote) return skipCheck(symbol, putCall, nowMs, `no ${putCall} quote in the 5 to 10 day window`);
  const contracts = avwapContractCount(quote.ask);
  if (contracts === 0) return skipCheck(symbol, putCall, nowMs, "one contract costs more than $875");
  if (contracts == null) return skipCheck(symbol, putCall, nowMs, "the ask could not be sized");
  const dte = calendarDaysBetween(today, quote.expiration);
  if (dte == null || dte < AVWAP_PRIMARY_DTE_MIN || dte > AVWAP_PRIMARY_DTE_MAX) {
    return skipCheck(symbol, putCall, nowMs, "the quote expiry is outside 5 to 10 calendar days");
  }
  const trade: AvwapTrialTrade = {
    id: `avwap-trial-${symbol}-${putCall}-${signal.at}`,
    symbol,
    putCall,
    strike,
    expiration: quote.expiration,
    dte,
    contracts,
    openedAt: nowMs,
    signalAt: signal.at,
    anchorDate: gap.date,
    gap: gap.gap,
    spot,
    signalClose: signal.close,
    signalVwap: signal.vwap,
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
  };
  return {
    check: { outcome: "entered", reason: `paper entry, ${contracts} ${putCall} contract${contracts === 1 ? "" : "s"}` },
    trade,
    skip: null,
  };
}

function skipCheck(
  symbol: AvwapTrialSymbol,
  putCall: AvwapTrialSide,
  at: number,
  reason: string,
): { check: AvwapTrialSideCheck; trade: null; skip: AvwapTrialSkip } {
  return {
    check: { outcome: "skipped", reason },
    trade: null,
    skip: { id: `skip-${symbol}-${putCall}-${at}`, symbol, putCall, at, reason },
  };
}

function rankFresh(putSignal: AvwapSignal | null, callSignal: AvwapSignal | null, nowMs: number): AvwapTrialSide[] {
  const rows: { side: AvwapTrialSide; at: number }[] = [];
  if (putSignal && signalIsFresh(putSignal, nowMs)) rows.push({ side: "put", at: putSignal.at });
  if (callSignal && signalIsFresh(callSignal, nowMs)) rows.push({ side: "call", at: callSignal.at });
  rows.sort((a, b) => b.at - a.at);
  return rows.map((row) => row.side);
}

function noCrossReason(putCall: AvwapTrialSide, anchor: string): string {
  if (putCall === "call") {
    return `anchored at ${anchor}; no close above the anchored VWAP after a prior close at or below it`;
  }
  return `anchored at ${anchor}; no close below the anchored VWAP after a prior close at or above it`;
}

function markTrade(trade: AvwapTrialTrade, market: AvwapTrialMarket | null, now: Date): AvwapTrialTrade {
  const quote = findMark(market?.quotes ?? [], trade.expiration, trade.strike, trade.putCall);
  const nowMs = now.getTime();
  const marked = quote ? { ...trade, lastBid: quote.bid, lastAsk: quote.ask, lastQuoteAt: nowMs } : trade;
  const bid = quote ? quote.bid : null;
  const ask = quote ? quote.ask : null;
  if (bid != null && ask != null && bidHitsTarget(bid, trade.entryAsk, AVWAP_TARGET_FRACTION)) {
    return closeTrade(marked, bid, ask, "target50", null, nowMs);
  }
  if (isExpiryFinalScan(now, trade.expiration) && bid != null && ask != null) {
    return closeTrade(marked, bid, ask, "expiry", null, nowMs);
  }
  if (isExpiryFinalScan(now, trade.expiration) && newYorkDate(now) > trade.expiration) {
    return closeTrade(marked, 0, ask, "expiry", "No bid after expiration. Closed at 0.", nowMs);
  }
  return marked;
}

function closeTrade(
  trade: AvwapTrialTrade,
  bid: number,
  ask: number | null,
  reason: "target50" | "expiry",
  note: string | null,
  nowMs: number,
): AvwapTrialTrade {
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

function pickQuote(
  quotes: readonly AvwapTrialMark[],
  today: string,
  strike: number,
  putCall: AvwapTrialSide,
): AvwapTrialMark | null {
  const order = expiryCandidates(today, AVWAP_PRIMARY_DTE_MIN, AVWAP_PRIMARY_DTE_MAX, AVWAP_PRIMARY_DTE_TARGET);
  for (let i = 0; i < order.length; i++) {
    const found = findMark(quotes, order[i], strike, putCall);
    if (found && found.ask > 0) return found;
  }
  return null;
}

function findMark(
  quotes: readonly AvwapTrialMark[],
  expiration: string,
  strike: number,
  putCall: AvwapTrialSide,
): AvwapTrialMark | null {
  for (let i = 0; i < quotes.length; i++) {
    const quote = quotes[i];
    if (quote.putCall !== putCall || quote.expiration !== expiration) continue;
    if (Math.abs(quote.strike - strike) > 1e-6) continue;
    if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) continue;
    if (quote.bid < 0 || quote.ask < 0 || quote.ask + 1e-9 < quote.bid) continue;
    return quote;
  }
  return null;
}

interface FreshSide {
  putCall: AvwapTrialSide;
  strike: number | null;
}

function readSetup(market: AvwapTrialMarket, today: string, nowMs: number): { fresh: FreshSide[] } | null {
  const gap = latestGapDay(market.daily, today);
  if (!gap || market.historyFailed) return null;
  const points = avwapPoints(market.bars, gap.date, nowMs);
  if (points.length === 0) return null;
  const strike = atmStrike(points[points.length - 1].close);
  const fresh: FreshSide[] = [];
  const put = latestAvwapCross(market.bars, gap.date, nowMs);
  const call = latestAvwapCallCross(market.bars, gap.date, nowMs);
  if (put && signalIsFresh(put, nowMs)) fresh.push({ putCall: "put", strike });
  if (call && signalIsFresh(call, nowMs)) fresh.push({ putCall: "call", strike });
  return { fresh };
}

function hasOpen(trades: readonly AvwapTrialTrade[], symbol: AvwapTrialSymbol): boolean {
  return trades.some((trade) => trade.symbol === symbol && trade.status === "open");
}

function alreadySignaled(trades: readonly AvwapTrialTrade[], symbol: AvwapTrialSymbol, putCall: AvwapTrialSide, signalAt: number): boolean {
  const id = `avwap-trial-${symbol}-${putCall}-${signalAt}`;
  return trades.some((trade) => trade.id === id);
}

function trialDailyStop(trades: readonly AvwapTrialTrade[], now: Date): boolean {
  const tradingDay = chicagoDate(now);
  const closed = trades.filter((trade) => {
    if (trade.status !== "closed" || trade.closedAt == null || trade.pnlDollars == null) return false;
    return chicagoDate(new Date(trade.closedAt)) === tradingDay;
  });
  closed.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.id.localeCompare(b.id));
  let streak = 0;
  let maxStreak = 0;
  for (let i = 0; i < closed.length; i++) {
    if ((closed[i].pnlDollars ?? 0) < 0) {
      streak += 1;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      streak = 0;
    }
  }
  return maxStreak >= AVWAP_DAILY_STOP_LOSSES;
}

function summarize(trades: readonly AvwapTrialTrade[], putCall: AvwapTrialSide): AvwapTrialSideSummary {
  const rows = trades.filter((trade) => trade.putCall === putCall);
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let closed = 0;
  let open = 0;
  for (let i = 0; i < rows.length; i++) {
    const trade = rows[i];
    if (trade.status === "open") {
      open += 1;
      if (trade.lastBid != null) {
        const mark = avwapPnl(trade.entryAsk, trade.lastBid, trade.contracts);
        if (mark != null) pnl += mark;
      }
      continue;
    }
    closed += 1;
    if (trade.pnlDollars == null) continue;
    pnl += trade.pnlDollars;
    if (trade.pnlDollars > 0) wins += 1;
    if (trade.pnlDollars < 0) losses += 1;
  }
  return { open, closed, pnlDollars: roundCents(pnl), wins, losses };
}

function parseTrade(value: unknown): AvwapTrialTrade | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const symbol = typeof row.symbol === "string" ? row.symbol : "";
  if (!isAvwapTrialSymbol(symbol)) return null;
  if (row.putCall !== "put" && row.putCall !== "call") return null;
  const strike = finite(row.strike);
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  const contracts = finite(row.contracts);
  const openedAt = finite(row.openedAt);
  const signalAt = finite(row.signalAt);
  const entryAsk = finite(row.entryAsk);
  const entryBid = finite(row.entryBid);
  const dte = finite(row.dte);
  const gap = finite(row.gap);
  const spot = finite(row.spot);
  const signalClose = finite(row.signalClose);
  const signalVwap = finite(row.signalVwap);
  const anchorDate = typeof row.anchorDate === "string" ? row.anchorDate : "";
  const id = typeof row.id === "string" ? row.id : "";
  if (strike == null || !(strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  if (contracts == null || !Number.isInteger(contracts) || contracts < 1) return null;
  if (openedAt == null || signalAt == null || entryAsk == null || !(entryAsk > 0)) return null;
  if (entryBid == null || entryBid < 0 || dte == null || gap == null || spot == null) return null;
  if (signalClose == null || signalVwap == null || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || !id) return null;
  const status = row.status === "closed" ? "closed" : row.status === "open" ? "open" : null;
  if (!status) return null;
  const exitReason = row.exitReason === "target50" || row.exitReason === "expiry" ? row.exitReason : null;
  return {
    id,
    symbol,
    putCall: row.putCall,
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
    lastBid: finite(row.lastBid),
    lastAsk: finite(row.lastAsk),
    lastQuoteAt: finite(row.lastQuoteAt),
    status,
    closedAt: finite(row.closedAt),
    exitBid: finite(row.exitBid),
    exitAsk: finite(row.exitAsk),
    exitReason,
    exitNote: typeof row.exitNote === "string" ? row.exitNote.slice(0, 240) : null,
    pnlDollars: finite(row.pnlDollars),
  };
}

function parseChecks(value: unknown): AvwapTrialBook["checks"] {
  const checks: AvwapTrialBook["checks"] = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return checks;
  const row = value as Record<string, unknown>;
  for (let i = 0; i < AVWAP_TRIAL_SYMBOLS.length; i++) {
    const symbol = AVWAP_TRIAL_SYMBOLS[i];
    const item = row[symbol];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const check = item as Record<string, unknown>;
    const at = finite(check.at);
    const put = parseSide(check.put);
    const call = parseSide(check.call);
    if (at == null || !put || !call) continue;
    checks[symbol] = { at, put, call };
  }
  return checks;
}

function parseSide(value: unknown): AvwapTrialSideCheck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const outcome = row.outcome;
  if (
    outcome !== "checked"
    && outcome !== "no-gap"
    && outcome !== "no-signal"
    && outcome !== "entered"
    && outcome !== "skipped"
    && outcome !== "data-error"
  ) return null;
  const reason = typeof row.reason === "string" ? row.reason.slice(0, 240) : "";
  if (!reason) return null;
  return { outcome, reason };
}

function parseSkips(value: unknown): AvwapTrialSkip[] {
  if (!Array.isArray(value)) return [];
  const skips: AvwapTrialSkip[] = [];
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const symbol = typeof item.symbol === "string" ? item.symbol : "";
    if (!isAvwapTrialSymbol(symbol)) continue;
    if (item.putCall !== "put" && item.putCall !== "call") continue;
    const at = finite(item.at);
    const reason = typeof item.reason === "string" ? item.reason.slice(0, 240) : "";
    const id = typeof item.id === "string" ? item.id : "";
    if (at == null || !reason || !id) continue;
    skips.push({ id, symbol, putCall: item.putCall, at, reason });
  }
  return skips.slice(-SKIP_CAP);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export const AVWAP_TRIAL_GAP = AVWAP_GAP_FRACTION;
