import type { PutCall } from "@/app/lib/contract";
import {
  addCalendarDays,
  estimateSide,
  flowContractKey,
  notionalPremium,
  volumeOiRatio,
  type EstimatedSideLabel,
  type FlowRow,
} from "@/app/lib/flow";
import { chicagoDate, chicagoTradingDaysElapsed, isMarketDay } from "@/app/lib/marketHours";

/**
 * Unusual-flow presets, modeled on the Unusually Bullish and Unusually Bearish
 * screens: calls or puts, high volume versus open interest, premium at the ask,
 * a dated window, and a near-the-money band.
 *
 * Every number comes from a chain or quote the scan already holds, or from an
 * optional trade aggressor when the quote includes one. Nothing here fetches,
 * places an order, or sends Telegram.
 */

/** Always in the universe, plus whatever watchlist the scan is already using. */
export const UNUSUAL_CORE_SYMBOLS = ["SPY", "QQQ", "IWM"] as const;

/** Volume / open interest. A contract below this is not unusual. */
export const UNUSUAL_MIN_VOL_OI = 3;

/** volume × mark × 100. Mark is the bid/ask midpoint. */
export const UNUSUAL_MIN_PREMIUM = 50_000;

/** Ask-attributed volume has to be at least this share of today's added volume. */
export const UNUSUAL_MIN_ASK_SHARE = 0.6;

export const UNUSUAL_DTE_MIN = 7;
export const UNUSUAL_DTE_MAX = 60;

/** Signed fraction of the underlying. 0 is at the money. 0.15 is 15% out. */
export const UNUSUAL_OTM_MIN = 0;
export const UNUSUAL_OTM_MAX = 0.15;

/**
 * Contracts added on one contract between two scans, while that contract is
 * at or above the ask. The feed has no time-and-sales prints, so this is an
 * approximation of a sweep, not an exchange sweep.
 */
export const UNUSUAL_SWEEP_MIN_CONTRACTS = 250;

export const UNUSUAL_FLAG_CAP = 800;

/** Drop a flag this many calendar days after expiration. Outcomes stop then. */
export const UNUSUAL_KEEP_AFTER_EXPIRY_DAYS = 14;

export const UNUSUAL_BRIEF_LIMIT = 5;

export const UNUSUAL_OUTCOME_DAYS = [1, 3, 5] as const;
export type UnusualOutcomeDay = (typeof UNUSUAL_OUTCOME_DAYS)[number];

export const ESTIMATE_SHARE_NOTE =
  "Estimate. The last price versus the bid and ask is applied to the contracts added since the prior scan. Not a trade print.";

export const TRADE_SHARE_NOTE =
  "Trade aggressor from the quote, applied to the contracts added since the prior scan.";

export const MIXED_SHARE_NOTE =
  "Mixed. Some of today's added volume had a trade aggressor. The rest is estimated from the last price versus the bid and ask.";

export const SWEEP_NOTE =
  "Approximation. A large volume jump between consecutive scans while the contract was at or above the ask. No time-and-sales prints, so this is not an exchange sweep.";

export const UNUSUAL_PAGE_NOTE =
  "Unusually Bullish is calls. Unusually Bearish is puts. Both need volume/open interest of at least 3, at least 60% of today's added volume at the ask, $50,000 of premium (volume × midpoint × 100), 7 to 60 days out, and 0 to 15% out of the money. Ask share is an estimate from the last price unless the quote included a trade aggressor. A sweep-like burst is a large jump between scans, not an exchange sweep. Flags are stored so the next 1, 3, and 5 trading days can be measured. No Telegram alert is sent.";

export const UNUSUAL_BRIEF_NOTE =
  "Top unusual-flow flags saved today, by premium. Ask share is an estimate unless a trade aggressor was on the quote. A sweep-like burst is an approximation. No Telegram alert is sent for these flags.";

export type UnusualPreset = "bullish" | "bearish";

/** Ask means the buyer lifted the offer. Bid means the seller hit the bid. */
export type TapeSide = "ask" | "bid" | "mid";

export type SideSource = "trade" | "estimate" | "mixed";

