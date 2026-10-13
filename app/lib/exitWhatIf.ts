import { TRADE_RULES } from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import { calendarDaysBetween, newYorkDate, SHADOW_QUOTES_PER_RUN } from "@/app/lib/flow";
import { chicagoTradingDaysElapsed, PATH_MARK_TRADING_DAY_CAP } from "@/app/lib/marketHours";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { contractKey, isExperimentShadow, LAST_WEEK_CALENDAR_DAYS, SHADOW_MIN_TRUST, type ShadowTrade } from "@/app/lib/shadow";

/**
 * Replay stored shadow marks under other exit rules.
 * The live exits are not changed. A 15-minute snapshot can miss the touch,
 * so every result here is an estimate, not a fill.
 */

export const WHAT_IF_NOTE =
  "When stored 1-minute candles exist, the high and the low of each minute decide a stop or a target. A minute with no trade is a gap and is not filled in. Otherwise these are estimates from the stored 15-minute quote snapshots, not fills. A snapshot can miss the exact high or low between quotes. These rows are for comparison only. They do not change the live exits: take profit at +40%, stop at -25% with the loss capped at $875, out if it is still flat after 3 trading days, and out before the last week.";

export const WHAT_IF_PATH_NOTE =
  "Shadows that stored a quote path are included. A stored 1-minute candle series is included even when the 15-minute path is missing. Older shadows kept the best and worst price, not the path, so they are left out instead of guessed.";

export interface ShadowMark {
  at: number;
  price: number;
}

export interface WhatIfScenario {
  id: string;
  label: string;
  profitFraction: number | null;
  stopFraction: number;
  flatDays: number;
  trailArm: number | null;
  trailGiveback: number | null;
}

export type WhatIfSource = "1m" | "15m" | "mixed";

export interface WhatIfResult {
  id: string;
  label: string;
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  tooFew: boolean;
  /** 1m when every included path had candles. 15m when none did. Mixed when the row uses both. */
  source: WhatIfSource;
  /** Candles that traded through both the stop and the target. Counted as a stop. */
  ambiguous: number;
}

export interface WhatIfReport {
  note: string;
  pathNote: string;
  included: number;
  skipped: number;
  candlePaths: number;
  markPaths: number;
  coverageNote: string;
  scenarios: WhatIfResult[];
}

/** A research track, or any row that can be replayed. Grades filter which ones join. */
export interface WhatIfPath {
  grade: string;
  entryPrice: number;
  openedAt: number;
  expiration: string;
  marks: readonly ShadowMark[];
  contractKey?: string;
  candles?: readonly CandleBar[];
}

export interface CandleWalk {
  exit: ReplayExit | null;
  ambiguous: boolean;
  /** Timestamp of the candle that exited. Null when the path has not exited. */
  at: number | null;
  /** Candles actually read. Missing minutes are not added to this count. */
  barsUsed: number;
}

interface ReplayExit {
  pnlDollars: number;
  pnlFraction: number;
}

const PRICE_EPS = 1e-6;

export { PATH_MARK_TRADING_DAY_CAP } from "@/app/lib/marketHours";

/**
 * Resolved shadows quoted for a what-if path on one run, in the same batch as
 * open shadows. Open shadows keep their own cap. This does not add a second pass.
 */
export const PATH_MARK_QUOTES_PER_RUN = 4;

