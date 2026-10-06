import type { PutCall } from "@/app/lib/contract";
import { flowContractKey, type EstimatedSideLabel, type FlowRow, type FlowVolumeSnapshot } from "@/app/lib/flow";
import { chicagoClock, isChicagoMarketHours } from "@/app/lib/marketHours";
import { MIN_CONTRACT_VOLUME } from "@/app/lib/risk";

/**
 * Extra facts saved with an alert. They do not add a Schwab request.
 * Trend uses the VWAP and the 20-day average already computed from price history.
 * SPY and QQQ direction uses those names when they are already in the same scan.
 * Repeat flow and IV versus recent use the volume snapshot the scan already stores.
 * A paired spread or hedge is read from the chain already in hand.
 */

export const OPENING_QUIET_MINUTES = 15;
export const CHICAGO_OPEN_MINUTES = 8 * 60 + 30;

/** Midpoint at or under this is cheap enough for the extra dollar spread cap. */
export const CHEAP_CONTRACT_MID = 3;

/** On a cheap contract the spread must also be at or under this many dollars. */
export const CHEAP_MAX_SPREAD_DOLLARS = 0.10;

export type PriceSide = "above" | "below" | "flat" | "unknown";
export type TrendAlignment = "with" | "against" | "mixed" | "unknown";
export type IndexDirection = "up" | "down" | "flat" | "unknown";
export type AggressorSide = "buy" | "sell" | "mid" | "unknown";
export type RepeatFlow = "contract" | "ticker" | "none" | "unknown";
export type PairedFlow = "spread" | "hedge" | "none" | "unknown";

export interface FlowContext {
  minutesSinceOpen: number | null;
  priceVsVwap: PriceSide;
  priceVsSma20: PriceSide;
  trendAlignment: TrendAlignment;
  spyDirection: IndexDirection;
  qqqDirection: IndexDirection;
  marketAlignment: TrendAlignment;
  /** Current IV divided by the prior session's IV, minus 1. Null when either IV was not stored. */
  ivVsRecent: number | null;
  aggressor: AggressorSide;
  repeatFlow: RepeatFlow;
  pairedFlow: PairedFlow;
}

export interface PairContract {
  strike: number;
  expiration: string;
  putCall: PutCall;
  volume: number;
}

const FLAT_BAND = 0.0005;

export function emptyContext(): FlowContext {
  return {
    minutesSinceOpen: null,
    priceVsVwap: "unknown",
    priceVsSma20: "unknown",
    trendAlignment: "unknown",
    spyDirection: "unknown",
    qqqDirection: "unknown",
    marketAlignment: "unknown",
    ivVsRecent: null,
    aggressor: "unknown",
    repeatFlow: "unknown",
    pairedFlow: "unknown",
  };
}

/** Minutes after 8:30 America/Chicago. Null when the session is closed, so the quiet period does not apply. */
export function minutesSinceOpen(now: Date): number | null {
  if (!isChicagoMarketHours(now)) return null;
  const clock = chicagoClock(now);
  if (!clock) return null;
  return clock.minutes - CHICAGO_OPEN_MINUTES;
}

export function openingNoise(now: Date): boolean {
  const minutes = minutesSinceOpen(now);
  return minutes != null && minutes < OPENING_QUIET_MINUTES;
}

export function priceVersus(price: number | null | undefined, reference: number | null | undefined): PriceSide {
  if (price == null || reference == null || !(price > 0) || !(reference > 0)) return "unknown";
  if (!Number.isFinite(price) || !Number.isFinite(reference)) return "unknown";
  const gap = (price - reference) / reference;
  if (Math.abs(gap) < FLAT_BAND) return "flat";
  return gap > 0 ? "above" : "below";
}

export function trendFromPrices(
  putCall: PutCall,
  price: number | null,
  vwap: number | null,
  sma20: number | null,
): { priceVsVwap: PriceSide; priceVsSma20: PriceSide; trendAlignment: TrendAlignment } {
  const priceVsVwap = priceVersus(price, vwap);
  const priceVsSma20 = priceVersus(price, sma20);
  const vwapSide = directional(putCall, priceVsVwap);
  const smaSide = directional(putCall, priceVsSma20);
  return { priceVsVwap, priceVsSma20, trendAlignment: combineAlignment(vwapSide, smaSide) };
}

