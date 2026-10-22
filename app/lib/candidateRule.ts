import { TRADE_RULES } from "@/app/lib/alertConfig";
import type { StoredAlert } from "@/app/lib/alertBook";
import type { CandleBar } from "@/app/lib/candleTypes";
import { usableCandleBars } from "@/app/lib/exitWhatIf";
import { addCalendarDays } from "@/app/lib/flow";
import { chicagoCloseBeforeExpirationMs, chicagoTradingDayCutoffMs } from "@/app/lib/marketHours";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { inWeakWindow, isBig3m } from "@/app/lib/scanLabels";
import { contractKey, isExperimentShadow, LAST_WEEK_CALENDAR_DAYS, SHADOW_MIN_TRUST, type ShadowCohort, type ShadowTrade } from "@/app/lib/shadow";
import { chicagoYmd, newYorkMidnightMs } from "@/app/lib/zonedDay";

/**
 * Shadow (what-if) tracking of a candidate exit rule and entry filters.
 * Read-only. Nothing here changes a live exit, a grade, the Scorecard, or Telegram.
 * Live results are the tracked scorecard outcomes. Shadow results replay the
 * same alerts on the stored 1-minute candles.
 */

export const BIG_FLOW_DOLLARS = 1_000_000;

export interface ExitRule {
  /** Negative fraction. -0.40 is a 40% stop, capped at the $875 loss limit. */
  stopFraction: number;
  /** Null means no fixed target. */
  targetFraction: number | null;
  /** Trailing exit arms once the best price is this far above entry. */
  trailArm: number | null;
  /** Once armed, exit this fraction below the best price. */
  trailGiveback: number | null;
  /** Move the stop to entry once the best price is this far above entry. */
  breakevenArm: number | null;
  /** Cut at 60 minutes when the stock is this fraction against the trade. */
  cutAgainstAt60: number | null;
  flatDays: number;
}

/** The candidate: -30% stop, no target, trail 15% off the peak once up 20%. */
export const CANDIDATE_RULE: ExitRule = {
  stopFraction: -0.30,
  targetFraction: null,
  trailArm: 0.20,
  trailGiveback: 0.15,
  breakevenArm: null,
  cutAgainstAt60: null,
  flatDays: TRADE_RULES.flatAfterTradingDays,
};

/** The live exits, replayed on candles, with one change each. */
export const LIVE_RULE: ExitRule = {
  stopFraction: -TRADE_RULES.stopLossFraction,
  targetFraction: TRADE_RULES.profitTargetFraction,
  trailArm: null,
  trailGiveback: null,
  breakevenArm: null,
  cutAgainstAt60: null,
  flatDays: TRADE_RULES.flatAfterTradingDays,
};
export const BREAKEVEN_RULE: ExitRule = { ...LIVE_RULE, breakevenArm: 0.15 };
export const CUT60_RULE: ExitRule = { ...LIVE_RULE, cutAgainstAt60: 0.003 };

const EPS = 1e-6;
const HOUR_MS = 60 * 60 * 1000;

export interface ShadowRuleFlags {
  /** $3M+ flow premium at send time. Null when the premium was not stored. */
  big3m: boolean | null;
  /** First alert on this ticker that Chicago trading day. */
  firstOfDay: boolean;
  /** Sent 11:00–11:59 AM Chicago. */
  weakWindow: boolean;
  /** Passes $3M+, first-of-day and not weak window. */
  inFilter: boolean;
  /** Passed the filter but skipped because two shadow-set losses had already closed that day. */
  dailyStopped: boolean;
  /** In the shadow set: passed the filter and the daily stop. */
  inShadowSet: boolean;
}

export interface ShadowRuleTrade {
  id: string;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  openedAt: number;
  flowPremium: number | null;
  /** Tracked scorecard result (reference only). */
  livePnl: number;
  /** Live exits replayed on the same 1-minute candles. Null when still open under live exits. */
  liveReplayPnl: number | null;
  candidatePnl: number | null;
  /** When the candidate exit closed. Used for the shadow daily stop. */
  candidateExitAt: number | null;
  flags: ShadowRuleFlags;
}

export interface SideStats {
  trades: number;
  wins: number;
  winRate: number | null;
  avgPnl: number | null;
  totalPnl: number;
}