export const WHAT_IF_SCENARIOS: readonly WhatIfScenario[] = [
  scenario("tp25", "Take profit at +25%. Stop stays -25%. Time stop stays 3 trading days.", 0.25, -0.25, 3, null, null),
  scenario("tp40", "Take profit at +40%. Stop stays -25%. Time stop stays 3 trading days.", 0.40, -0.25, 3, null, null),
  scenario("tp60", "Take profit at +60%. Stop stays -25%. Time stop stays 3 trading days.", 0.60, -0.25, 3, null, null),
  scenario("stop20", "Stop at -20%. Take profit stays +40%. Time stop stays 3 trading days.", 0.40, -0.20, 3, null, null),
  scenario("stop25", "Stop at -25%. Take profit stays +40%. Time stop stays 3 trading days.", 0.40, -0.25, 3, null, null),
  scenario("stop35", "Stop at -35%. Take profit stays +40%. Time stop stays 3 trading days.", 0.40, -0.35, 3, null, null),
  scenario("tp45stop35", "Take profit at +45%. Stop at -35%. Time stop stays 3 trading days.", 0.45, -0.35, 3, null, null),
  scenario("tp50stop35", "Take profit at +50%. Stop at -35%. Time stop stays 3 trading days.", 0.50, -0.35, 3, null, null),
  scenario("tp60stop35", "Take profit at +60%. Stop at -35%. Time stop stays 3 trading days.", 0.60, -0.35, 3, null, null),
  scenario("time2", "Time stop after 2 trading days. Take profit stays +40%. Stop stays -25%.", 0.40, -0.25, 2, null, null),
  scenario("time3", "Time stop after 3 trading days. Take profit stays +40%. Stop stays -25%.", 0.40, -0.25, 3, null, null),
  scenario("time5", "Time stop after 5 trading days. Take profit stays +40%. Stop stays -25%.", 0.40, -0.25, 5, null, null),
  scenario(
    "trail25",
    "Trailing stop: after a snapshot is up 25%, exit if a later snapshot is 15% below the best snapshot. Hard stop stays -25%.",
    null,
    -0.25,
    3,
    0.25,
    0.15,
  ),
];

export function replayExit(
  input: {
    entryPrice: number;
    openedAt: number;
    expiration: string;
    marks: readonly ShadowMark[];
  },
  rule: WhatIfScenario,
): ReplayExit | null {
  if (!(input.entryPrice > 0) || !Number.isFinite(input.entryPrice)) return null;
  const marks = input.marks
    .filter((mark) => Number.isFinite(mark.at) && Number.isFinite(mark.price) && mark.price > 0 && mark.at >= input.openedAt)
    .slice()
    .sort((a, b) => a.at - b.at);
  if (marks.length === 0) return null;
  const stopPrice = cappedStop(input.entryPrice, rule.stopFraction);
  const profitPrice = rule.profitFraction == null ? null : input.entryPrice * (1 + rule.profitFraction);
  let peak = input.entryPrice;
  let armed = false;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const fraction = (mark.price - input.entryPrice) / input.entryPrice;
    if (mark.price <= stopPrice + PRICE_EPS) return priced(input.entryPrice, mark.price);
    if (mark.price > peak) peak = mark.price;
    if (rule.trailArm != null && fraction + PRICE_EPS >= rule.trailArm) armed = true;
    if (armed && rule.trailGiveback != null && mark.price <= peak * (1 - rule.trailGiveback) + PRICE_EPS) {
      return priced(input.entryPrice, mark.price);
    }
    if (profitPrice != null && mark.price + PRICE_EPS >= profitPrice) return priced(input.entryPrice, mark.price);
    const dte = calendarDaysBetween(newYorkDate(new Date(mark.at)), input.expiration);
    if (dte != null && dte <= LAST_WEEK_CALENDAR_DAYS) return priced(input.entryPrice, mark.price);
    const days = chicagoTradingDaysElapsed(new Date(input.openedAt), new Date(mark.at));
    if (days >= rule.flatDays) return priced(input.entryPrice, mark.price);
  }
  return null;
}

/**
 * Walk traded minutes only. A missing minute is a gap: no bar is inserted and
 * no price is interpolated. If one candle's low reaches the stop and its high
 * reaches the target, the stop wins and the walk is marked ambiguous.
 * A candle that opens already through a level fills at the open. Otherwise the
 * fill is the level the high or low touched.
 */
