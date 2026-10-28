import type { CandleBar } from "@/app/lib/candleTypes";
import type { PutCall } from "@/app/lib/contract";
import { nyMinutes } from "@/app/lib/featureBackfill";
import { newYorkDate } from "@/app/lib/flow";

/**
 * J.G. Banks entry from the verified port of the backtest (port.py / sig.py).
 * Trend is prior-day and last-completed-week EMA8/EMA21.
 * Levels are 5-bar pivots on 60-minute bars anchored at 9:30 ET.
 * A 5-minute retest after an hourly break is the signal. First one per day.
 * VWAP is cumulative close×volume / volume from 9:30 ET.
 * Implied move is prior close × vol index / 100 / sqrt(252).
 * Missing history or a missing vol index is no trade. Nothing here is invented.
 */

const FIVE_MS = 5 * 60_000;
const SESSION_OPEN = 9 * 60 + 30;
const SESSION_CLOSE = 16 * 60;
const SIGNAL_START = 9 * 60 + 45;
const SIGNAL_END = 14 * 60 + 30;
const VWAP_MIN = -0.10;
const BACKTEST_SEED = "2018-05-01";
const YEAR_DAYS = 252;

export interface JgDailyBar {
  date: string;
  high: number;
  low: number;
  close: number;
}

export interface JgSignal {
  direction: PutCall;
  /** One minute after the 5-minute bar ends. That is the backtest entry stamp. */
  signalAt: number;
  /** 5-minute bar close. The underlying entry. */
  entry: number;
  level: number;
  vwap: number;
  /** direction × (price/VWAP − 1) × 100, rounded to 3 decimals. */
  vwapDist: number;
  vwapOk: boolean;
  impliedMove: number;
  stop: number;
  atrUsed: number | null;
  priorClose: number;
  volIndex: number;
  volSymbol: "VXN" | "VIX";
}

export type JgSignalResult =
  | { status: "signal"; signal: JgSignal }
  | { status: "vwap-reject"; signal: JgSignal }
  | { status: "none"; reason: string };

export interface JgSignalInput {
  /** Regular-hours bars. Each bar is 5 minutes, timestamped at its start. */
  bars: readonly CandleBar[];
  daily: readonly JgDailyBar[];
  /** Prior close of VXN (QQQ) or VIX (SPX). Null when the feed did not return one. */
  volIndex: number | null;
  volSymbol: "VXN" | "VIX";
  day: string;
  nowMs: number;
  /** Today's range / ATR14. Null when either piece is missing. The caller computes it. */
  atrUsed: number | null;
  /**
   * Live scans require the daily series to reach the backtest seed.
   * A shorter series is a different EMA. Tests of the arithmetic may turn this off.
   */
  enforceSeed?: boolean;
}

export function jgImpliedMoveFromVol(priorClose: number, volIndex: number): number | null {
  if (!(priorClose > 0) || !(volIndex > 0) || !Number.isFinite(priorClose) || !Number.isFinite(volIndex)) return null;
  const move = priorClose * (volIndex / 100) / Math.sqrt(YEAR_DAYS);
  return move > 0 && Number.isFinite(move) ? move : null;
}

export function jgFindSignal(input: JgSignalInput): JgSignalResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || !Number.isFinite(input.nowMs)) {
    return { status: "none", reason: "session clock is missing" };
  }
  const daily = normalizeDaily(input.daily);
  if (input.enforceSeed && (daily.length === 0 || daily[0].date > BACKTEST_SEED)) {
    const start = daily.length === 0 ? "none" : daily[0].date;
    return { status: "none", reason: `daily closes start ${start}; backtest EMA seed is ${BACKTEST_SEED}` };
  }
  if (input.enforceSeed) {
    const seen = new Set<string>();
    for (let i = 0; i < input.bars.length; i++) seen.add(newYorkDate(new Date(input.bars[i].t)));
    if (seen.size < 10) {
      return { status: "none", reason: `5-minute history covers ${seen.size} days; levels need 10 trading days` };
    }
  }
  const prior = lastBefore(daily, input.day);
  if (!prior) return { status: "none", reason: "no prior daily close" };
  if (input.volIndex == null || !(input.volIndex > 0) || !Number.isFinite(input.volIndex)) {
    return { status: "none", reason: `${input.volSymbol} prior close is missing` };
  }
  const trend = trendDirection(daily, prior.date, input.day);
  if (trend == null) return { status: "none", reason: "daily and weekly EMA8/EMA21 disagree, or a week is missing" };
  const implied = jgImpliedMoveFromVol(prior.close, input.volIndex);
  if (implied == null) return { status: "none", reason: "implied move is missing" };

  const found = scanBars(input.bars, input.day, input.nowMs, trend);
  if (!found) return { status: "none", reason: "no break-and-retest in the 9:45–14:30 ET window" };
  const atr = input.atrUsed != null && Number.isFinite(input.atrUsed) && input.atrUsed >= 0 ? input.atrUsed : null;
  const stopRaw = found.entry - trend * 0.75 * implied;
  const signal: JgSignal = {
    direction: trend > 0 ? "call" : "put",
    signalAt: found.barEnd + 60_000,
    entry: found.entry,
    level: roundTo(found.level, 4),
    vwap: found.vwap,
    vwapDist: roundTo(found.vwapDist, 3),
    vwapOk: found.vwapDist >= VWAP_MIN - 1e-9,
    impliedMove: implied,
    stop: roundTo(stopRaw, 3),
    atrUsed: atr,
    priorClose: prior.close,
    volIndex: input.volIndex,
    volSymbol: input.volSymbol,
  };
  if (!signal.vwapOk) return { status: "vwap-reject", signal };
  return { status: "signal", signal };
}