export interface TradePrint {
  size: number;
  /** Set only when the tape named the aggressor. Absent means estimate from price. */
  aggressor?: TapeSide | null;
  price?: number | null;
  bid?: number | null;
  ask?: number | null;
}

export interface UnusualInterval {
  symbol: string;
  putCall: PutCall;
  strike: number;
  expiration: string;
  volume: number;
  openInterest: number;
  previousVolume: number | null;
  volumeJump: number | null;
  bid: number;
  ask: number;
  last: number;
  /** Midpoint used as the mark. Null when the quote has no positive midpoint. */
  mark: number | null;
  dte: number | null;
  underlyingPrice: number | null;
  /**
   * Aggressor of the latest trade, when the quote included one.
   * Null means the side is estimated from last versus bid and ask.
   */
  tradeAggressor: TapeSide | null;
  /** Trades since the prior scan, when the tape included them. */
  trades?: readonly TradePrint[];
}

export interface UnusualMetrics {
  volume: number;
  openInterest: number;
  volOiRatio: number | null;
  /** volume × mark × 100. */
  premium: number | null;
  /** Ask-attributed contracts × mark × 100. Estimate unless sideSource is trade. */
  askSidePremium: number | null;
  askShare: number | null;
  bidShare: number | null;
  sideSource: SideSource;
  sideNote: string;
  dte: number | null;
  /** Signed. Negative is in the money. */
  otmFraction: number | null;
  sweepLike: boolean;
  sweepNote: string;
  optionMark: number | null;
}

export interface UnusualHorizon {
  tradingDays: UnusualOutcomeDay;
  at: number;
  tradingDay: string;
  underlyingPrice: number;
  optionMark: number;
  /** Fraction. 0.1 means the underlying is 10% above the flag. */
  underlyingChange: number;
  /** Fraction from the flag mark to this mark. */
  optionChange: number;
}

export interface UnusualFlag {
  id: string;
  preset: UnusualPreset;
  flaggedAt: number;
  tradingDay: string;
  symbol: string;
  putCall: PutCall;
  strike: number;
  expiration: string;
  contractKey: string;
  metrics: UnusualMetrics;
  underlyingPrice: number;
  optionMark: number;
  outcomes: {
    d1: UnusualHorizon | null;
    d3: UnusualHorizon | null;
    d5: UnusualHorizon | null;
  };
}

interface VolumeLedger {
  ask: number;
  bid: number;
  mid: number;
  unknown: number;
  trade: number;
  estimate: number;
  burst: boolean;
}

export interface UnusualBook {
  flags: UnusualFlag[];
  ledgerDay: string | null;
  ledger: Record<string, VolumeLedger>;
}

export interface UnusualFlowHealth {
  flagsToday: number;
  bullishToday: number;
  bearishToday: number;
  /** Flags that still need a 1, 3, or 5 day mark and have not expired. */
  awaitingOutcome: number;
  lastFlagAt: string | null;
}

export interface BriefUnusualRow {
  preset: UnusualPreset;
  symbol: string;
  putCall: PutCall;
  strike: number;
  expiration: string;
  premium: number | null;
  volOiRatio: number | null;
  askShare: number | null;
  sideSource: SideSource;
  sweepLike: boolean;
  underlyingPrice: number;
  flaggedAt: string;
}

export interface BriefUnusual {
  note: string;
  top: BriefUnusualRow[];
}

export function emptyUnusualBook(): UnusualBook {
  return { flags: [], ledgerDay: null, ledger: {} };
}

export function emptyUnusualFlowHealth(): UnusualFlowHealth {
  return {
    flagsToday: 0,
    bullishToday: 0,
    bearishToday: 0,
    awaitingOutcome: 0,
    lastFlagAt: null,
  };
}