export function replayCandleExit(
  input: {
    entryPrice: number;
    openedAt: number;
    expiration: string;
    candles: readonly CandleBar[];
  },
  rule: WhatIfScenario,
): CandleWalk | null {
  if (!(input.entryPrice > 0) || !Number.isFinite(input.entryPrice)) return null;
  const bars = usableCandleBars(input.candles, input.openedAt);
  if (bars.length === 0) return null;
  const stopPrice = cappedStop(input.entryPrice, rule.stopFraction);
  const profitPrice = rule.profitFraction == null ? null : input.entryPrice * (1 + rule.profitFraction);
  let peak = input.entryPrice;
  let armed = false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const stopHit = bar.l <= stopPrice + PRICE_EPS;
    const targetHit = profitPrice != null && bar.h + PRICE_EPS >= profitPrice;
    if (stopHit && targetHit) {
      return walked(priced(input.entryPrice, stopFill(bar, stopPrice)), true, bar.t, bars.length);
    }
    if (stopHit) {
      return walked(priced(input.entryPrice, stopFill(bar, stopPrice)), false, bar.t, bars.length);
    }
    if (armed && rule.trailGiveback != null) {
      const trailPrice = peak * (1 - rule.trailGiveback);
      if (bar.l <= trailPrice + PRICE_EPS) {
        const fill = bar.o <= trailPrice + PRICE_EPS ? bar.o : trailPrice;
        const sameBarPeak = bar.h > peak + PRICE_EPS;
        return walked(priced(input.entryPrice, fill), sameBarPeak, bar.t, bars.length);
      }
    }
    if (bar.h > peak) peak = bar.h;
    if (rule.trailArm != null && (peak - input.entryPrice) / input.entryPrice + PRICE_EPS >= rule.trailArm) armed = true;
    if (targetHit) {
      return walked(priced(input.entryPrice, targetFill(bar, profitPrice as number)), false, bar.t, bars.length);
    }
    const dte = calendarDaysBetween(newYorkDate(new Date(bar.t)), input.expiration);
    if (dte != null && dte <= LAST_WEEK_CALENDAR_DAYS) {
      return walked(priced(input.entryPrice, bar.c), false, bar.t, bars.length);
    }
    const days = chicagoTradingDaysElapsed(new Date(input.openedAt), new Date(bar.t));
    if (days >= rule.flatDays) return walked(priced(input.entryPrice, bar.c), false, bar.t, bars.length);
  }
  return { exit: null, ambiguous: false, at: null, barsUsed: bars.length };
}

/** Traded minutes at or after entry. The gap between two timestamps is left empty. */
export function usableCandleBars(bars: readonly CandleBar[], openedAt: number): CandleBar[] {
  const filtered: CandleBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!Number.isFinite(bar.t) || bar.t < openedAt) continue;
    if (!Number.isFinite(bar.o) || !Number.isFinite(bar.h) || !Number.isFinite(bar.l) || !Number.isFinite(bar.c)) continue;
    if (!(bar.o > 0) || !(bar.h > 0) || !(bar.l > 0) || !(bar.c > 0)) continue;
    if (bar.h + PRICE_EPS < bar.l) continue;
    filtered.push(bar);
  }
  filtered.sort((a, b) => a.t - b.t);
  const out: CandleBar[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const bar = filtered[i];
    const prev = out[out.length - 1];
    if (prev && prev.t === bar.t) out[out.length - 1] = bar;
    else out.push(bar);
  }
  return out;
}

/**
 * Default leaves research tracks out, so the scorecard what-if stays on A and B.
 * Pass grades to include those letters, including research tracks of that letter.
 */
export function whatIfFromShadows(
  rows: readonly ShadowTrade[],
  options?: {
    grades?: readonly string[];
    research?: readonly WhatIfPath[];
    candles?: ReadonlyMap<string, readonly CandleBar[]>;
  },
): WhatIfReport {
  const grades = options?.grades;
  const usable: WhatIfPath[] = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.cohort === "experiment" || row.grade === "test") continue;
    if (grades && grades.indexOf(row.grade) === -1) continue;
    const marks = row.marks ?? [];
    const key = contractKey(row);
    const candles = candlesFor(key, row.openedAt, options?.candles);
    if ((marks.length === 0 && candles.length === 0) || !(row.entryPrice > 0)) {
      skipped += 1;
      continue;
    }
    usable.push({
      grade: row.grade,
      entryPrice: row.entryPrice,
      openedAt: row.openedAt,
      expiration: row.expiration,
      marks,
      contractKey: key,
      candles,
    });
  }
  if (grades && options?.research) {
    for (let i = 0; i < options.research.length; i++) {
      const row = options.research[i];
      if (grades.indexOf(row.grade) === -1) continue;
      const marks = row.marks ?? [];
      const candles = row.candles && row.candles.length > 0
        ? usableCandleBars(row.candles, row.openedAt)
        : candlesFor(row.contractKey, row.openedAt, options.candles);
      if ((marks.length === 0 && candles.length === 0) || !(row.entryPrice > 0)) {
        skipped += 1;
        continue;
      }
      usable.push({ ...row, marks, candles });
    }
  }
  const candlePaths = usable.filter((row) => usableCandleBars(row.candles ?? [], row.openedAt).length > 0).length;
  const markPaths = usable.length - candlePaths;
  return {
    note: WHAT_IF_NOTE,
    pathNote: WHAT_IF_PATH_NOTE,
    included: usable.length,
    skipped,
    candlePaths,
    markPaths,
    coverageNote: whatIfCoverageNote(candlePaths, markPaths),
    scenarios: WHAT_IF_SCENARIOS.map((rule) => summarize(rule, usable, candlePaths, markPaths)),
  };
}

