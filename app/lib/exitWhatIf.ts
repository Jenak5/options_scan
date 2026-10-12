import { TRADE_RULES } from "@/app/lib/alertConfig";
import { calendarDaysBetween, newYorkDate, SHADOW_QUOTES_PER_RUN } from "@/app/lib/flow";
import { chicagoTradingDaysElapsed } from "@/app/lib/marketHours";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { contractKey, isExperimentShadow, LAST_WEEK_CALENDAR_DAYS, SHADOW_MIN_TRUST, type ShadowTrade } from "@/app/lib/shadow";

/**
 * Replay stored shadow marks under other exit rules.
 * The live exits are not changed. A 15-minute snapshot can miss the touch,
 * so every result here is an estimate, not a fill.
 */

export const WHAT_IF_NOTE =
  "Estimates from the stored 15-minute quote snapshots, not fills. A snapshot can miss the exact high or low between quotes. These rows are for comparison only. They do not change the live exits: take profit at +40%, stop at -25% with the loss capped at $875, out if it is still flat after 3 trading days, and out before the last week.";

export const WHAT_IF_PATH_NOTE =
  "Only shadows that stored a quote path are included. Older shadows kept the best and worst price, not the path, so they are left out instead of guessed.";

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
}

export interface WhatIfReport {
  note: string;
  pathNote: string;
  included: number;
  skipped: number;
  scenarios: WhatIfResult[];
}

interface ReplayExit {
  pnlDollars: number;
  pnlFraction: number;
}

const PRICE_EPS = 1e-6;

/**
 * Stop extending a resolved shadow's path after this many Chicago trading days
 * from entry. Weekends and full-day NYSE holidays do not count. The longest
 * replay waits 5 trading days; this cap is the backstop.
 */
export const PATH_MARK_TRADING_DAY_CAP = 7;

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

export function whatIfFromShadows(rows: readonly ShadowTrade[]): WhatIfReport {
  const usable: ShadowTrade[] = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.cohort === "experiment" || row.grade === "test") continue;
    const marks = row.marks ?? [];
    if (marks.length === 0 || !(row.entryPrice > 0)) {
      skipped += 1;
      continue;
    }
    usable.push(row);
  }
  return {
    note: WHAT_IF_NOTE,
    pathNote: WHAT_IF_PATH_NOTE,
    included: usable.length,
    skipped,
    scenarios: WHAT_IF_SCENARIOS.map((rule) => summarize(rule, usable)),
  };
}

function summarize(rule: WhatIfScenario, rows: readonly ShadowTrade[]): WhatIfResult {
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let unresolved = 0;
  let winDollars = 0;
  let lossDollars = 0;
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const exit = replayExit({
      entryPrice: row.entryPrice,
      openedAt: row.openedAt,
      expiration: row.expiration,
      marks: row.marks ?? [],
    }, rule);
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
  };
}

/**
 * True when a resolved A/B shadow still needs real quotes for a replay.
 * A shadow with no stored path is left out. Missed quotes are not filled in.
 * Past expiration, or the trading-day cap, ends the path even if a replay is open.
 */
export function shadowPathStillNeeded(row: ShadowTrade, now: Date): boolean {
  if (row.status !== "closed" || isExperimentShadow(row)) return false;
  if (!(row.entryPrice > 0) || !Number.isFinite(row.entryPrice)) return false;
  const marks = row.marks ?? [];
  if (marks.length === 0) return false;
  if (chicagoTradingDaysElapsed(new Date(row.openedAt), now) >= PATH_MARK_TRADING_DAY_CAP) return false;
  const dte = calendarDaysBetween(newYorkDate(now), row.expiration);
  if (dte != null && dte < 0) return false;
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