export function unusualThresholds(): {
  minVolOi: number;
  minPremium: number;
  minAskShare: number;
  dteMin: number;
  dteMax: number;
  otmMin: number;
  otmMax: number;
  sweepMinContracts: number;
} {
  return {
    minVolOi: UNUSUAL_MIN_VOL_OI,
    minPremium: UNUSUAL_MIN_PREMIUM,
    minAskShare: UNUSUAL_MIN_ASK_SHARE,
    dteMin: UNUSUAL_DTE_MIN,
    dteMax: UNUSUAL_DTE_MAX,
    otmMin: UNUSUAL_OTM_MIN,
    otmMax: UNUSUAL_OTM_MAX,
    sweepMinContracts: UNUSUAL_SWEEP_MIN_CONTRACTS,
  };
}

/** SPY, QQQ, and IWM, then the watchlist. Duplicates are dropped. */
export function unusualUniverse(watchlist: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const symbol = value.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    out.push(symbol);
  };
  for (let i = 0; i < UNUSUAL_CORE_SYMBOLS.length; i++) add(UNUSUAL_CORE_SYMBOLS[i]);
  for (let i = 0; i < watchlist.length; i++) add(watchlist[i]);
  return out;
}

/**
 * Buy, ask, and at-ask are the offer. Sell, bid, and at-bid are the bid.
 * Anything else, including an estimated side, is not a tape aggressor.
 */
/**
 * DXLink TimeAndSale uses buy and sell. unknown and anything else are not a tape side,
 * so the caller falls back to the last-versus-bid/ask estimate.
 */
export function tapeFromAggressorSide(value: unknown): TapeSide | null {
  if (value === "buy") return "ask";
  if (value === "sell") return "bid";
  return null;
}

export function parseTradeAggressor(value: unknown): TapeSide | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (text === "buy" || text === "bought" || text === "ask" || text === "at ask" || text === "a") return "ask";
  if (text === "sell" || text === "sold" || text === "bid" || text === "at bid" || text === "b") return "bid";
  if (text === "mid" || text === "between") return "mid";
  return null;
}

export function signedOtmFraction(putCall: PutCall, strike: number, underlying: number | null): number | null {
  if (underlying == null || !(underlying > 0) || !Number.isFinite(underlying) || !Number.isFinite(strike)) return null;
  const raw = putCall === "call" ? strike - underlying : underlying - strike;
  if (!Number.isFinite(raw)) return null;
  return raw / underlying;
}

export function intervalKey(interval: {
  symbol: string;
  expiration: string;
  strike: number;
  putCall: string;
}): string {
  return `${interval.symbol}|${flowContractKey(interval)}`;
}

export function intervalsFromFlowRows(rows: readonly FlowRow[]): UnusualInterval[] {
  const out: UnusualInterval[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Number.isFinite(row.volume) || row.volume < 0) continue;
    if (!Number.isFinite(row.openInterest) || row.openInterest < 0) continue;
    const extra = row as FlowRow & { tradeAggressor?: unknown; trades?: unknown; aggressorSide?: unknown };
    out.push({
      symbol: row.ticker.trim().toUpperCase(),
      putCall: row.putCall,
      strike: row.strike,
      expiration: row.expiration,
      volume: row.volume,
      openInterest: row.openInterest,
      previousVolume: finiteOrNull(row.previousVolume),
      volumeJump: finiteOrNull(row.volumeJump),
      bid: row.bid,
      ask: row.ask,
      last: row.last,
      mark: finitePositive(row.mid),
      dte: row.dte,
      underlyingPrice: finitePositive(row.underlyingPrice),
      tradeAggressor: tapeFromAggressorSide(extra.aggressorSide) ?? parseTradeAggressor(extra.tradeAggressor),
      trades: parseTrades(extra.trades),
    });
  }
  return out;
}

export interface SideRead {
  side: TapeSide | "unknown";
  source: "trade" | "estimate";
}

/** Real aggressor wins. Otherwise the same last-versus-bid/ask estimate the Flow page uses. */
export function resolveSide(input: {
  bid: number;
  ask: number;
  last: number;
  tradeAggressor: TapeSide | null;
}): SideRead {
  if (input.tradeAggressor) return { side: input.tradeAggressor, source: "trade" };
  return { side: sideFromEstimate(estimateSide(input.bid, input.ask, input.last).label), source: "estimate" };
}