export function whatIfCoverageNote(candlePaths: number, markPaths: number): string {
  if (candlePaths === 0 && markPaths === 0) {
    return "No path has 1-minute candles or 15-minute marks yet.";
  }
  if (candlePaths === 0) {
    return "No stored 1-minute candles for these paths, so every row uses the 15-minute marks.";
  }
  if (markPaths === 0) {
    return "Every included path uses 1-minute highs and lows. A minute with no trade is a gap and is not filled in.";
  }
  const candleLabel = `${candlePaths} included path${candlePaths === 1 ? "" : "s"}`;
  const markLabel = `${markPaths} use 15-minute marks because no candles are stored for them.`;
  return `${candleLabel} use 1-minute highs and lows. ${markLabel} Minutes with no trades are left as gaps.`;
}

function summarize(
  rule: WhatIfScenario,
  rows: readonly WhatIfPath[],
  candlePaths: number,
  markPaths: number,
): WhatIfResult {
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let unresolved = 0;
  let winDollars = 0;
  let lossDollars = 0;
  let total = 0;
  let ambiguous = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const bars = usableCandleBars(row.candles ?? [], row.openedAt);
    let exit: ReplayExit | null;
    if (bars.length > 0) {
      const walked = replayCandleExit({
        entryPrice: row.entryPrice,
        openedAt: row.openedAt,
        expiration: row.expiration,
        candles: bars,
      }, rule);
      exit = walked?.exit ?? null;
      if (walked?.ambiguous) ambiguous += 1;
    } else {
      exit = replayExit({
        entryPrice: row.entryPrice,
        openedAt: row.openedAt,
        expiration: row.expiration,
        marks: row.marks ?? [],
      }, rule);
    }
    if (!exit) {
      unresolved += 1;
      continue;
    }
    total += exit.pnlDollars;
    if (Math.abs(exit.pnlDollars) < TRADE_RULES.flatAbsDollars) flats += 1;
    else if (exit.pnlDollars > 0) {
      wins += 1;
      winDollars += exit.pnlDollars;
    } else {
      losses += 1;
      lossDollars += Math.abs(exit.pnlDollars);
    }
  }
  const resolved = wins + losses + flats;
  const decided = wins + losses;
  return {
    id: rule.id,
    label: rule.label,
    resolved,
    unresolved,
    wins,
    losses,
    flats,
    winRate: decided > 0 ? wins / decided : null,
    averageWin: wins > 0 ? winDollars / wins : null,
    averageLoss: losses > 0 ? lossDollars / losses : null,
    totalPnl: total,
    tooFew: resolved < SHADOW_MIN_TRUST,
    source: candlePaths > 0 && markPaths > 0 ? "mixed" : candlePaths > 0 ? "1m" : "15m",
    ambiguous,
  };
}

/**
 * True when a resolved A/B shadow still needs real quotes.
 * A shadow with no stored path is left out. Missed quotes are not filled in.
 * Past expiration, or the trading-day cap, ends the path.
 * An older shadow stops once every replay has an exit.
 * A quoteTrack shadow, saved after this tracking shipped, keeps going until the
 * 7-day cap or expiration, including after the live scorecard exit.
 */
