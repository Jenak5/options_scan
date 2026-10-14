import { backfillFeatures, earningsFromLine, type AlertFeatureSnapshot, type EarningsProximity } from "@/app/lib/alertFeatures";
import type { StoredAlert } from "@/app/lib/alertBook";
import type { CandleBar } from "@/app/lib/candleTypes";
import { calendarDaysBetween, newYorkDate } from "@/app/lib/flow";
import { computeKeyLevels, type KeyLevels } from "@/app/lib/levels";
import {
  indexDirection,
  marketAlignment,
  minutesSinceOpen,
  trendFromPrices,
  type IndexDirection,
  type PriceSide,
  type TrendAlignment,
} from "@/app/lib/marketContext";
import type { PriceCandle } from "@/app/lib/schwabParse";

/**
 * Fill unknown grading inputs on past alerts from Tastytrade price history.
 * Only a field that is null or "unknown" is filled. A value saved at send time is never replaced.
 * Every filled field is listed in features.backfilled so it can be told apart from a captured one.
 * Implied vol, delta, the volume jump, IV versus recent, repeat flow, and paired flow are option-chain
 * snapshots. Tastytrade history does not keep them, so they stay null and are never guessed.
 */

export const BACKFILL_SOURCE = "tastytrade-history" as const;
export const INTRADAY_MINUTES = 5;
const INTRADAY_MS = INTRADAY_MINUTES * 60_000;
/** Daily bars needed before the first alert: 20 closes for the average plus swing points. */
export const DAILY_LOOKBACK_DAYS = 70;

export const NOT_RECOVERABLE: Readonly<Record<string, string>> = {
  iv: "Implied volatility at send time is an option-chain snapshot. Tastytrade history does not keep it.",
  delta: "Delta at send time is an option-chain snapshot. Tastytrade history does not keep it.",
  volumeJump: "The volume jump compares two same-day chain scans. Only the scans the scanner saved have it.",
  flowSignalCount: "Needs the volume jump, so it stays unknown when the jump is unknown.",
  ivVsRecent: "Needs implied vol on this and the prior session. Not in price history.",
  repeatFlow: "Needs the prior session's chain volumes, which were not saved for these alerts.",
  pairedFlow: "Needs the full option chain at send time.",
};

export type BackfillField =
  | "minutesSinceOpen"
  | "priceVsVwap"
  | "priceVsSma20"
  | "trendAlignment"
  | "spyDirection"
  | "qqqDirection"
  | "marketAlignment"
  | "earnings"
  | "rewardDistance"
  | "riskDistance";

export const BACKFILL_FIELDS: readonly BackfillField[] = [
  "minutesSinceOpen",
  "priceVsVwap",
  "priceVsSma20",
  "trendAlignment",
  "spyDirection",
  "qqqDirection",
  "marketAlignment",
  "earnings",
  "rewardDistance",
  "riskDistance",
];

export interface UnderlyingHistory {
  /** 5-minute bars with volume, stamped at the bar start. */
  intraday: readonly CandleBar[];
  /** Daily bars. */
  daily: readonly CandleBar[];
}

export interface EarningsHistory {
  /** YYYY-MM-DD dates the company reported, from Tastytrade's earnings history. */
  reported: readonly string[];
  /** Next expected report date from Tastytrade market metrics. Null when none is listed. */
  nextExpected: string | null;
}

export interface BackfillInputs {
  history: ReadonlyMap<string, UnderlyingHistory>;
  earnings: ReadonlyMap<string, EarningsHistory | null>;
  now: Date;
}

export interface AlertBackfill {
  features: AlertFeatureSnapshot;
  filled: BackfillField[];
}

const HOUR_MS = 3_600_000;
const nyDayByHour = new Map<number, string>();

/**
 * New York date for an epoch time. The date only changes on an hour boundary, so it is looked up
 * once per UTC hour and cached. Formatting every bar was the production hang.
 */
export function nyDay(at: number): string {
  const hour = Math.floor(at / HOUR_MS);
  let day = nyDayByHour.get(hour);
  if (day == null) {
    day = newYorkDate(new Date(hour * HOUR_MS));
    if (nyDayByHour.size > 50_000) nyDayByHour.clear();
    nyDayByHour.set(hour, day);
  }
  return day;
}

const nyHourByHour = new Map<number, number>();
const nyHourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });

/** Minutes after New York midnight. New York offsets are whole hours, so the minute of the hour is the UTC one. */
export function nyMinutes(at: number): number {
  const hour = Math.floor(at / HOUR_MS);
  let nyHour = nyHourByHour.get(hour);
  if (nyHour == null) {
    nyHour = Number(nyHourFormatter.format(new Date(hour * HOUR_MS))) % 24;
    if (nyHourByHour.size > 50_000) nyHourByHour.clear();
    nyHourByHour.set(hour, nyHour);
  }
  return nyHour * 60 + Math.floor((at % HOUR_MS) / 60_000);
}

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;

/**
 * Session VWAP from closed bars, the same rule as levels.ts: regular-session bars when there are any,
 * otherwise pre-market. Volume-weighted typical price. Null without volume.
 */
export function sessionVwap(bars: readonly CandleBar[]): number | null {
  const regular: CandleBar[] = [];
  const premarket: CandleBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const minutes = nyMinutes(bars[i].t);
    if (minutes < RTH_OPEN) premarket.push(bars[i]);
    else if (minutes < RTH_CLOSE) regular.push(bars[i]);
  }
  const source = regular.length > 0 ? regular : premarket;
  let weighted = 0;
  let volume = 0;
  for (let i = 0; i < source.length; i++) {
    const bar = source[i];
    const v = bar.v ?? 0;
    if (!(v > 0)) continue;
    weighted += ((bar.h + bar.l + bar.c) / 3) * v;
    volume += v;
  }
  return volume > 0 ? weighted / volume : null;
}

interface PreparedHistory {
  byDay: Map<string, CandleBar[]>;
  daily: PriceCandle[];
}

const prepared = new WeakMap<UnderlyingHistory, PreparedHistory>();

/** Group intraday bars by New York day and convert daily bars once per history object. */
export function prepareHistory(history: UnderlyingHistory, now: Date): PreparedHistory {
  const cached = prepared.get(history);
  if (cached) return cached;
  const byDay = new Map<string, CandleBar[]>();
  for (let i = 0; i < history.intraday.length; i++) {
    const bar = history.intraday[i];
    const day = nyDay(bar.t);
    let list = byDay.get(day);
    if (!list) {
      list = [];
      byDay.set(day, list);
    }
    list.push(bar);
  }
  byDay.forEach((list) => list.sort((a, b) => a.t - b.t));
  const next = { byDay, daily: dailyToPriceCandles(history.daily, now) };
  prepared.set(history, next);
  return next;
}

/** Intraday bars of the alert's New York session that had closed by the send time. */
export function barsBefore(bars: readonly CandleBar[], sentAt: number): CandleBar[] {
  const day = nyDay(sentAt);
  return bars.filter((bar) => bar.t + INTRADAY_MS <= sentAt && nyDay(bar.t) === day);
}

function preparedBarsBefore(history: PreparedHistory, sentAt: number): CandleBar[] {
  const list = history.byDay.get(nyDay(sentAt));
  if (!list) return [];
  const out: CandleBar[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].t + INTRADAY_MS <= sentAt) out.push(list[i]);
    else break;
  }
  return out;
}

/**
 * DXLink stamps a daily bar at midnight of its date. Rewritten to midday UTC of that date,
 * so newYorkDate reads the right session in the level math.
 */
export function dailyToPriceCandles(daily: readonly CandleBar[], now: Date): PriceCandle[] {
  const out: PriceCandle[] = [];
  for (let i = 0; i < daily.length; i++) {
    const bar = daily[i];
    if (!(bar.t > 0) || bar.t > now.getTime()) continue;
    const date = new Date(bar.t);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const noon = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 16, 0, 0);
    out.push({ open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v ?? 0, datetime: noon });
  }
  out.sort((a, b) => a.datetime - b.datetime);
  return out;
}

function intradayToPriceCandles(bars: readonly CandleBar[]): PriceCandle[] {
  return bars.map((bar) => ({ open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v ?? 0, datetime: bar.t }));
}

/** Price, VWAP, 20-day average, and levels as of the send time. Null when the session has no closed bar yet. */
export function levelsAt(history: UnderlyingHistory | undefined, sentAt: number, spot: number | null, now: Date): { price: number | null; levels: KeyLevels | null } {
  if (!history) return { price: null, levels: null };
  const ready = prepareHistory(history, now);
  const intraday = preparedBarsBefore(ready, sentAt);
  const last = intraday.length > 0 ? intraday[intraday.length - 1].c : null;
  const price = spot != null && spot > 0 ? spot : last;
  if (price == null) return { price: null, levels: null };
  const levels = computeKeyLevels({
    spot: price,
    daily: ready.daily,
    intraday: intradayToPriceCandles(intraday),
    now: new Date(sentAt),
  });
  return { price, levels };
}