/** What a historical replay still needs. Live scans use the same list. */
export function jgReplayMissing(): string[] {
  return [
    "QQQ 5-minute regular-hours bars from 12 trading days before each replay date through that date",
    "QQQ daily highs, lows, and closes from 2018-05-01 so EMA8/EMA21 match the backtest seed",
    "CBOE VXN daily closes, using the prior session's close",
    "SPX needs the same bars plus a prior VIX close; without VIX that name is no trade",
  ];
}

interface FoundBar {
  barEnd: number;
  entry: number;
  level: number;
  vwap: number;
  vwapDist: number;
}

interface Pivot {
  level: number;
  confEnd: number;
  dayIndex: number;
  isHigh: boolean;
}

function scanBars(bars: readonly CandleBar[], day: string, nowMs: number, trend: 1 | -1): FoundBar | null {
  const ordered = bars.filter(usableFive).slice().sort((a, b) => a.t - b.t);
  let lastDay = "";
  let dayIndex = 0;
  let done = false;
  let cpv = 0;
  let cv = 0;
  let hi = 0;
  let lo = 0;
  const todayCloses: { t: number; c: number }[] = [];
  const hH: number[] = [];
  const hL: number[] = [];
  const hC: number[] = [];
  const hE: number[] = [];
  const hD: number[] = [];
  let pivots: Pivot[] = [];
  let acc: { high: number; low: number; close: number; end: number } | null = null;
  let found: FoundBar | null = null;

  for (let i = 0; i < ordered.length; i++) {
    const bar = ordered[i];
    const barDay = newYorkDate(new Date(bar.t));
    const barEnd = bar.t + FIVE_MS;
    if (barEnd > nowMs) break;
    const minutes = nyMinutes(bar.t);
    if (minutes < SESSION_OPEN || minutes >= SESSION_CLOSE) continue;
    if (barDay !== lastDay) {
      lastDay = barDay;
      dayIndex += 1;
      done = false;
      cpv = 0;
      cv = 0;
      hi = bar.h;
      lo = bar.l;
      todayCloses.length = 0;
      pivots = pivots.filter((pivot) => pivot.dayIndex >= dayIndex - 11);
    } else {
      if (bar.h > hi) hi = bar.h;
      if (bar.l < lo) lo = bar.l;
    }
    const volume = bar.v != null && Number.isFinite(bar.v) && bar.v > 0 ? bar.v : 0;
    cpv += bar.c * volume;
    cv += volume;
    const vwap = cv > 0 ? cpv / cv : null;
    const hourEnd = hourlyEndMs(bar.t);
    if (hourEnd == null) continue;
    if (!acc || acc.end !== hourEnd) acc = { high: bar.h, low: bar.l, close: bar.c, end: hourEnd };
    else acc = { high: Math.max(acc.high, bar.h), low: Math.min(acc.low, bar.l), close: bar.c, end: hourEnd };
    if (barEnd >= acc.end) {
      hH.push(acc.high);
      hL.push(acc.low);
      hC.push(acc.close);
      hE.push(acc.end);
      hD.push(dayIndex);
      acc = null;
      const n = hH.length;
      if (n >= 5) {
        const j = n - 3;
        const hiMax = Math.max(hH[j - 2], hH[j - 1], hH[j + 1], hH[j + 2]);
        const loMin = Math.min(hL[j - 2], hL[j - 1], hL[j + 1], hL[j + 2]);
        if (hH[j] > hiMax) pivots.push({ level: hH[j], confEnd: hE[n - 1], dayIndex: hD[j - 2], isHigh: true });
        if (hL[j] < loMin) pivots.push({ level: hL[j], confEnd: hE[n - 1], dayIndex: hD[j - 2], isHigh: false });
      }
    }
    const endMinute = nyMinutes(barEnd);
    if (
      found == null && barDay === day && !done && vwap != null && vwap > 0
      && endMinute >= SIGNAL_START && endMinute <= SIGNAL_END
    ) {
      const hit = matchRetest(hC, hE, pivots, todayCloses, bar, trend, dayIndex, vwap);
      if (hit) {
        done = true;
        found = hit;
      }
    }
    todayCloses.push({ t: bar.t, c: bar.c });
  }
  return found;
}