export function shadowPathStillNeeded(row: ShadowTrade, now: Date): boolean {
  if (row.status !== "closed" || isExperimentShadow(row)) return false;
  if (!(row.entryPrice > 0) || !Number.isFinite(row.entryPrice)) return false;
  const marks = row.marks ?? [];
  if (marks.length === 0) return false;
  if (chicagoTradingDaysElapsed(new Date(row.openedAt), now) >= PATH_MARK_TRADING_DAY_CAP) return false;
  const dte = calendarDaysBetween(newYorkDate(now), row.expiration);
  if (dte != null && dte < 0) return false;
  if (row.quoteTrack === true) return true;
  return !pathScenariosResolved(row);
}

function pathScenariosResolved(row: ShadowTrade): boolean {
  const input = {
    entryPrice: row.entryPrice,
    openedAt: row.openedAt,
    expiration: row.expiration,
    marks: row.marks ?? [],
  };
  for (let i = 0; i < WHAT_IF_SCENARIOS.length; i++) {
    if (replayExit(input, WHAT_IF_SCENARIOS[i]) == null) return false;
  }
  return true;
}

/**
 * Closed shadows to mark this run. Open shadows are already chosen.
 * At most PATH_MARK_QUOTES_PER_RUN new contracts, and never past the open cap
 * plus that bound. A contract the open set already quotes is included for free.
 */
export function selectPathMarkShadows(
  rows: readonly ShadowTrade[],
  alreadyQuoted: readonly ShadowTrade[],
  now: Date,
  uniqueCeiling: number = SHADOW_QUOTES_PER_RUN + PATH_MARK_QUOTES_PER_RUN,
): ShadowTrade[] {
  const seen = new Set<string>();
  for (let i = 0; i < alreadyQuoted.length; i++) seen.add(contractKey(alreadyQuoted[i]));
  const candidates = rows.filter((row) => shadowPathStillNeeded(row, now)).slice().sort(byPathAge);
  const out: ShadowTrade[] = [];
  let added = 0;
  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    const key = contractKey(row);
    if (seen.has(key)) {
      out.push(row);
      continue;
    }
    if (added >= PATH_MARK_QUOTES_PER_RUN || seen.size >= uniqueCeiling) continue;
    seen.add(key);
    added += 1;
    out.push(row);
  }
  return out;
}

function byPathAge(a: ShadowTrade, b: ShadowTrade): number {
  const age = latestMarkAt(a) - latestMarkAt(b);
  if (age !== 0) return age;
  if (a.openedAt !== b.openedAt) return a.openedAt - b.openedAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function latestMarkAt(row: ShadowTrade): number {
  const marks = row.marks ?? [];
  let latest = 0;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].at > latest) latest = marks[i].at;
  }
  return latest;
}

function cappedStop(entry: number, stopFraction: number): number {
  const percentStop = entry * (1 + stopFraction);
  const dollarStop = entry - MAX_LOSS_DOLLARS / 100;
  return Math.max(percentStop, dollarStop);
}

function priced(entry: number, price: number): ReplayExit {
  return {
    pnlDollars: (price - entry) * 100,
    pnlFraction: (price - entry) / entry,
  };
}

function walked(exit: ReplayExit, ambiguous: boolean, at: number, barsUsed: number): CandleWalk {
  return { exit, ambiguous, at, barsUsed };
}

function stopFill(bar: CandleBar, stopPrice: number): number {
  if (bar.o <= stopPrice + PRICE_EPS) return bar.o;
  return stopPrice;
}

function targetFill(bar: CandleBar, target: number): number {
  if (bar.o + PRICE_EPS >= target) return bar.o;
  return target;
}

function candlesFor(
  key: string | undefined,
  openedAt: number,
  map: ReadonlyMap<string, readonly CandleBar[]> | undefined,
): CandleBar[] {
  if (!key || !map) return [];
  const found = map.get(key);
  if (!found) return [];
  return usableCandleBars(found, openedAt);
}

function scenario(
  id: string,
  label: string,
  profitFraction: number | null,
  stopFraction: number,
  flatDays: number,
  trailArm: number | null,
  trailGiveback: number | null,
): WhatIfScenario {
  return { id, label, profitFraction, stopFraction, flatDays, trailArm, trailGiveback };
}