/**
 * True when this scan's volume jump is large and the contract is at or above the ask.
 * Approximation only. A tape aggressor of buy counts as at the ask. An estimate uses
 * the same at-ask band as the Flow page.
 */
export function isSweepLikeBurst(volumeJump: number | null, side: TapeSide | "unknown"): boolean {
  if (volumeJump == null || !Number.isFinite(volumeJump)) return false;
  if (volumeJump + 1e-9 < UNUSUAL_SWEEP_MIN_CONTRACTS) return false;
  return side === "ask";
}

export function presetFor(putCall: PutCall, metrics: UnusualMetrics): UnusualPreset | null {
  if (!passesCommon(metrics)) return null;
  if (putCall === "call") return "bullish";
  if (putCall === "put") return "bearish";
  return null;
}

export function passesCommon(metrics: UnusualMetrics): boolean {
  if (metrics.volOiRatio == null || metrics.volOiRatio + 1e-12 < UNUSUAL_MIN_VOL_OI) return false;
  if (metrics.premium == null || metrics.premium + 1e-6 < UNUSUAL_MIN_PREMIUM) return false;
  if (metrics.askShare == null || metrics.askShare + 1e-12 < UNUSUAL_MIN_ASK_SHARE) return false;
  if (metrics.dte == null || metrics.dte < UNUSUAL_DTE_MIN || metrics.dte > UNUSUAL_DTE_MAX) return false;
  if (metrics.otmFraction == null) return false;
  if (metrics.otmFraction + 1e-12 < UNUSUAL_OTM_MIN) return false;
  if (metrics.otmFraction - 1e-12 > UNUSUAL_OTM_MAX) return false;
  if (metrics.optionMark == null || !(metrics.optionMark > 0)) return false;
  return true;
}

export function applyUnusualScan(input: {
  intervals: readonly UnusualInterval[];
  watchlist: readonly string[];
  book: UnusualBook;
  now: Date;
}): { book: UnusualBook; newFlags: number; outcomes: number; changed: boolean; skipped: "holiday" | null } {
  if (!isMarketDay(input.now)) {
    return { book: input.book, newFlags: 0, outcomes: 0, changed: false, skipped: "holiday" };
  }
  const day = chicagoDate(input.now);
  if (!day) return { book: input.book, newFlags: 0, outcomes: 0, changed: false, skipped: null };

  const universe = new Set(unusualUniverse(input.watchlist));
  let changed = input.book.ledgerDay !== day;
  const ledger: Record<string, VolumeLedger> = input.book.ledgerDay === day ? copyLedger(input.book.ledger) : {};
  const flags = input.book.flags.map(copyFlag);
  const index = new Map<string, number>();
  for (let i = 0; i < flags.length; i++) index.set(flags[i].id, i);

  const byKey = new Map<string, UnusualInterval>();
  let newFlags = 0;

  for (let i = 0; i < input.intervals.length; i++) {
    const interval = input.intervals[i];
    if (!universe.has(interval.symbol)) continue;
    const key = intervalKey(interval);
    byKey.set(key, interval);
    const side = resolveSide(interval);
    const entry = ledger[key] ? { ...ledger[key] } : emptyLedger();
    const before = ledgerStamp(entry);
    attribute(entry, interval, side);
    if (isSweepLikeBurst(positiveJump(interval.volumeJump), side.side)) entry.burst = true;
    if (ledgerStamp(entry) !== before || entry.burst !== (ledger[key]?.burst ?? false)) {
      ledger[key] = entry;
      changed = true;
    }

    const metrics = metricsFor(interval, entry);
    const preset = presetFor(interval.putCall, metrics);
    const id = `${day}|${key}`;
    if (!preset || index.has(id)) continue;
    if (interval.underlyingPrice == null || !(interval.underlyingPrice > 0)) continue;
    if (metrics.optionMark == null) continue;
    const flag = makeFlag({
      id,
      preset,
      day,
      interval,
      key,
      metrics,
      now: input.now,
    });
    flags.push(flag);
    index.set(id, flags.length - 1);
    newFlags += 1;
    changed = true;
  }

  let outcomes = 0;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const interval = byKey.get(flag.contractKey);
    if (!interval) continue;
    if (fillOutcomes(flag, interval, input.now)) {
      outcomes += 1;
      changed = true;
    }
  }

  const pruned = pruneFlags(flags, day);
  if (pruned.length !== flags.length) changed = true;

  return {
    book: { flags: pruned, ledgerDay: day, ledger },
    newFlags,
    outcomes,
    changed,
    skipped: null,
  };
}

