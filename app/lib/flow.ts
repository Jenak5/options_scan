import type { OptionContract, PutCall } from "@/app/lib/contract";
import type { EarningsFact } from "@/app/lib/eventRisk";
import type { KeyLevels } from "@/app/lib/levels";
import { ALERT_RULES, PRINT_RULES } from "@/app/lib/alertConfig";
import { checkBidAskSpread, openInterestPasses, volumePasses } from "@/app/lib/gate";
import {
  detectPrints,
  quotePointFromContract,
  type FlowQuotePoint,
  type PrintRead,
} from "@/app/lib/prints";
import {
  MAX_BID_ASK_SPREAD_OF_MID,
  MIN_CONTRACT_VOLUME,
  MIN_OPEN_INTEREST,
} from "@/app/lib/risk";

/**
 * Estimated options flow from a Schwab chain.
 *
 * These functions do not call the network. They score contracts the
 * Market Data client already parsed. Nothing here is a sweep print.
 * Side is a comparison of the last price to the bid and ask.
 */

export const FLOW_DISCLAIMER =
  "Estimated flow from Schwab volume/open interest, not true sweeps.";

export const DEFAULT_FLOW_WATCHLIST = [
  "SPY", "QQQ", "IWM", "AAPL", "NVDA", "TSLA", "AMD", "AMZN",
  "MSFT", "META", "GOOGL", "PLTR", "SOFI", "NFLX", "COIN",
] as const;

/** Near-the-money strikes above and below the underlying. Sent as strikeCount. */
export const FLOW_STRIKE_COUNT = 6;

/**
 * Schwab has no "expiration count" parameter. The request uses this date window,
 * about six weeks, then scoring keeps expirations that can grade A or B
 * ahead of the very short-dated ones.
 */
export const FLOW_DATE_WINDOW_DAYS = 45;

/** Enough for a few expirations a week across the 2–6 week window, plus shorter dates for review. */
export const FLOW_MAX_EXPIRATIONS = 24;

export const FLOW_MAX_WATCHLIST = 20;

/** Leave headroom under Schwab's about-120 requests per minute. */
export const FLOW_MAX_REQUESTS_PER_MINUTE = 100;

export const FLOW_BATCH_SIZE = 3;

export const FLOW_CACHE_MS = 60_000;

export const SIDE_NOTE =
  "Estimated from the last price versus the bid and ask. Not a sweep print.";

export type EstimatedSideLabel =
  | "estimated at ask"
  | "estimated at bid"
  | "estimated mid"
  | "estimated unknown";

export type SpreadQuality = "tight" | "acceptable" | "wide" | "unknown";

export interface EstimatedSide {
  label: EstimatedSideLabel;
  /** 0 is the bid, 1 is the ask. Null when the quote cannot be compared. */
  askFraction: number | null;
  note: string;
}

export interface FlowVolumeSnapshot {
  scannedAt: number;
  volumes: Record<string, number>;
  /** Recent quote points per contract, oldest first. Missing on older snapshots. */
  quotes?: Record<string, FlowQuotePoint[]>;
}

export interface FlowRow {
  id: string;
  ticker: string;
  putCall: PutCall;
  strike: number;
  expiration: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number | null;
  delta: number | null;
  mid: number | null;
  /** volume × mid × 100. Null when the quote has no positive midpoint. */
  notionalPremium: number | null;
  volOiRatio: number | null;
  /** Today's volume minus open interest. Positive means volume exceeds existing OI. */
  volumeOiJump: number | null;
  volumeExceedsOi: boolean;
  /** Prior same-day volume. Null on the first scan of the session. */
  previousVolume: number | null;
  /** Volume change since the previous same-day snapshot. */
  volumeJump: number | null;
  otmPoints: number | null;
  otmFraction: number | null;
  otm: boolean | null;
  dte: number | null;
  spreadFraction: number | null;
  spreadQuality: SpreadQuality;
  side: EstimatedSideLabel;
  sideNote: string;
  askFraction: number | null;
  liquidityPasses: boolean;
  delayed: boolean;
  underlyingPrice: number | null;
  /** Support and resistance for this ticker. Null until a history read fills them. */
  levels: KeyLevels | null;
  /** Quote-derived prints. Null summary when no new trade was seen. */
  prints: PrintRead;
  /** Next earnings read. Missing means the grade treats the date as unknown. */
  earnings?: EarningsFact | null;
  score: number;
}