export interface ShadowComparison {
  id: string;
  label: string;
  /** Live exits replayed on the same 1-minute candles. */
  live: SideStats;
  shadow: SideStats;
  /** Tracked scorecard result for the live set. Reference only. */
  tracked: SideStats;
  tooFew: boolean;
}

export interface ShadowRuleReport {
  note: string;
  sampleNote: string;
  ruleLabel: string;
  included: number;
  skippedNoCandles: number;
  skippedOpen: number;
  comparisons: ShadowComparison[];
  trades: ShadowRuleTrade[];
}

export const SHADOW_RULE_NOTE =
  "What-if only. These rows track a candidate rule. They do not change live exits, grades, the Scorecard, or Telegram. Live replays the live exits and shadow replays the alternative, both on the same stored 1-minute candles, so the two columns compare like for like. The tracked scorecard result is shown as a reference (high and low of each traded minute; gaps are not filled). $ is per contract.";

export const SHADOW_RULE_LABEL =
  "Shadow set: $3M+ flow only, first alert per ticker per day, skip 11:00–11:59 AM CT, and the daily stop on (no new shadow trades after two shadow losses close that day). Exit: stop at -30% (loss still capped at $875), no fixed target, and once the trade is up 20%, sell if it falls 15% below its best price. Time stop and last-week exit stay as live.";

/** Shadow losses closed earlier the same day that stop new shadow trades. */
export const SHADOW_DAILY_STOP_LOSSES = 2;

export function shadowSampleText(n: number): string {
  if (n >= SHADOW_MIN_TRUST) return `${n} trades in the smallest compared row.`;
  return `Under ${SHADOW_MIN_TRUST} trades in a row is too few to trust. Treat those rows as a hint, not a result.`;
}

export interface ExitOutcome {
  pnlDollars: number;
  at: number;
  reason: "stop" | "target" | "trail" | "breakeven" | "cut60" | "time" | "lastWeek" | "preExpiry";
}

/** Walk traded minutes. A stop and a target in the same minute counts as the stop. */
export function replayRule(
  input: {
    entryPrice: number;
    openedAt: number;
    expiration: string;
    candles: readonly CandleBar[];
    delta: number | null;
    underlying: number | null;
    cohort?: ShadowCohort;
  },
  rule: ExitRule,
): ExitOutcome | null {
  const entry = input.entryPrice;
  if (!(entry > 0)) return null;
  const bars = usableCandleBars(input.candles, input.openedAt);
  if (bars.length === 0) return null;
  const hardStop = Math.max(entry * (1 + rule.stopFraction), entry - MAX_LOSS_DOLLARS / 100);
  const target = rule.targetFraction == null ? null : entry * (1 + rule.targetFraction);
  const short = input.cohort === "experiment-short";
  const lastWeekAt = short
    ? (chicagoCloseBeforeExpirationMs(input.expiration) ?? Number.POSITIVE_INFINITY)
    : lastWeekCutoff(input.expiration);
  const flatAt = chicagoTradingDayCutoffMs(new Date(input.openedAt), rule.flatDays) ?? Number.POSITIVE_INFINITY;
  const cutAt = input.openedAt + HOUR_MS;
  let stop = hardStop;
  let stopReason: ExitOutcome["reason"] = "stop";
  let peak = entry;
  let armed = false;
  let cutChecked = rule.cutAgainstAt60 == null;
  const out = (price: number, at: number, reason: ExitOutcome["reason"]): ExitOutcome => ({ pnlDollars: (price - entry) * 100, at, reason });
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!cutChecked && bar.t >= cutAt) {
      cutChecked = true;
      const prev = i > 0 ? bars[i - 1] : null;
      if (prev) {
        const against = stockAgainstFraction(prev.c, entry, input.delta, input.underlying);
        if (against != null && against + EPS >= (rule.cutAgainstAt60 as number)) return out(bar.o, bar.t, "cut60");
      }
    }
    const trailPrice = armed && rule.trailGiveback != null ? peak * (1 - rule.trailGiveback) : -Infinity;
    const floor = Math.max(stop, trailPrice);
    if (bar.l <= floor + EPS) {
      const fill = bar.o <= floor + EPS ? bar.o : floor;
      const reason = floor === trailPrice && trailPrice > stop ? "trail" : stopReason;
      return out(fill, bar.t, reason);
    }
    if (target != null && bar.h + EPS >= target) return out(bar.o >= target ? bar.o : target, bar.t, "target");
    if (bar.h > peak) peak = bar.h;
    const gain = (peak - entry) / entry;
    if (rule.trailArm != null && gain + EPS >= rule.trailArm) armed = true;
    if (rule.breakevenArm != null && gain + EPS >= rule.breakevenArm && stop < entry) {
      stop = entry;
      stopReason = "breakeven";
    }
    if (bar.t >= lastWeekAt) return out(bar.c, bar.t, short ? "preExpiry" : "lastWeek");
    if (bar.t >= flatAt) return out(bar.c, bar.t, "time");
  }
  return null;
}