export type UnusualSortKey = "time" | "symbol" | "premium" | "volOi" | "askShare" | "dte" | "otm" | "sweep";

export function sortUnusualFlags(
  flags: readonly UnusualFlag[],
  key: UnusualSortKey,
  direction: "asc" | "desc",
): UnusualFlag[] {
  const copy = flags.slice();
  const sign = direction === "asc" ? 1 : -1;
  copy.sort((a, b) => {
    const delta = compareFlags(a, b, key);
    if (delta !== 0) return delta * sign;
    return b.flaggedAt - a.flaggedAt;
  });
  return copy;
}

export function topUnusualFlags(
  flags: readonly UnusualFlag[],
  tradingDay: string | null,
  limit = UNUSUAL_BRIEF_LIMIT,
): UnusualFlag[] {
  if (!tradingDay) return [];
  const today = flags.filter((flag) => flag.tradingDay === tradingDay);
  return sortUnusualFlags(today, "premium", "desc").slice(0, Math.max(0, limit));
}

export function unusualBrief(flags: readonly UnusualFlag[], tradingDay: string | null): BriefUnusual {
  return {
    note: UNUSUAL_BRIEF_NOTE,
    top: topUnusualFlags(flags, tradingDay).map(briefRow),
  };
}

export function unusualFlowHealth(book: UnusualBook, now: Date): UnusualFlowHealth {
  const day = chicagoDate(now);
  let flagsToday = 0;
  let bullishToday = 0;
  let bearishToday = 0;
  let awaitingOutcome = 0;
  let lastAt: number | null = null;
  for (let i = 0; i < book.flags.length; i++) {
    const flag = book.flags[i];
    if (lastAt == null || flag.flaggedAt > lastAt) lastAt = flag.flaggedAt;
    if (flag.tradingDay !== day) continue;
    flagsToday += 1;
    if (flag.preset === "bullish") bullishToday += 1;
    else bearishToday += 1;
  }
  for (let i = 0; i < book.flags.length; i++) {
    const flag = book.flags[i];
    if (day && flag.expiration < day) continue;
    if (flag.outcomes.d1 && flag.outcomes.d3 && flag.outcomes.d5) continue;
    awaitingOutcome += 1;
  }
  return {
    flagsToday,
    bullishToday,
    bearishToday,
    awaitingOutcome,
    lastFlagAt: lastAt == null ? null : new Date(lastAt).toISOString(),
  };
}

export function parseUnusualBook(text: string | null): UnusualBook {
  if (!text) return emptyUnusualBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyUnusualBook();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyUnusualBook();
  const body = parsed as { flags?: unknown; ledgerDay?: unknown; ledger?: unknown };
  const flags: UnusualFlag[] = [];
  if (Array.isArray(body.flags)) {
    for (let i = 0; i < body.flags.length; i++) {
      const flag = parseFlag(body.flags[i]);
      if (flag) flags.push(flag);
    }
  }
  const ledgerDay = typeof body.ledgerDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.ledgerDay)
    ? body.ledgerDay
    : null;
  return { flags, ledgerDay, ledger: parseLedger(body.ledger) };
}

export function serializeUnusualBook(book: UnusualBook): string {
  return JSON.stringify(book);
}