export interface FlowFilter {
  minPremium: number;
  otmOnly: boolean;
  liquidOnly: boolean;
  limit: number;
}

const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export function parseWatchlist(
  raw: string | null | undefined,
  fallback: readonly string[] = DEFAULT_FLOW_WATCHLIST,
): string[] {
  const source = raw && raw.trim() ? raw : fallback.join(",");
  const seen = new Set<string>();
  const out: string[] = [];
  const parts = source.split(/[\s,]+/);
  for (let i = 0; i < parts.length; i++) {
    const ticker = parts[i].trim().toUpperCase();
    if (!TICKER_PATTERN.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
    if (out.length >= FLOW_MAX_WATCHLIST) break;
  }
  if (out.length > 0) return out;
  return fallback.slice(0, FLOW_MAX_WATCHLIST);
}

export function watchlistFromEnv(raw: string | undefined): string[] {
  return parseWatchlist(raw);
}

export function isFlowTicker(value: string): boolean {
  return TICKER_PATTERN.test(value.trim().toUpperCase());
}

export function newYorkDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function calendarDaysBetween(fromYmd: string, toYmd: string): number | null {
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Chain request limited to near-the-money strikes and about six weeks of expirations.
 * Still only the chains endpoint. Scoring then prefers the 2–6 week window.
 */
export function flowChainRequest(symbol: string, now: Date): {
  symbol: string;
  contractType: "ALL";
  range: "NTM";
  strikeCount: number;
  fromDate: string;
  toDate: string;
} {
  const fromDate = newYorkDate(now);
  return {
    symbol: symbol.trim().toUpperCase(),
    contractType: "ALL",
    range: "NTM",
    strikeCount: FLOW_STRIKE_COUNT,
    fromDate,
    toDate: addCalendarDays(fromDate, FLOW_DATE_WINDOW_DAYS),
  };
}

export function flowContractKey(contract: {
  expiration: string;
  strike: number;
  putCall: string;
}): string {
  return `${contract.expiration}|${contract.strike}|${contract.putCall}`;
}

/** volume × midpoint × 100. */
export function notionalPremium(volume: number, mid: number | null): number | null {
  if (mid == null || !Number.isFinite(mid) || mid <= 0) return null;
  if (!Number.isFinite(volume) || volume < 0) return null;
  return volume * mid * 100;
}

export function volumeOiRatio(volume: number, openInterest: number): number | null {
  if (!Number.isFinite(volume) || volume < 0) return null;
  if (!Number.isFinite(openInterest) || openInterest <= 0) return null;
  return volume / openInterest;
}

/** Today's volume minus open interest. */
export function volumeOiJump(volume: number, openInterest: number): number | null {
  if (!Number.isFinite(volume) || !Number.isFinite(openInterest)) return null;
  return volume - openInterest;
}

export function volumeSinceLastScan(
  volume: number,
  previous: FlowVolumeSnapshot | null,
  contractKey: string,
  now: Date,
): { previousVolume: number | null; volumeJump: number | null } {
  if (!previous || !Number.isFinite(volume)) return { previousVolume: null, volumeJump: null };
  if (!sameNewYorkDate(previous.scannedAt, now)) return { previousVolume: null, volumeJump: null };
  const prior = previous.volumes[contractKey];
  if (typeof prior !== "number" || !Number.isFinite(prior)) return { previousVolume: null, volumeJump: null };
  return { previousVolume: prior, volumeJump: volume - prior };
}

/**
 * Last price against the bid/ask.
 * At or above 65% of the spread is labeled estimated at ask.
 * At or below 35% is labeled estimated at bid.
 */
export function estimateSide(bid: number, ask: number, last: number): EstimatedSide {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(last) || bid < 0 || ask < 0 || ask < bid) {
    return { label: "estimated unknown", askFraction: null, note: SIDE_NOTE };
  }
  if (ask === bid) {
    if (last > ask) return { label: "estimated at ask", askFraction: 1, note: SIDE_NOTE };
    if (last < bid) return { label: "estimated at bid", askFraction: 0, note: SIDE_NOTE };
    return { label: "estimated mid", askFraction: 0.5, note: SIDE_NOTE };
  }
  const fraction = (last - bid) / (ask - bid);
  const clamped = clamp(fraction, 0, 1);
  // Epsilon keeps a price that lands on 65% or 35% from drifting across the line.
  if (last >= ask - 1e-8 || fraction >= 0.65 - 1e-8) return { label: "estimated at ask", askFraction: clamped, note: SIDE_NOTE };
  if (last <= bid + 1e-8 || fraction <= 0.35 + 1e-8) return { label: "estimated at bid", askFraction: clamped, note: SIDE_NOTE };
  return { label: "estimated mid", askFraction: clamped, note: SIDE_NOTE };
}

export function otmDistance(putCall: PutCall, strike: number, underlying: number | null): {
  points: number | null;
  fraction: number | null;
  otm: boolean | null;
} {
  if (underlying == null || !Number.isFinite(underlying) || underlying <= 0 || !Number.isFinite(strike)) {
    return { points: null, fraction: null, otm: null };
  }
  const raw = putCall === "call" ? strike - underlying : underlying - strike;
  const points = Math.max(0, raw);
  return { points, fraction: points / underlying, otm: raw > 0 };
}

export function spreadQualityOf(fraction: number | null, passes: boolean): SpreadQuality {
  if (fraction == null || !Number.isFinite(fraction)) return "unknown";
  if (!passes) return "wide";
  if (fraction <= 0.02) return "tight";
  return "acceptable";
}

export interface LiquidityResult {
  openInterest: boolean;
  volume: boolean;
  spread: boolean;
  passes: boolean;
  spreadFraction: number | null;
  mid: number | null;
}

/** Same bars as the trade gate: OI >= 500, volume >= 100, spread <= 5% of mid. */
export function liquidityOf(contract: OptionContract): LiquidityResult {
  const spread = checkBidAskSpread(contract.bid, contract.ask);
  const openInterest = openInterestPasses(contract.openInterest, MIN_OPEN_INTEREST);
  const volume = volumePasses(contract.volume, MIN_CONTRACT_VOLUME);
  return {
    openInterest,
    volume,
    spread: spread.pass,
    passes: openInterest && volume && spread.pass,
    spreadFraction: spread.fraction,
    mid: spread.mid,
  };
}

/**
 * Drop expired contracts, then keep up to `count` expirations.
 * Dates inside the A/B window come first, then shorter dates, then anything further out.
 */
export function keepScanExpirations(
  contracts: OptionContract[],
  count: number,
  today: string,
): OptionContract[] {
  const dates = new Set<string>();
  for (let i = 0; i < contracts.length; i++) {
    const expiration = contracts[i].expiration;
    if (expiration >= today) dates.add(expiration);
  }
  const ranked: { expiration: string; rank: number; dte: number }[] = [];
  dates.forEach((expiration) => {
    const dte = calendarDaysBetween(today, expiration);
    const days = dte == null ? 9_999 : dte;
    let rank = 2;
    if (days >= ALERT_RULES.alertDteMin && days <= ALERT_RULES.alertDteMax) rank = 0;
    else if (days >= 0 && days < ALERT_RULES.alertDteMin) rank = 1;
    ranked.push({ expiration, rank, dte: days });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.dte - b.dte || a.expiration.localeCompare(b.expiration));
  const allowed = new Set(ranked.slice(0, Math.max(0, count)).map((row) => row.expiration));
  return contracts.filter((contract) => allowed.has(contract.expiration));
}

export function keepNearestExpirations(
  contracts: OptionContract[],
  count: number,
  today: string,
): OptionContract[] {
  const dates = new Set<string>();
  for (let i = 0; i < contracts.length; i++) {
    const expiration = contracts[i].expiration;
    if (expiration >= today) dates.add(expiration);
  }
  const nearest = Array.from(dates).sort().slice(0, Math.max(0, count));
  const allowed = new Set(nearest);
  return contracts.filter((contract) => allowed.has(contract.expiration));
}

export function scoreChain(input: {
  ticker: string;
  contracts: OptionContract[];
  underlyingPrice: number | null;
  delayed: boolean;
  previous: FlowVolumeSnapshot | null;
  now: Date;
  maxExpirations?: number;
  /** Quote points from this scan, including any short follow-up reads. */
  livePoints?: Record<string, FlowQuotePoint[]>;
}): FlowRow[] {
  const today = newYorkDate(input.now);
  const limited = keepScanExpirations(
    input.contracts,
    input.maxExpirations ?? FLOW_MAX_EXPIRATIONS,
    today,
  );
  const byKey = new Map<string, OptionContract>();
  for (let i = 0; i < limited.length; i++) {
    const contract = limited[i];
    const key = flowContractKey(contract);
    const prior = byKey.get(key);
    if (!prior || finiteOrZero(contract.volume) >= finiteOrZero(prior.volume)) byKey.set(key, contract);
  }
  const rows: FlowRow[] = [];
  byKey.forEach((contract, key) => {
    const dte = calendarDaysBetween(today, contract.expiration);
    if (dte == null || dte < 0) return;
    rows.push(scoreContract({
      ticker: input.ticker,
      contract,
      key,
      underlyingPrice: input.underlyingPrice,
      delayed: input.delayed,
      previous: input.previous,
      now: input.now,
      dte,
      livePoints: input.livePoints?.[key] ?? null,
    }));
  });
  rows.sort((a, b) => b.score - a.score || (b.notionalPremium ?? 0) - (a.notionalPremium ?? 0));
  return rows;
}

export function snapshotFromRows(rows: FlowRow[], scannedAt: number): FlowVolumeSnapshot {
  const volumes: Record<string, number> = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Number.isFinite(row.volume) || row.volume < 0) continue;
    volumes[flowContractKey(row)] = row.volume;
  }
  return { scannedAt, volumes };
}