export function indexDirection(price: number | null, vwap: number | null): IndexDirection {
  const versus = priceVersus(price, vwap);
  if (versus === "above") return "up";
  if (versus === "below") return "down";
  if (versus === "flat") return "flat";
  return "unknown";
}

/** Both indexes have to agree. One unknown or flat index stays unknown, so it cannot fail a trade. */
export function marketAlignment(putCall: PutCall, spy: IndexDirection, qqq: IndexDirection): TrendAlignment {
  if (spy === "unknown" || qqq === "unknown" || spy === "flat" || qqq === "flat") return "unknown";
  const spyWith = putCall === "call" ? spy === "up" : spy === "down";
  const qqqWith = putCall === "call" ? qqq === "up" : qqq === "down";
  if (spyWith && qqqWith) return "with";
  if (!spyWith && !qqqWith) return "against";
  return "mixed";
}

export function aggressorFromSide(side: EstimatedSideLabel | null | undefined): AggressorSide {
  if (side === "estimated at ask") return "buy";
  if (side === "estimated at bid") return "sell";
  if (side === "estimated mid") return "mid";
  return "unknown";
}

/**
 * Prior session only. The same-day snapshot is the volume jump, not a repeat across sessions.
 * Unknown when no prior session was stored. That is not treated as "no repeat".
 */
export function repeatFromSnapshot(contractKey: string, snapshot: FlowVolumeSnapshot | null | undefined): RepeatFlow {
  const prior = snapshot?.priorSession;
  if (!prior || !prior.volumes) return "unknown";
  const own = prior.volumes[contractKey];
  if (typeof own === "number" && own >= MIN_CONTRACT_VOLUME) return "contract";
  const keys = Object.keys(prior.volumes);
  for (let i = 0; i < keys.length; i++) {
    const volume = prior.volumes[keys[i]];
    if (typeof volume === "number" && volume >= MIN_CONTRACT_VOLUME) return "ticker";
  }
  return "none";
}

/** Fraction change versus the prior session. Null when either IV is missing. */
export function ivVersusRecent(current: number | null | undefined, prior: number | null | undefined): number | null {
  if (current == null || prior == null) return null;
  if (!(current > 0) || !(prior > 0) || !Number.isFinite(current) || !Number.isFinite(prior)) return null;
  return (current - prior) / prior;
}

/**
 * Similar size on the next strike, same expiry, is a likely vertical.
 * Similar size on the opposite right, same or next strike, is a likely hedge.
 * One contract with no sibling in the chain stays unknown.
 */
export function detectPairedFlow(row: PairContract, siblings: readonly PairContract[]): PairedFlow {
  const others = siblings.filter((item) => item.expiration === row.expiration && !(item.strike === row.strike && item.putCall === row.putCall));
  if (others.length === 0) return "unknown";
  const step = strikeStep(others.concat(row));
  let spread = false;
  let hedge = false;
  for (let i = 0; i < others.length; i++) {
    const other = others[i];
    if (!similarSize(row.volume, other.volume)) continue;
    const distance = Math.abs(other.strike - row.strike);
    const adjacent = step != null && distance > 0 && distance <= step * 1.01;
    if (other.putCall === row.putCall && adjacent) spread = true;
    if (other.putCall !== row.putCall && (distance === 0 || adjacent)) hedge = true;
  }
  if (hedge) return "hedge";
  if (spread) return "spread";
  return "none";
}