/** SPY or QQQ above or below its own session VWAP at the send time. */
export function indexAt(history: UnderlyingHistory | undefined, sentAt: number, now: Date): IndexDirection {
  if (!history) return "unknown";
  const bars = preparedBarsBefore(prepareHistory(history, now), sentAt);
  if (bars.length === 0) return "unknown";
  const vwap = sessionVwap(bars);
  if (vwap == null) return "unknown";
  return indexDirection(bars[bars.length - 1].c, vwap);
}

/**
 * inside: a report date falls from the alert day through expiration.
 * after: the next report is after expiration.
 * none: Tastytrade lists no report history and no expected date, as with an ETF.
 * unknown: anything else.
 */
export function earningsAt(history: EarningsHistory | null | undefined, alertDay: string, expiration: string): EarningsProximity {
  if (!history) return "unknown";
  const dates = history.reported.slice();
  if (history.nextExpected) dates.push(history.nextExpected);
  if (dates.length === 0) return "none";
  let after = false;
  for (let i = 0; i < dates.length; i++) {
    const day = dates[i];
    if (day >= alertDay && day <= expiration) return "inside";
    if (day > expiration) after = true;
  }
  return after ? "after" : "unknown";
}

/** Same rule as trendFromPrices, on sides already decided. Unknown or flat on either side stays unknown. */
export function alignmentFromSides(putCall: "call" | "put", vwap: PriceSide | null, sma: PriceSide | null): TrendAlignment {
  const side = (value: PriceSide | null): "with" | "against" | null => {
    if (value !== "above" && value !== "below") return null;
    const bullish = value === "above";
    return (putCall === "call") === bullish ? "with" : "against";
  };
  const left = side(vwap);
  const right = side(sma);
  if (left == null || right == null) return "unknown";
  return left === right ? left : "mixed";
}

function isMissing(value: unknown): boolean {
  return value == null || value === "unknown";
}

function fractionOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 5) return null;
  return value;
}

/** Fill one alert. Returns the features unchanged and an empty list when there is nothing to fill. */
export function backfillAlert(alert: StoredAlert, inputs: BackfillInputs): AlertBackfill {
  const base: AlertFeatureSnapshot = alert.features ?? backfillFeatures(alert);
  const next: AlertFeatureSnapshot = { ...base };
  const filled: BackfillField[] = [];
  const set = <K extends BackfillField>(key: K, value: AlertFeatureSnapshot[K]) => {
    if (!isMissing(next[key]) || isMissing(value)) return;
    next[key] = value;
    filled.push(key);
  };
  const sentAt = alert.sentAt;

  set("minutesSinceOpen", minutesSinceOpen(new Date(sentAt)));

  const read = levelsAt(inputs.history.get(alert.ticker), sentAt, alert.underlyingPrice, inputs.now);
  if (read.levels) {
    const trend = trendFromPrices(alert.putCall, read.price, read.levels.vwap, read.levels.sma20);
    set("priceVsVwap", trend.priceVsVwap);
    set("priceVsSma20", trend.priceVsSma20);
    // Alignment from the final pair, so a captured side and a filled side agree.
    if (isMissing(next.trendAlignment)) {
      set("trendAlignment", alignmentFromSides(alert.putCall, next.priceVsVwap, next.priceVsSma20));
    }
    if (read.levels.checked && read.levels.support && read.levels.resistance) {
      const reward = alert.putCall === "call" ? read.levels.resistance.distance : read.levels.support.distance;
      const risk = alert.putCall === "call" ? read.levels.support.distance : read.levels.resistance.distance;
      if (next.rewardDistance == null && next.riskDistance == null) {
        set("rewardDistance", fractionOrNull(reward));
        set("riskDistance", fractionOrNull(risk));
      }
    }
  }

  const spy = indexAt(inputs.history.get("SPY"), sentAt, inputs.now);
  const qqq = indexAt(inputs.history.get("QQQ"), sentAt, inputs.now);
  set("spyDirection", spy);
  set("qqqDirection", qqq);
  if (isMissing(next.marketAlignment) && next.spyDirection && next.qqqDirection) {
    set("marketAlignment", marketAlignment(alert.putCall, next.spyDirection, next.qqqDirection));
  }

  if (next.earnings === "unknown" && earningsFromLine(alert.eventLine) === "unknown") {
    const alertDay = newYorkDate(new Date(sentAt));
    if (calendarDaysBetween(alertDay, alert.expiration) != null) {
      set("earnings", earningsAt(inputs.earnings.get(alert.ticker), alertDay, alert.expiration));
    }
  }

  if (filled.length === 0) return { features: base, filled };
  const prior = base.backfilled?.fields ?? [];
  const fields = prior.concat(filled.filter((field) => prior.indexOf(field) === -1));
  next.backfilled = { source: BACKFILL_SOURCE, at: inputs.now.getTime(), fields };
  return { features: next, filled };
}