function makeFlag(input: {
  id: string;
  preset: UnusualPreset;
  day: string;
  interval: UnusualInterval;
  key: string;
  metrics: UnusualMetrics;
  now: Date;
}): UnusualFlag {
  return {
    id: input.id,
    preset: input.preset,
    flaggedAt: input.now.getTime(),
    tradingDay: input.day,
    symbol: input.interval.symbol,
    putCall: input.interval.putCall,
    strike: input.interval.strike,
    expiration: input.interval.expiration,
    contractKey: input.key,
    metrics: input.metrics,
    underlyingPrice: input.interval.underlyingPrice as number,
    optionMark: input.metrics.optionMark as number,
    outcomes: { d1: null, d3: null, d5: null },
  };
}

function metricsFor(interval: UnusualInterval, entry: VolumeLedger): UnusualMetrics {
  const mark = interval.mark;
  const total = entry.ask + entry.bid + entry.mid + entry.unknown;
  const askShare = total > 0 ? entry.ask / total : null;
  const bidShare = total > 0 ? entry.bid / total : null;
  const sideSource: SideSource = entry.trade > 0 && entry.estimate > 0
    ? "mixed"
    : entry.trade > 0
      ? "trade"
      : "estimate";
  return {
    volume: interval.volume,
    openInterest: interval.openInterest,
    volOiRatio: volumeOiRatio(interval.volume, interval.openInterest),
    premium: notionalPremium(interval.volume, mark),
    askSidePremium: notionalPremium(entry.ask, mark),
    askShare,
    bidShare,
    sideSource,
    sideNote: sideSource === "trade" ? TRADE_SHARE_NOTE : sideSource === "mixed" ? MIXED_SHARE_NOTE : ESTIMATE_SHARE_NOTE,
    dte: interval.dte,
    otmFraction: signedOtmFraction(interval.putCall, interval.strike, interval.underlyingPrice),
    sweepLike: entry.burst,
    sweepNote: SWEEP_NOTE,
    optionMark: mark,
  };
}

function attribute(entry: VolumeLedger, interval: UnusualInterval, fallback: SideRead): void {
  const trades = interval.trades ?? [];
  let covered = 0;
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (!(trade.size > 0) || !Number.isFinite(trade.size)) continue;
    const aggressor = trade.aggressor ?? null;
    const read: SideRead = aggressor
      ? { side: aggressor, source: "trade" }
      : {
        side: sideFromEstimate(estimateSide(
          finitePrice(trade.bid) ?? interval.bid,
          finitePrice(trade.ask) ?? interval.ask,
          finitePrice(trade.price) ?? interval.last,
        ).label),
        source: "estimate",
      };
    addSide(entry, trade.size, read);
    covered += trade.size;
  }
  const jump = positiveJump(interval.volumeJump);
  if (trades.length > 0) {
    const remainder = jump == null ? 0 : jump - covered;
    if (remainder > 1e-9) addSide(entry, remainder, fallback);
    return;
  }
  if (jump != null && jump > 0) addSide(entry, jump, fallback);
}

function addSide(entry: VolumeLedger, size: number, read: SideRead): void {
  if (read.side === "ask") entry.ask += size;
  else if (read.side === "bid") entry.bid += size;
  else if (read.side === "mid") entry.mid += size;
  else entry.unknown += size;
  if (read.source === "trade") entry.trade += size;
  else entry.estimate += size;
}

function fillOutcomes(flag: UnusualFlag, interval: UnusualInterval, now: Date): boolean {
  if (interval.underlyingPrice == null || !(interval.underlyingPrice > 0)) return false;
  if (interval.mark == null || !(interval.mark > 0)) return false;
  if (!(flag.underlyingPrice > 0) || !(flag.optionMark > 0)) return false;
  const elapsed = chicagoTradingDaysElapsed(new Date(flag.flaggedAt), now);
  const day = chicagoDate(now);
  if (!day) return false;
  let filled = false;
  const slots: { day: UnusualOutcomeDay; key: "d1" | "d3" | "d5" }[] = [
    { day: 1, key: "d1" },
    { day: 3, key: "d3" },
    { day: 5, key: "d5" },
  ];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (flag.outcomes[slot.key]) continue;
    if (elapsed !== slot.day) continue;
    flag.outcomes[slot.key] = {
      tradingDays: slot.day,
      at: now.getTime(),
      tradingDay: day,
      underlyingPrice: interval.underlyingPrice,
      optionMark: interval.mark,
      underlyingChange: (interval.underlyingPrice - flag.underlyingPrice) / flag.underlyingPrice,
      optionChange: (interval.mark - flag.optionMark) / flag.optionMark,
    };
    filled = true;
  }
  return filled;
}

