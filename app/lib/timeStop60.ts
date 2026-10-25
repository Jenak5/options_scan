import { TIME_STOP_60, TRADE_RULES } from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import type { ShadowMark } from "@/app/lib/exitWhatIf";
import { chicagoTradingDaysElapsed } from "@/app/lib/marketHours";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import type { ShadowQuoteSource, ShadowTrade } from "@/app/lib/shadow";

/** Same cap as SHADOW_MARK_CAP. Kept here so this file does not load the shadow book. */
const MARK_CAP = 680;

/**
 * A paper result beside each saved A or B.
 * Exit at +40%, -25%, or 60 minutes after entry, whichever comes first.
 * Prices come from the live quote path and from stored 1-minute option candles.
 * The A or B row is not modified. Nothing here sends an alert or places an order.
 */

export const TIME_STOP_MS = TIME_STOP_60.minutes * 60_000;
const MINUTE_MS = 60_000;
const PRICE_EPS = 1e-6;
const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;

export const TIME_STOP_SECTION_NOTE =
  `${TIME_STOP_60.label}. These are not A or B grades, they are not sent, and they are left out of the totals above. Every saved A or B keeps the scorecard result from the live exits. This row uses that same entry and exits at plus 40%, minus 25%, or 60 minutes after entry, whichever comes first. The price comes from the live quote and, when a 1-minute option series is stored, from those candles. A minute that trades through both the stop and the target is a stop. No order is placed. The live alert rules are unchanged. Estimates from quotes, not fills.`;

export function timeStopTrustNote(resolved: number): string {
  if (resolved < TIME_STOP_60.minTrust) {
    return `${resolved} resolved 60-minute results. Fewer than ${TIME_STOP_60.minTrust} is too few to read as a result.`;
  }
  return `${resolved} resolved 60-minute results. That is enough to describe. It does not change a live alert or an exit.`;
}

export interface TimeStopExit {
  reason: "profit" | "stop" | "flat";
  price: number;
  at: number;
  quote: ShadowQuoteSource | null;
  stale: boolean;
  studySource: "live" | "1m";
}

export function timeStopId(alertId: string): string | null {
  const id = `t60-${alertId}`.slice(0, 180);
  return ID_PATTERN.test(id) ? id : null;
}

export function timeStopSourceId(id: string): string | null {
  if (!id.startsWith("t60-")) return null;
  const source = id.slice(4);
  return ID_PATTERN.test(source) ? source : null;
}

/** Turn a just-opened A or B shadow into its 60-minute paper row. */
export function timeStopFromShadow(base: ShadowTrade): ShadowTrade | null {
  if (base.grade !== "A" && base.grade !== "B") return null;
  if (base.cohort !== "ab") return null;
  const id = timeStopId(base.alertId);
  if (!id) return null;
  return {
    ...base,
    id,
    alertId: id,
    grade: "test",
    cohort: "time-60",
    experimentLabel: TIME_STOP_60.label,
    probeGrade: null,
    quoteTrack: undefined,
    entryUnderlying: undefined,
    spyTrend: undefined,
    spyTrendSource: undefined,
    studySource: undefined,
  };
}

/**
 * One 60-minute row for each A or B shadow opened in this same pass.
 * Older alerts are left as they are, so a deploy does not rewrite the book.
 */
export function addTimeStopShadows(
  records: readonly ShadowTrade[],
  opened: readonly ShadowTrade[],
): { records: ShadowTrade[]; opened: number } {
  if (opened.length === 0) return { records: records.slice(), opened: 0 };
  const ids = new Set<string>();
  for (let i = 0; i < records.length; i++) ids.add(records[i].id);
  const added: ShadowTrade[] = [];
  for (let i = 0; i < opened.length; i++) {
    const row = timeStopFromShadow(opened[i]);
    if (!row || ids.has(row.id)) continue;
    ids.add(row.id);
    added.push(row);
  }
  if (added.length === 0) return { records: records.slice(), opened: 0 };
  return { records: records.concat(added), opened: added.length };
}

/**
 * Copy the A or B quote path onto the open 60-minute row and apply the clock.
 * A row already priced from 1-minute candles is left as stored.
 */