export function sameDayQuotePoints(points: FlowQuotePoint[] | undefined, now: Date): FlowQuotePoint[] {
  if (!points) return [];
  const today = newYorkDate(now);
  const kept: FlowQuotePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!Number.isFinite(point.at)) continue;
    if (newYorkDate(new Date(point.at)) !== today) continue;
    kept.push(point);
  }
  return kept.slice(-PRINT_RULES.historyPoints);
}

export function filterFlowRows(rows: FlowRow[], filter: FlowFilter): FlowRow[] {
  const min = Number.isFinite(filter.minPremium) && filter.minPremium > 0 ? filter.minPremium : 0;
  const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : rows.length;
  const kept = rows.filter((row) => {
    if (filter.liquidOnly && !row.liquidityPasses) return false;
    if (filter.otmOnly && row.otm !== true) return false;
    if (min > 0 && (row.notionalPremium == null || row.notionalPremium < min)) return false;
    return true;
  });
  kept.sort((a, b) => b.score - a.score || (b.notionalPremium ?? 0) - (a.notionalPremium ?? 0));
  return kept.slice(0, limit);
}

/**
 * Alerts require the gate liquidity filters.
 * Minimum premium and the optional OTM flag are the existing alert settings.
 */
export function selectAlertRows(rows: FlowRow[], options: {
  minPremium: number;
  otmOnly: boolean;
  limit: number;
}): FlowRow[] {
  return filterFlowRows(rows, {
    minPremium: options.minPremium,
    otmOnly: options.otmOnly,
    liquidOnly: true,
    limit: options.limit,
  });
}