function pruneFlags(flags: UnusualFlag[], today: string): UnusualFlag[] {
  const cutoff = addCalendarDays(today, -UNUSUAL_KEEP_AFTER_EXPIRY_DAYS);
  const kept = flags.filter((flag) => flag.expiration >= cutoff);
  kept.sort((a, b) => b.flaggedAt - a.flaggedAt);
  return kept.slice(0, UNUSUAL_FLAG_CAP);
}

function compareFlags(a: UnusualFlag, b: UnusualFlag, key: UnusualSortKey): number {
  if (key === "time") return a.flaggedAt - b.flaggedAt;
  if (key === "symbol") return a.symbol.localeCompare(b.symbol) || a.strike - b.strike;
  if (key === "premium") return (a.metrics.premium ?? -1) - (b.metrics.premium ?? -1);
  if (key === "volOi") return (a.metrics.volOiRatio ?? -1) - (b.metrics.volOiRatio ?? -1);
  if (key === "askShare") return (a.metrics.askShare ?? -1) - (b.metrics.askShare ?? -1);
  if (key === "dte") return (a.metrics.dte ?? -1) - (b.metrics.dte ?? -1);
  if (key === "otm") return (a.metrics.otmFraction ?? -1) - (b.metrics.otmFraction ?? -1);
  return Number(a.metrics.sweepLike) - Number(b.metrics.sweepLike);
}

function briefRow(flag: UnusualFlag): BriefUnusualRow {
  return {
    preset: flag.preset,
    symbol: flag.symbol,
    putCall: flag.putCall,
    strike: flag.strike,
    expiration: flag.expiration,
    premium: flag.metrics.premium,
    volOiRatio: flag.metrics.volOiRatio,
    askShare: flag.metrics.askShare,
    sideSource: flag.metrics.sideSource,
    sweepLike: flag.metrics.sweepLike,
    underlyingPrice: flag.underlyingPrice,
    flaggedAt: new Date(flag.flaggedAt).toISOString(),
  };
}

function sideFromEstimate(label: EstimatedSideLabel): TapeSide | "unknown" {
  if (label === "estimated at ask") return "ask";
  if (label === "estimated at bid") return "bid";
  if (label === "estimated mid") return "mid";
  return "unknown";
}