export function syncTimeStops(records: readonly ShadowTrade[], now: Date): ShadowTrade[] {
  const byId = new Map<string, ShadowTrade>();
  for (let i = 0; i < records.length; i++) byId.set(records[i].id, records[i]);
  let changed = false;
  const next = records.map((row) => {
    if (row.cohort !== "time-60" || row.studySource === "1m" || row.status === "closed") return row;
    const sourceId = timeStopSourceId(row.id);
    const source = sourceId ? byId.get(sourceId) : undefined;
    const folded = source ? absorbMarks(row, source.marks ?? []) : row;
    const exit = walkTimeStop(folded, [], now.getTime(), false);
    if (!exit) {
      if (folded !== row) changed = true;
      return folded;
    }
    changed = true;
    return closeTimeStop(folded, exit);
  });
  return changed ? next : records.slice();
}

/**
 * Reprice from 1-minute candles when they cover the window.
 * `final` means this series is the stored day, so a time exit can lock.
 * The A or B row is never passed in here.
 */
export function refineTimeStop(
  row: ShadowTrade,
  candles: readonly CandleBar[],
  now: Date,
  final: boolean,
): ShadowTrade {
  if (row.cohort !== "time-60" || row.studySource === "1m") return row;
  const exit = walkTimeStop(row, candles, now.getTime(), final);
  if (!exit || exit.studySource !== "1m") return row;
  return closeTimeStop(row, exit);
}

export function timeStopsNeedingCandles(records: readonly ShadowTrade[], now: Date): ShadowTrade[] {
  const due: ShadowTrade[] = [];
  const nowMs = now.getTime();
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.cohort !== "time-60" || row.studySource === "1m") continue;
    if (row.status === "open" && nowMs < row.openedAt + TIME_STOP_MS) continue;
    due.push(row);
  }
  due.sort((a, b) => a.openedAt - b.openedAt);
  return due;
}

/** Live marks only. Used when a fresh quote is applied to the 60-minute row itself. */
export function liveTimeStopExit(row: ShadowTrade, nowMs: number): TimeStopExit | null {
  return walkTimeStop(row, [], nowMs, false);
}

function closeTimeStop(row: ShadowTrade, exit: TimeStopExit): ShadowTrade {
  const price = exit.price;
  const pnlDollars = (price - row.entryPrice) * row.contracts * 100;
  const pnlFraction = row.entryPrice > 0 ? (price - row.entryPrice) / row.entryPrice : null;
  return {
    ...row,
    status: "closed",
    closedAt: exit.at,
    exitPrice: price,
    exitReason: exit.reason,
    exitQuote: exit.quote,
    exitStale: exit.stale,
    pnlDollars,
    pnlFraction,
    tradingDaysHeld: chicagoTradingDaysElapsed(new Date(row.openedAt), new Date(exit.at)),
    studySource: exit.studySource,
    lastMark: price,
    lastMarkSource: exit.quote ?? row.lastMarkSource,
    lastMarkedAt: exit.at,
  };
}

interface Level {
  stop: number;
  target: number;
}

function levels(entry: number): Level | null {
  if (!(entry > 0) || !Number.isFinite(entry)) return null;
  const percentStop = entry * (1 - TRADE_RULES.stopLossFraction);
  const dollarStop = entry - MAX_LOSS_DOLLARS / 100;
  return {
    stop: Math.max(percentStop, dollarStop),
    target: entry * (1 + TRADE_RULES.profitTargetFraction),
  };
}

/**
 * Walk candles and live marks from entry through entry + 60 minutes.
 * A candle is used instead of a live mark in the same minute.
 * Stop wins when one candle trades through both prices.
 * Without candles, only live marks at or before the deadline can hit a level.
 * A quote after the deadline does not become a stop or a target.
 */