export interface BackfillCounts {
  alerts: number;
  alertsChanged: number;
  /** Alerts that still had the field missing before the run. */
  missingBefore: Record<BackfillField, number>;
  filled: Record<BackfillField, number>;
  /** Missing on every alert and never filled. */
  notRecoverable: Record<string, number>;
}

export function emptyFieldCounts(): Record<BackfillField, number> {
  const out = {} as Record<BackfillField, number>;
  for (let i = 0; i < BACKFILL_FIELDS.length; i++) out[BACKFILL_FIELDS[i]] = 0;
  return out;
}

/** Fill every alert. Pure: the caller decides whether to save. */
export function backfillAlerts(alerts: readonly StoredAlert[], inputs: BackfillInputs): { alerts: StoredAlert[]; counts: BackfillCounts } {
  const counts: BackfillCounts = {
    alerts: alerts.length,
    alertsChanged: 0,
    missingBefore: emptyFieldCounts(),
    filled: emptyFieldCounts(),
    notRecoverable: {},
  };
  const keys = Object.keys(NOT_RECOVERABLE);
  for (let i = 0; i < keys.length; i++) counts.notRecoverable[keys[i]] = 0;
  const out = alerts.map((alert) => {
    const before = alert.features ?? backfillFeatures(alert);
    for (let i = 0; i < BACKFILL_FIELDS.length; i++) {
      if (isMissing(before[BACKFILL_FIELDS[i]])) counts.missingBefore[BACKFILL_FIELDS[i]] += 1;
    }
    for (let i = 0; i < keys.length; i++) {
      if (isMissing((before as unknown as Record<string, unknown>)[keys[i]])) counts.notRecoverable[keys[i]] += 1;
    }
    const result = backfillAlert(alert, inputs);
    if (result.filled.length === 0) return alert;
    counts.alertsChanged += 1;
    for (let i = 0; i < result.filled.length; i++) counts.filled[result.filled[i]] += 1;
    return { ...alert, features: result.features };
  });
  return { alerts: out, counts };
}

/** Same as backfillAlerts, with a pause every few alerts so timers and the runtime get a turn. */
export async function backfillAlertsPaced(
  alerts: readonly StoredAlert[],
  inputs: BackfillInputs,
  every = 25,
): Promise<{ alerts: StoredAlert[]; counts: BackfillCounts }> {
  const outAlerts: StoredAlert[] = [];
  let counts: BackfillCounts | null = null;
  for (let i = 0; i < alerts.length; i += every) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const part = backfillAlerts(alerts.slice(i, i + every), inputs);
    outAlerts.push(...part.alerts);
    if (!counts) counts = part.counts;
    else {
      counts.alerts += part.counts.alerts;
      counts.alertsChanged += part.counts.alertsChanged;
      for (const key of BACKFILL_FIELDS) {
        counts.missingBefore[key] += part.counts.missingBefore[key];
        counts.filled[key] += part.counts.filled[key];
      }
      for (const key of Object.keys(part.counts.notRecoverable)) {
        counts.notRecoverable[key] = (counts.notRecoverable[key] ?? 0) + part.counts.notRecoverable[key];
      }
    }
  }
  return { alerts: outAlerts, counts: counts ?? backfillAlerts([], inputs).counts };
}

/** SPY trend at entry for a shadow or research path, when it was saved as unknown. */
export function spyTrendAt(spy: UnderlyingHistory | undefined, openedAt: number, now: Date): IndexDirection {
  return indexAt(spy, openedAt, now);
}

/** Tastytrade earnings history payload to YYYY-MM-DD dates. */
export function parseEarningsReports(payload: unknown): string[] {
  const items = (payload as { data?: { items?: unknown } } | null)?.data?.items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const day = (items[i] as { "occurred-date"?: unknown })?.["occurred-date"];
    if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) out.push(day);
  }
  return out;
}

/** Tastytrade market-metrics payload to the next expected report date per symbol. */
export function parseExpectedEarnings(payload: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const items = (payload as { data?: { items?: unknown } } | null)?.data?.items;
  if (!Array.isArray(items)) return out;
  for (let i = 0; i < items.length; i++) {
    const row = items[i] as { symbol?: unknown; earnings?: { "expected-report-date"?: unknown } };
    if (typeof row?.symbol !== "string") continue;
    const day = row.earnings?.["expected-report-date"];
    out.set(row.symbol, typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null);
  }
  return out;
}