function matchRetest(
  hC: readonly number[],
  hE: readonly number[],
  pivots: readonly Pivot[],
  closes: readonly { t: number; c: number }[],
  bar: CandleBar,
  trend: 1 | -1,
  dayIndex: number,
  vwap: number,
): FoundBar | null {
  const n = hC.length;
  const start = Math.max(1, n - 7);
  for (let k = start; k < n; k++) {
    for (let p = 0; p < pivots.length; p++) {
      const pivot = pivots[p];
      if (pivot.isHigh !== (trend > 0)) continue;
      if (pivot.dayIndex < dayIndex - 10) continue;
      if (pivot.confEnd > hE[k - 1]) continue;
      const broke = trend > 0
        ? hC[k] > pivot.level && pivot.level >= hC[k - 1]
        : hC[k] < pivot.level && pivot.level <= hC[k - 1];
      if (!broke) continue;
      let violated = false;
      for (let c = 0; c < closes.length; c++) {
        if (closes[c].t < hE[k]) continue;
        if (trend > 0 && closes[c].c < pivot.level * 0.998) violated = true;
        if (trend < 0 && closes[c].c > pivot.level * 1.002) violated = true;
      }
      if (violated) continue;
      const retest = trend > 0
        ? bar.l <= pivot.level * 1.001 && bar.c > pivot.level
        : bar.h >= pivot.level * 0.999 && bar.c < pivot.level;
      if (!retest) continue;
      const dist = trend * (bar.c / vwap - 1) * 100;
      return { barEnd: bar.t + FIVE_MS, entry: bar.c, level: pivot.level, vwap, vwapDist: dist };
    }
  }
  return null;
}

function trendDirection(daily: readonly JgDailyBar[], priorDate: string, day: string): 1 | -1 | null {
  const closes = daily.map((bar) => bar.close);
  const dates = daily.map((bar) => bar.date);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const priorIndex = dates.indexOf(priorDate);
  if (priorIndex < 0) return null;
  const dailyUp = ema8[priorIndex] > ema21[priorIndex];
  const weeks = weeklyCloses(daily, day);
  if (weeks.length === 0) return null;
  const w8 = ema(weeks, 8);
  const w21 = ema(weeks, 21);
  const weeklyUp = w8[w8.length - 1] > w21[w21.length - 1];
  if (dailyUp !== weeklyUp) return null;
  return dailyUp ? 1 : -1;
}

function weeklyCloses(daily: readonly JgDailyBar[], day: string): number[] {
  const byFriday = new Map<string, number>();
  for (let i = 0; i < daily.length; i++) {
    if (daily[i].date >= day) continue;
    const friday = weekFriday(daily[i].date);
    if (friday >= day) continue;
    byFriday.set(friday, daily[i].close);
  }
  return Array.from(byFriday.keys()).sort().map((key) => byFriday.get(key) as number);
}

function weekFriday(ymd: string): string {
  const [year, month, day] = ymd.split("-").map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  const add = dow === 0 ? 5 : dow <= 5 ? 5 - dow : 6;
  utc.setUTCDate(utc.getUTCDate() + add);
  return utc.toISOString().slice(0, 10);
}

function ema(values: readonly number[], span: number): number[] {
  if (values.length === 0) return [];
  const alpha = 2 / (span + 1);
  const out = [values[0]];
  let prev = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = (1 - alpha) * prev + alpha * values[i];
    out.push(prev);
  }
  return out;
}

function hourlyEndMs(barStart: number): number | null {
  const minutes = nyMinutes(barStart);
  if (minutes < SESSION_OPEN || minutes >= SESSION_CLOSE) return null;
  const fromOpen = minutes - SESSION_OPEN;
  const bucket = Math.floor(fromOpen / 60);
  const endFromOpen = 60 * bucket + (bucket === 6 ? 30 : 60);
  const open = barStart - fromOpen * 60_000;
  return open + endFromOpen * 60_000;
}

function normalizeDaily(daily: readonly JgDailyBar[]): JgDailyBar[] {
  const byDate = new Map<string, JgDailyBar>();
  for (let i = 0; i < daily.length; i++) {
    const bar = daily[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) continue;
    if (!(bar.high > 0) || !(bar.low > 0) || !(bar.close > 0) || bar.high < bar.low) continue;
    byDate.set(bar.date, bar);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function lastBefore(daily: readonly JgDailyBar[], day: string): JgDailyBar | null {
  let prior: JgDailyBar | null = null;
  for (let i = 0; i < daily.length; i++) {
    if (daily[i].date < day) prior = daily[i];
  }
  return prior;
}

function usableFive(bar: CandleBar): boolean {
  return Number.isFinite(bar.t) && bar.h > 0 && bar.l > 0 && bar.c > 0 && bar.h >= bar.l;
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