/**
 * Estimated stock move against the trade, as a fraction of the stock price.
 * The option's change divided by |delta| x stock price. Null when inputs are missing.
 */
export function stockAgainstFraction(price: number, entry: number, delta: number | null, underlying: number | null): number | null {
  if (delta == null || underlying == null || !(Math.abs(delta) > 0.01) || !(underlying > 0)) return null;
  return -(price - entry) / (Math.abs(delta) * underlying);
}

export function analyzeShadowRule(input: {
  shadows: readonly ShadowTrade[];
  alerts: readonly StoredAlert[];
  candles?: ReadonlyMap<string, readonly CandleBar[]>;
}): ShadowRuleReport {
  const firstIds = firstAlertIds(input.alerts);
  const alertById = new Map<string, StoredAlert>();
  for (const alert of input.alerts) alertById.set(alert.id, alert);
  const trades: ShadowRuleTrade[] = [];
  let skippedNoCandles = 0;
  let skippedOpen = 0;
  for (const row of input.shadows) {
    if (isExperimentShadow(row) || row.grade === "test") continue;
    if (row.status !== "closed" || row.pnlDollars == null || !(row.entryPrice > 0)) {
      skippedOpen += 1;
      continue;
    }
    const candles = input.candles?.get(contractKey(row)) ?? [];
    if (usableCandleBars(candles, row.openedAt).length === 0) {
      skippedNoCandles += 1;
      continue;
    }
    const alert = alertById.get(row.alertId);
    const features = row.features;
    const premium = features?.flowPremium ?? null;
    const underlying = row.entryUnderlying ?? alert?.underlyingPrice ?? null;
    const base = { entryPrice: row.entryPrice, openedAt: row.openedAt, expiration: row.expiration, candles, delta: features?.delta ?? null, underlying, cohort: row.cohort };
    const liveReplay = replayRule(base, LIVE_RULE);
    const candidate = replayRule(base, CANDIDATE_RULE);
    const big3m = premium == null ? null : isBig3m(premium);
    const firstOfDay = firstIds.size === 0 ? true : firstIds.has(row.alertId);
    const weakWindow = inWeakWindow(row.openedAt);
    trades.push({
      id: row.id,
      ticker: row.ticker,
      putCall: row.putCall,
      strike: row.strike,
      expiration: row.expiration,
      openedAt: row.openedAt,
      flowPremium: premium,
      livePnl: row.pnlDollars,
      liveReplayPnl: liveReplay?.pnlDollars ?? null,
      candidatePnl: candidate?.pnlDollars ?? null,
      candidateExitAt: candidate?.at ?? null,
      flags: {
        big3m,
        firstOfDay,
        weakWindow,
        inFilter: big3m === true && firstOfDay && !weakWindow,
        dailyStopped: false,
        inShadowSet: false,
      },
    });
  }
  trades.sort((a, b) => a.openedAt - b.openedAt);
  applyShadowDailyStop(trades);
  const shadowSet = trades.filter((t) => t.flags.inShadowSet);
  const comparisons: ShadowComparison[] = [
    compare("shadowVsLive", "All alerts with live exits vs the shadow set with the shadow exit", trades, shadowSet, (t) => t.candidatePnl),
    compare("shadowSetExits", "Shadow-set alerts only: live exit vs shadow exit", shadowSet, shadowSet, (t) => t.candidatePnl),
  ];
  const smallest = comparisons.reduce((m, c) => Math.min(m, c.shadow.trades, c.live.trades), Number.POSITIVE_INFINITY);
  return {
    note: SHADOW_RULE_NOTE,
    sampleNote: shadowSampleText(Number.isFinite(smallest) ? smallest : 0),
    ruleLabel: SHADOW_RULE_LABEL,
    included: trades.length,
    skippedNoCandles,
    skippedOpen,
    comparisons,
    trades,
  };
}