export function contextForRow(
  row: FlowRow,
  rows: readonly FlowRow[],
  snapshots: Readonly<Record<string, FlowVolumeSnapshot>>,
  now: Date,
): FlowContext {
  const trend = trendFromPrices(row.putCall, row.underlyingPrice, row.levels?.vwap ?? null, row.levels?.sma20 ?? null);
  const spy = indexQuote(rows, "SPY");
  const qqq = indexQuote(rows, "QQQ");
  const spyDirection = indexDirection(spy.price, spy.vwap);
  const qqqDirection = indexDirection(qqq.price, qqq.vwap);
  const snapshot = snapshots[row.ticker] ?? null;
  const contractKey = flowContractKey(row);
  const priorIv = snapshot?.priorSession?.ivs?.[contractKey] ?? null;
  const siblings = rows
    .filter((item) => item.ticker === row.ticker)
    .map((item) => ({ strike: item.strike, expiration: item.expiration, putCall: item.putCall, volume: item.volume }));
  return {
    minutesSinceOpen: minutesSinceOpen(now),
    priceVsVwap: trend.priceVsVwap,
    priceVsSma20: trend.priceVsSma20,
    trendAlignment: trend.trendAlignment,
    spyDirection,
    qqqDirection,
    marketAlignment: marketAlignment(row.putCall, spyDirection, qqqDirection),
    ivVsRecent: ivVersusRecent(row.iv, priorIv),
    aggressor: aggressorFromSide(row.side),
    repeatFlow: repeatFromSnapshot(contractKey, snapshot),
    pairedFlow: detectPairedFlow(
      { strike: row.strike, expiration: row.expiration, putCall: row.putCall, volume: row.volume },
      siblings,
    ),
  };
}

export function annotateFlowRows(
  rows: FlowRow[],
  snapshots: Readonly<Record<string, FlowVolumeSnapshot>>,
  now: Date,
): FlowRow[] {
  return rows.map((row) => ({ ...row, context: contextForRow(row, rows, snapshots, now) }));
}

/** Keep yesterday's snapshot when today's scan replaces it. Same-day updates keep the older prior session. */
export function carryPriorSession(
  previous: FlowVolumeSnapshot | null | undefined,
  next: FlowVolumeSnapshot,
  now: Date,
): FlowVolumeSnapshot {
  if (!previous || !Number.isFinite(previous.scannedAt)) return next;
  const prevDay = nyDay(previous.scannedAt);
  const today = nyDay(now.getTime());
  if (prevDay && today && prevDay !== today) {
    return {
      ...next,
      priorSession: {
        scannedAt: previous.scannedAt,
        volumes: previous.volumes,
        ivs: previous.ivs,
      },
    };
  }
  if (previous.priorSession) return { ...next, priorSession: previous.priorSession };
  return next;
}

function directional(putCall: PutCall, side: PriceSide): "with" | "against" | "unknown" {
  if (side === "unknown" || side === "flat") return "unknown";
  const bullish = side === "above";
  if (putCall === "call") return bullish ? "with" : "against";
  return bullish ? "against" : "with";
}

function combineAlignment(left: "with" | "against" | "unknown", right: "with" | "against" | "unknown"): TrendAlignment {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "with" && right === "with") return "with";
  if (left === "against" && right === "against") return "against";
  return "mixed";
}

function similarSize(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (left < MIN_CONTRACT_VOLUME || right < MIN_CONTRACT_VOLUME) return false;
  const low = Math.min(left, right);
  const high = Math.max(left, right);
  if (!(high > 0)) return false;
  return low / high >= 0.6;
}

function strikeStep(contracts: readonly PairContract[]): number | null {
  const strikes: number[] = [];
  for (let i = 0; i < contracts.length; i++) {
    const strike = contracts[i].strike;
    if (!Number.isFinite(strike) || strikes.indexOf(strike) !== -1) continue;
    strikes.push(strike);
  }
  if (strikes.length < 2) return null;
  strikes.sort((a, b) => a - b);
  let step = strikes[1] - strikes[0];
  for (let i = 2; i < strikes.length; i++) {
    const gap = strikes[i] - strikes[i - 1];
    if (gap > 0 && gap < step) step = gap;
  }
  return step > 0 ? step : null;
}

function indexQuote(rows: readonly FlowRow[], ticker: string): { price: number | null; vwap: number | null } {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.ticker !== ticker) continue;
    return { price: row.underlyingPrice, vwap: row.levels?.vwap ?? null };
  }
  return { price: null, vwap: null };
}

function nyDay(at: number): string {
  if (!Number.isFinite(at)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}