function walkTimeStop(
  row: ShadowTrade,
  candles: readonly CandleBar[],
  nowMs: number,
  final: boolean,
): TimeStopExit | null {
  const level = levels(row.entryPrice);
  if (!level) return null;
  const deadline = row.openedAt + TIME_STOP_MS;
  const bars = barsInWindow(candles, row.openedAt, deadline);
  const barMinutes = new Set<number>();
  for (let i = 0; i < bars.length; i++) barMinutes.add(Math.floor(bars[i].t / MINUTE_MS));
  const marks = marksInWindow(row.marks ?? [], row.openedAt, deadline, barMinutes);

  type Step =
    | { at: number; kind: "bar"; bar: CandleBar }
    | { at: number; kind: "mark"; price: number };
  const steps: Step[] = [];
  for (let i = 0; i < bars.length; i++) steps.push({ at: bars[i].t, kind: "bar", bar: bars[i] });
  for (let i = 0; i < marks.length; i++) steps.push({ at: marks[i].at, kind: "mark", price: marks[i].price });
  steps.sort((a, b) => a.at - b.at || (a.kind === "bar" ? -1 : 1));

  let lastPrice: number | null = null;
  let lastAt = row.openedAt;
  let sawCandle = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === "bar") {
      sawCandle = true;
      const bar = step.bar;
      const stopHit = bar.l <= level.stop + PRICE_EPS;
      const targetHit = bar.h + PRICE_EPS >= level.target;
      if (stopHit) {
        const price = bar.o <= level.stop + PRICE_EPS ? bar.o : level.stop;
        return exitAt("stop", price, bar.t, null, false, "1m");
      }
      if (targetHit) {
        const price = bar.o + PRICE_EPS >= level.target ? bar.o : level.target;
        return exitAt("profit", price, bar.t, null, false, "1m");
      }
      lastPrice = bar.c;
      lastAt = bar.t;
      continue;
    }
    if (step.price <= level.stop + PRICE_EPS) {
      return exitAt("stop", step.price, step.at, null, false, sawCandle ? "1m" : "live");
    }
    if (step.price + PRICE_EPS >= level.target) {
      return exitAt("profit", step.price, step.at, null, false, sawCandle ? "1m" : "live");
    }
    lastPrice = step.price;
    lastAt = step.at;
  }

  if (nowMs < deadline) return null;
  if (lastPrice == null) {
    const late = firstMarkAfter(row.marks ?? [], deadline);
    if (!late) return null;
    if (sawCandle && !final) return null;
    return exitAt("flat", late.price, deadline, null, true, sawCandle && final ? "1m" : "live");
  }
  if (sawCandle && (final || lastAt + MINUTE_MS >= deadline)) {
    return exitAt("flat", lastPrice, deadline, null, false, "1m");
  }
  if (!sawCandle) return exitAt("flat", lastPrice, deadline, null, lastAt < deadline, "live");
  return null;
}

function exitAt(
  reason: TimeStopExit["reason"],
  price: number,
  at: number,
  quote: ShadowQuoteSource | null,
  stale: boolean,
  studySource: TimeStopExit["studySource"],
): TimeStopExit {
  return { reason, price, at, quote, stale, studySource };
}

function barsInWindow(bars: readonly CandleBar[], openedAt: number, deadline: number): CandleBar[] {
  const out: CandleBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!(bar.t >= openedAt) || bar.t > deadline) continue;
    if (!(bar.o > 0) || !(bar.h > 0) || !(bar.l > 0) || !(bar.c > 0)) continue;
    if (bar.h + PRICE_EPS < bar.l) continue;
    const prev = out[out.length - 1];
    if (prev && prev.t === bar.t) out[out.length - 1] = bar;
    else out.push(bar);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function marksInWindow(
  marks: readonly ShadowMark[],
  openedAt: number,
  deadline: number,
  skipMinutes: ReadonlySet<number>,
): ShadowMark[] {
  const out: ShadowMark[] = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark.at < openedAt || mark.at > deadline || !(mark.price > 0)) continue;
    if (skipMinutes.has(Math.floor(mark.at / MINUTE_MS))) continue;
    out.push(mark);
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

function firstMarkAfter(marks: readonly ShadowMark[], deadline: number): ShadowMark | null {
  let best: ShadowMark | null = null;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark.at <= deadline || !(mark.price > 0)) continue;
    if (!best || mark.at < best.at) best = mark;
  }
  return best;
}

function absorbMarks(row: ShadowTrade, extra: readonly ShadowMark[]): ShadowTrade {
  const marks = (row.marks ?? []).slice();
  const seen = new Set<string>();
  for (let i = 0; i < marks.length; i++) seen.add(`${marks[i].at}|${marks[i].price}`);
  let changed = false;
  for (let i = 0; i < extra.length; i++) {
    const mark = extra[i];
    if (mark.at < row.openedAt || !(mark.price > 0)) continue;
    const key = `${mark.at}|${mark.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    marks.push(mark);
    changed = true;
  }
  if (!changed) return row;
  marks.sort((a, b) => a.at - b.at);
  const capped = marks.slice(-MARK_CAP);
  const latest = capped[capped.length - 1];
  return {
    ...row,
    marks: capped,
    lastMark: latest ? latest.price : row.lastMark,
    lastMarkedAt: latest ? latest.at : row.lastMarkedAt,
  };
}

export function sameTimeStopExit(left: ShadowTrade, right: ShadowTrade): boolean {
  return left.status === right.status
    && left.exitReason === right.exitReason
    && left.exitPrice === right.exitPrice
    && left.studySource === right.studySource
    && left.closedAt === right.closedAt;
}