/**
 * Both columns use replays on the same candles. Exit rows: the same alerts,
 * live exits vs the alternative; an alert counts only when both replays closed.
 * Entry-filter rows: every alert vs the alerts the filter keeps, both with
 * live exits replayed. Tracked is the scorecard result for the live set.
 */
function compare(
  id: string,
  label: string,
  liveRows: readonly ShadowRuleTrade[],
  shadowRows: readonly ShadowRuleTrade[],
  pick: (t: ShadowRuleTrade) => number | null,
): ShadowComparison {
  const shadowVals: number[] = [];
  const liveVals: number[] = [];
  const trackedVals: number[] = [];
  if (liveRows === shadowRows) {
    for (const row of shadowRows) {
      const value = pick(row);
      if (value == null || row.liveReplayPnl == null) continue;
      shadowVals.push(value);
      liveVals.push(row.liveReplayPnl);
      trackedVals.push(row.livePnl);
    }
  } else {
    for (const row of shadowRows) {
      const value = pick(row);
      if (value != null) shadowVals.push(value);
    }
    for (const row of liveRows) {
      if (row.liveReplayPnl == null) continue;
      liveVals.push(row.liveReplayPnl);
      trackedVals.push(row.livePnl);
    }
  }
  return {
    id,
    label,
    live: stats(liveVals),
    shadow: stats(shadowVals),
    tracked: stats(trackedVals),
    tooFew: Math.min(liveVals.length, shadowVals.length) < SHADOW_MIN_TRUST,
  };
}

export function stats(values: readonly number[]): SideStats {
  let wins = 0;
  let total = 0;
  for (const v of values) {
    total += v;
    if (v >= TRADE_RULES.flatAbsDollars) wins += 1;
  }
  const n = values.length;
  return {
    trades: n,
    wins,
    winRate: n > 0 ? wins / n : null,
    avgPnl: n > 0 ? total / n : null,
    totalPnl: total,
  };
}

/**
 * Walk filtered trades in time order per Chicago day. Once two shadow losses
 * have closed before a trade opens, that trade is daily-stopped.
 */
export function applyShadowDailyStop(trades: ShadowRuleTrade[]): void {
  const byDay = new Map<string, ShadowRuleTrade[]>();
  for (const trade of trades) {
    if (!trade.flags.inFilter) continue;
    const day = chicagoYmd(trade.openedAt);
    const list = byDay.get(day) ?? [];
    list.push(trade);
    byDay.set(day, list);
  }
  byDay.forEach((list) => {
    list.sort((a, b) => a.openedAt - b.openedAt);
    const taken: ShadowRuleTrade[] = [];
    for (const trade of list) {
      let losses = 0;
      for (const prior of taken) {
        if (prior.candidatePnl != null && prior.candidatePnl <= -TRADE_RULES.flatAbsDollars && prior.candidateExitAt != null && prior.candidateExitAt <= trade.openedAt) losses += 1;
      }
      if (losses >= SHADOW_DAILY_STOP_LOSSES) {
        trade.flags.dailyStopped = true;
        continue;
      }
      trade.flags.inShadowSet = true;
      taken.push(trade);
    }
  });
}

/** Earliest A/B alert per ticker per Chicago trading day. */
export function firstAlertIds(alerts: readonly StoredAlert[]): Set<string> {
  const best = new Map<string, StoredAlert>();
  for (const alert of alerts) {
    const key = `${alert.ticker}|${alert.tradingDay || chicagoYmd(alert.sentAt)}`;
    const prev = best.get(key);
    if (!prev || alert.sentAt < prev.sentAt) best.set(key, alert);
  }
  const ids = new Set<string>();
  best.forEach((alert) => ids.add(alert.id));
  return ids;
}



function lastWeekCutoff(expiration: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return Number.POSITIVE_INFINITY;
  const ms = newYorkMidnightMs(addCalendarDays(expiration, -LAST_WEEK_CALENDAR_DAYS));
  return ms == null ? Number.POSITIVE_INFINITY : ms;
}