export function gateCheckHref(row: {
  ticker: string;
  expiration: string;
  strike: number;
  putCall: string;
  mid: number | null;
}): string {
  const params = new URLSearchParams();
  params.set("ticker", row.ticker);
  params.set("expiration", row.expiration);
  params.set("strike", String(row.strike));
  params.set("putCall", row.putCall);
  if (row.mid != null && Number.isFinite(row.mid) && row.mid > 0) {
    params.set("plannedEntry", row.mid.toFixed(2));
  }
  return `/gate?${params.toString()}`;
}

export function flowScore(input: {
  notionalPremium: number | null;
  volOiRatio: number | null;
  volumeExceedsOi: boolean;
  volumeJump: number | null;
  otmFraction: number | null;
  dte: number | null;
  spreadQuality: SpreadQuality;
  side: EstimatedSideLabel;
  block?: boolean;
  sweepLike?: boolean;
  printDetected?: boolean;
}): number {
  let score = 0;
  if (input.notionalPremium != null && input.notionalPremium > 0) {
    score += clamp((Math.log10(input.notionalPremium) - 3) * 12, 0, 40);
  }
  if (input.volOiRatio != null && input.volOiRatio > 0) {
    score += clamp(input.volOiRatio * 12, 0, 24);
  }
  if (input.volumeExceedsOi) score += 8;
  if (input.volumeJump != null && input.volumeJump > 0) {
    score += clamp(Math.log10(input.volumeJump + 1) * 6, 0, 16);
  }
  if (input.otmFraction != null && input.otmFraction > 0 && input.otmFraction <= 0.08) score += 6;
  else if (input.otmFraction != null && input.otmFraction > 0.08 && input.otmFraction <= 0.15) score += 3;
  if (input.dte != null && input.dte >= ALERT_RULES.alertDteMin && input.dte <= ALERT_RULES.alertDteMax) score += 6;
  else if (input.dte != null && input.dte >= 0 && input.dte < ALERT_RULES.alertDteMin) score += 1;
  else if (input.dte != null && input.dte > ALERT_RULES.alertDteMax && input.dte <= ALERT_RULES.alertDteMax + 21) score += 2;
  if (input.spreadQuality === "tight") score += 6;
  else if (input.spreadQuality === "acceptable") score += 3;
  else if (input.spreadQuality === "wide") score -= 10;
  if (input.side === "estimated at ask") score += 6;
  else if (input.side === "estimated mid") score += 2;
  if (input.printDetected) score += PRINT_RULES.printScore;
  if (input.block) score += PRINT_RULES.blockScore;
  if (input.sweepLike) score += PRINT_RULES.sweepScore;
  return Math.round(score * 10) / 10;
}

