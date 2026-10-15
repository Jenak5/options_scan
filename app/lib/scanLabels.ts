import { chicagoClock } from "@/app/lib/marketHours";

/**
 * Display labels for flow rows and sent alerts. Labels only.
 * Nothing here changes a grade, an exit, which alerts are sent, the 5-a-day
 * selection, the Scorecard, or the daily stop.
 */

export const BIG_FLOW_3M = 3_000_000;
/** 11:00–11:59 AM Chicago. */
export const WEAK_WINDOW_START_MIN = 11 * 60;
export const WEAK_WINDOW_END_MIN = 12 * 60;
/** Stock move against the trade at about +60 minutes that earns a "cut" flag. */
export const CUT_AGAINST_FRACTION = 0.003;
/** The 60-minute read must land within this window after entry to count. */
export const CHECK60_MIN_MS = 55 * 60_000;
export const CHECK60_MAX_MS = 90 * 60_000;

export const SUGGESTED_EXIT = { stopFraction: -0.30, trailArm: 0.20, trailGiveback: 0.15 } as const;

export type ScanLabel = "$3M+ flow" | "repeat" | "weak window" | "with ticker trend" | "cut";

export function isBig3m(premium: number | null | undefined): boolean {
  return premium != null && Number.isFinite(premium) && premium >= BIG_FLOW_3M;
}

export function inWeakWindow(atMs: number): boolean {
  const clock = chicagoClock(new Date(atMs));
  if (!clock) return false;
  return clock.minutes >= WEAK_WINDOW_START_MIN && clock.minutes < WEAK_WINDOW_END_MIN;
}

export function withTickerTrend(trend: string | null | undefined): boolean {
  return trend === "with";
}

/** Labels for a live Flow row at scan time. */
export function flowRowLabels(
  row: { notionalPremium: number | null; context?: { trendAlignment?: string | null } | null },
  nowMs: number,
): ScanLabel[] {
  const out: ScanLabel[] = [];
  if (isBig3m(row.notionalPremium)) out.push("$3M+ flow");
  if (inWeakWindow(nowMs)) out.push("weak window");
  if (withTickerTrend(row.context?.trendAlignment)) out.push("with ticker trend");
  return out;
}

/** Display order only: $3M+ rows first, everything else keeps its order. */
export function big3mFirst<T extends { notionalPremium: number | null }>(rows: readonly T[]): T[] {
  const big: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (isBig3m(row.notionalPremium) ? big : rest).push(row);
  return big.concat(rest);
}

interface AlertLike {
  id: string;
  ticker: string;
  tradingDay: string;
  sentAt: number;
}

/** True when an earlier alert on the same ticker was sent the same trading day. */
export function isRepeatAlert(alert: AlertLike, all: readonly AlertLike[]): boolean {
  for (const other of all) {
    if (other.id === alert.id || other.ticker !== alert.ticker || other.tradingDay !== alert.tradingDay) continue;
    if (other.sentAt < alert.sentAt || (other.sentAt === alert.sentAt && other.id < alert.id)) return true;
  }
  return false;
}

/** True when the book already has an alert on this ticker for this trading day. */
export function tickerSentToday(records: readonly { ticker: string; tradingDay: string }[], ticker: string, tradingDay: string): boolean {
  for (const record of records) if (record.ticker === ticker && record.tradingDay === tradingDay) return true;
  return false;
}

export interface Check60 {
  status: "cut" | "ok" | "pending" | "unknown";
  entry: number | null;
  at60: number | null;
  /** Positive is against the trade, as a fraction of the stock price. */
  againstFraction: number | null;
  minutes: number | null;
}

/**
 * Stock move against the trade about 60 minutes after the alert.
 * Uses the stock price saved with the alert and the one saved with the
 * 1-hour checkpoint. Nothing is guessed when either is missing.
 */
export function check60(alert: {
  putCall: "call" | "put";
  sentAt: number;
  underlyingPrice: number | null;
  checkpoints: { h1: { at: number | null; underlying: number | null; status: string } };
}): Check60 {
  const entry = alert.underlyingPrice != null && alert.underlyingPrice > 0 ? alert.underlyingPrice : null;
  const h1 = alert.checkpoints.h1;
  if (h1.status === "pending") return { status: entry == null ? "unknown" : "pending", entry, at60: null, againstFraction: null, minutes: null };
  const at60 = h1.underlying != null && h1.underlying > 0 ? h1.underlying : null;
  const elapsed = h1.at == null ? null : h1.at - alert.sentAt;
  if (entry == null || at60 == null || elapsed == null || elapsed < CHECK60_MIN_MS || elapsed > CHECK60_MAX_MS) {
    return { status: "unknown", entry, at60, againstFraction: null, minutes: elapsed == null ? null : Math.round(elapsed / 60_000) };
  }
  const move = (at60 - entry) / entry;
  const against = alert.putCall === "call" ? -move : move;
  return {
    status: against + 1e-9 >= CUT_AGAINST_FRACTION ? "cut" : "ok",
    entry,
    at60,
    againstFraction: against,
    minutes: Math.round(elapsed / 60_000),
  };
}

/** Labels for a saved alert. */
export function alertLabels(
  alert: AlertLike & {
    putCall: "call" | "put";
    underlyingPrice: number | null;
    volume: number;
    mid: number | null;
    features?: { flowPremium?: number | null; trendAlignment?: string | null } | null;
    checkpoints: { h1: { at: number | null; underlying: number | null; status: string } };
  },
  all: readonly AlertLike[],
): ScanLabel[] {
  const premium = alert.features?.flowPremium ?? (alert.mid != null ? alert.volume * alert.mid * 100 : null);
  const out: ScanLabel[] = [];
  if (isBig3m(premium)) out.push("$3M+ flow");
  if (isRepeatAlert(alert, all)) out.push("repeat");
  if (inWeakWindow(alert.sentAt)) out.push("weak window");
  if (withTickerTrend(alert.features?.trendAlignment)) out.push("with ticker trend");
  if (check60(alert).status === "cut") out.push("cut");
  return out;
}

/** Suggested exit, shown as a label. The live exits do not change. */
export function suggestedExitText(ask: number): string | null {
  if (!(ask > 0) || !Number.isFinite(ask)) return null;
  const stop = ask * (1 + SUGGESTED_EXIT.stopFraction);
  const arm = ask * (1 + SUGGESTED_EXIT.trailArm);
  return `Suggested exit (label only, not the live exit): stop $${stop.toFixed(2)} (-30%), no fixed target; once it reaches $${arm.toFixed(2)} (+20%), sell if it falls 15% below its best price.`;
}

export function labelsLine(labels: readonly string[]): string {
  return labels.join(" · ");
}