function positiveJump(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function emptyLedger(): VolumeLedger {
  return { ask: 0, bid: 0, mid: 0, unknown: 0, trade: 0, estimate: 0, burst: false };
}

function copyLedger(ledger: Record<string, VolumeLedger>): Record<string, VolumeLedger> {
  const copy: Record<string, VolumeLedger> = {};
  const keys = Object.keys(ledger);
  for (let i = 0; i < keys.length; i++) copy[keys[i]] = { ...ledger[keys[i]] };
  return copy;
}

function ledgerStamp(entry: VolumeLedger): string {
  return `${entry.ask}|${entry.bid}|${entry.mid}|${entry.unknown}|${entry.trade}|${entry.estimate}`;
}

function copyFlag(flag: UnusualFlag): UnusualFlag {
  return {
    ...flag,
    metrics: { ...flag.metrics },
    outcomes: {
      d1: flag.outcomes.d1 ? { ...flag.outcomes.d1 } : null,
      d3: flag.outcomes.d3 ? { ...flag.outcomes.d3 } : null,
      d5: flag.outcomes.d5 ? { ...flag.outcomes.d5 } : null,
    },
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function finitePositive(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function finitePrice(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseTrades(value: unknown): TradePrint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const trades: TradePrint[] = [];
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    const trade = row as { size?: unknown; aggressor?: unknown; price?: unknown; bid?: unknown; ask?: unknown };
    const size = typeof trade.size === "number" && Number.isFinite(trade.size) && trade.size > 0 ? trade.size : null;
    if (size == null) continue;
    trades.push({
      size,
      aggressor: parseTradeAggressor(trade.aggressor),
      price: typeof trade.price === "number" ? trade.price : null,
      bid: typeof trade.bid === "number" ? trade.bid : null,
      ask: typeof trade.ask === "number" ? trade.ask : null,
    });
  }
  return trades;
}

function parseLedger(value: unknown): Record<string, VolumeLedger> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, VolumeLedger> = {};
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  for (let i = 0; i < keys.length; i++) {
    const row = body[keys[i]];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const entry = row as Partial<VolumeLedger>;
    out[keys[i]] = {
      ask: count(entry.ask),
      bid: count(entry.bid),
      mid: count(entry.mid),
      unknown: count(entry.unknown),
      trade: count(entry.trade),
      estimate: count(entry.estimate),
      burst: entry.burst === true,
    };
  }
  return out;
}

function parseFlag(value: unknown): UnusualFlag | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<UnusualFlag>;
  if (row.preset !== "bullish" && row.preset !== "bearish") return null;
  if (row.putCall !== "call" && row.putCall !== "put") return null;
  if (typeof row.id !== "string" || typeof row.symbol !== "string" || typeof row.contractKey !== "string") return null;
  if (typeof row.expiration !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiration)) return null;
  if (typeof row.tradingDay !== "string" || typeof row.flaggedAt !== "number") return null;
  if (typeof row.strike !== "number" || typeof row.underlyingPrice !== "number" || typeof row.optionMark !== "number") return null;
  const metrics = parseMetrics(row.metrics);
  if (!metrics) return null;
  const outcomes = row.outcomes;
  if (!outcomes || typeof outcomes !== "object") return null;
  return {
    id: row.id,
    preset: row.preset,
    flaggedAt: row.flaggedAt,
    tradingDay: row.tradingDay,
    symbol: row.symbol,
    putCall: row.putCall,
    strike: row.strike,
    expiration: row.expiration,
    contractKey: row.contractKey,
    metrics,
    underlyingPrice: row.underlyingPrice,
    optionMark: row.optionMark,
    outcomes: {
      d1: parseHorizon(outcomes.d1, 1),
      d3: parseHorizon(outcomes.d3, 3),
      d5: parseHorizon(outcomes.d5, 5),
    },
  };
}

function parseMetrics(value: unknown): UnusualMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<UnusualMetrics>;
  if (typeof row.volume !== "number" || typeof row.openInterest !== "number") return null;
  const sideSource: SideSource = row.sideSource === "trade" || row.sideSource === "mixed" ? row.sideSource : "estimate";
  return {
    volume: row.volume,
    openInterest: row.openInterest,
    volOiRatio: numOrNull(row.volOiRatio),
    premium: numOrNull(row.premium),
    askSidePremium: numOrNull(row.askSidePremium),
    askShare: numOrNull(row.askShare),
    bidShare: numOrNull(row.bidShare),
    sideSource,
    sideNote: typeof row.sideNote === "string" ? row.sideNote : ESTIMATE_SHARE_NOTE,
    dte: numOrNull(row.dte),
    otmFraction: numOrNull(row.otmFraction),
    sweepLike: row.sweepLike === true,
    sweepNote: typeof row.sweepNote === "string" ? row.sweepNote : SWEEP_NOTE,
    optionMark: numOrNull(row.optionMark),
  };
}

function parseHorizon(value: unknown, day: UnusualOutcomeDay): UnusualHorizon | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<UnusualHorizon>;
  if (row.tradingDays !== day) return null;
  if (typeof row.at !== "number" || typeof row.tradingDay !== "string") return null;
  if (typeof row.underlyingPrice !== "number" || typeof row.optionMark !== "number") return null;
  if (typeof row.underlyingChange !== "number" || typeof row.optionChange !== "number") return null;
  return {
    tradingDays: day,
    at: row.at,
    tradingDay: row.tradingDay,
    underlyingPrice: row.underlyingPrice,
    optionMark: row.optionMark,
    underlyingChange: row.underlyingChange,
    optionChange: row.optionChange,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