function scoreContract(input: {
  ticker: string;
  contract: OptionContract;
  key: string;
  underlyingPrice: number | null;
  delayed: boolean;
  previous: FlowVolumeSnapshot | null;
  now: Date;
  dte: number;
  livePoints: FlowQuotePoint[] | null;
}): FlowRow {
  const contract = input.contract;
  const liquidity = liquidityOf(contract);
  const side = estimateSide(contract.bid, contract.ask, contract.last);
  const distance = otmDistance(contract.putCall, contract.strike, input.underlyingPrice);
  const ratio = volumeOiRatio(contract.volume, contract.openInterest);
  const oiJump = volumeOiJump(contract.volume, contract.openInterest);
  const jumped = volumeSinceLastScan(contract.volume, input.previous, input.key, input.now);
  const quality = spreadQualityOf(liquidity.spreadFraction, liquidity.spread);
  const notional = notionalPremium(contract.volume, liquidity.mid);
  const exceeds = oiJump != null && oiJump > 0;
  const priorPoints = sameDayQuotePoints(input.previous?.quotes?.[input.key], input.now);
  const live = input.livePoints && input.livePoints.length > 0
    ? input.livePoints
    : [quotePointFromContract(contract, input.now.getTime())];
  const prints = detectPrints({ points: priorPoints.concat(live), delayed: input.delayed });
  const score = flowScore({
    notionalPremium: notional,
    volOiRatio: ratio,
    volumeExceedsOi: exceeds,
    volumeJump: jumped.volumeJump,
    otmFraction: distance.fraction,
    dte: input.dte,
    spreadQuality: quality,
    side: side.label,
    block: prints.block,
    sweepLike: prints.sweepLike,
    printDetected: prints.summary != null,
  });
  return {
    id: `${input.ticker}|${input.key}`,
    ticker: input.ticker,
    putCall: contract.putCall,
    strike: contract.strike,
    expiration: contract.expiration,
    bid: contract.bid,
    ask: contract.ask,
    last: contract.last,
    volume: contract.volume,
    openInterest: contract.openInterest,
    iv: contract.iv,
    delta: contract.delta,
    mid: liquidity.mid,
    notionalPremium: notional,
    volOiRatio: ratio,
    volumeOiJump: oiJump,
    volumeExceedsOi: exceeds,
    previousVolume: jumped.previousVolume,
    volumeJump: jumped.volumeJump,
    otmPoints: distance.points,
    otmFraction: distance.fraction,
    otm: distance.otm,
    dte: input.dte,
    spreadFraction: liquidity.spreadFraction,
    spreadQuality: quality,
    side: side.label,
    sideNote: side.note,
    askFraction: side.askFraction,
    liquidityPasses: liquidity.passes,
    delayed: input.delayed,
    underlyingPrice: input.underlyingPrice,
    levels: null,
    prints,
    score,
  };
}

function sameNewYorkDate(scannedAt: number, now: Date): boolean {
  if (!Number.isFinite(scannedAt)) return false;
  const prior = new Date(scannedAt);
  if (Number.isNaN(prior.getTime())) return false;
  return newYorkDate(prior) === newYorkDate(now);
}

function parseYmd(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const FLOW_LIQUIDITY_RULES = {
  minOpenInterest: MIN_OPEN_INTEREST,
  minVolume: MIN_CONTRACT_VOLUME,
  maxSpreadFraction: MAX_BID_ASK_SPREAD_OF_MID,
};
