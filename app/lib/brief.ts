import type { StoredAlert } from "@/app/lib/alertBook";
import { TRADE_RULES } from "@/app/lib/alertConfig";
import { planExits } from "@/app/lib/exits";
import { calendarDaysBetween, newYorkDate, notionalPremium } from "@/app/lib/flow";
import type { HealthReport } from "@/app/lib/healthReport";
import { chicagoClock, chicagoDate, chicagoTradingDaysElapsed, previousChicagoTradingDay } from "@/app/lib/marketHours";
import { likelySideFromEstimate, likelySideText, openingLabel, type LikelySide } from "@/app/lib/quoteSide";
import { DAILY_STOP_CONSECUTIVE_LOSSES } from "@/app/lib/risk";
import { isExperimentShadow, type ShadowExitReason, type ShadowTrade } from "@/app/lib/shadow";
import {
  dailyStopState,
  tradeMetrics,
  weeklyDrawdownThreshold,
  type StoredTrade,
} from "@/app/lib/trades";

/**
 * Read-only packet for a pre-market, midday, or close brief.
 * Every number comes from alerts, shadows, and the paper log already stored.
 * A missing quote stays null. Nothing here calls Schwab or places an order.
 */

export const MARKS_NOTE =
  "Marks are the latest prices already stored on scorecard shadows. This brief does not call Schwab for a new quote.";

export const NO_TRADES_NOTE =
  "No paper trades are in the log. Open positions, this week's realized P&L, and today's loss streak are zeros, not estimates.";

export const NO_STORED_MARK_NOTE =
  "No stored mark. This brief does not request a new Schwab quote.";

export const OPENING_UNRECORDED = "Opening check was not recorded on this alert.";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface BriefContract {
  type: "call" | "put";
  strike: number;
  expiry: string;
  /** Calendar days from the New York date to expiration. Same count the scan uses. */
  dte: number | null;
}

export interface BriefAlert {
  ticker: string;
  grade: "A" | "B";
  contract: BriefContract;
  /** Estimated flow premium, volume × mid × 100. Null when that number was not stored. */
  flowPremium: number | null;
  bid: number;
  ask: number;
  last: number | null;
  likelySide: LikelySide;
  likelySideLabel: string;
  /** pending, opening, closing, missing, or null when the alert predates the check. */
  openingCheck: string | null;
  openingCheckLabel: string;
  /** Null when the alert was saved before versions were stamped. */
  rulesVersion: number | null;
  savedAt: string | null;
}

export interface BriefOpenShadow {
  ticker: string;
  grade: "A" | "B";
  contract: BriefContract;
  entryPrice: number;
  entryAt: string | null;
  mark: number | null;
  markAt: string | null;
  /** Percent from the entry to the latest stored mark. 10 means up 10%. Null without a mark. */
  changePercent: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  /** Option price still left to the +40% target. Positive means the mark has not reached it. */
  distanceToTarget: number | null;
  /** Option price still above the -25% stop. Positive means the mark has not hit it. */
  distanceToStop: number | null;
  distanceToTargetPercent: number | null;
  distanceToStopPercent: number | null;
  daysHeld: number;
  /**
   * Chicago trading days held while the latest mark is inside the flat dollar band.
   * Zero when the latest mark is outside that band. Null when no mark is stored.
   */
  flatDayCount: number | null;
  /** True when the latest mark is inside the flat band. Null when no mark is stored. */
  flat: boolean | null;
  /** True when a logged trade shares this alert, or an open paper trade is the same contract. */
  paperTrade: boolean;
}

export interface BriefResolvedShadow {
  ticker: string;
  grade: "A" | "B";
  contract: BriefContract;
  exitReason: ShadowExitReason | null;
  exitLabel: string;
  /** Percent from the entry to the exit. 40 means up 40%. Null when the result was not stored. */
  resultPercent: number | null;
  pnlDollars: number | null;
  closedAt: string | null;
  paperTrade: boolean;
}

export interface BriefPaperPosition {
  ticker: string;
  contract: BriefContract;
  contracts: number;
  entryPrice: number;
  entryAt: string | null;
  grade: "A" | "B" | "C" | "D" | null;
  mark: number | null;
  markAt: string | null;
  /** stored-shadow when the mark was copied from a scorecard shadow. */
  markSource: "stored-shadow" | null;
  unrealizedPnlDollars: number | null;
  changePercent: number | null;
  note: string | null;
}

export interface BriefWeek {
  /** Monday of this Chicago week. Empty when the clock could not be read. */
  from: string;
  /** Today in America/Chicago. */
  through: string;
  realizedPnlDollars: number;
  closed: number;
  drawdownWarningDollars: number;
  flagged: boolean;
  /** Warning line plus realized P&L. Negative means the week is past the warning. */
  dollarsUntilWarning: number;
}

export interface BriefPaper {
  note: string | null;
  loggedTrades: number;
  open: BriefPaperPosition[];
  week: BriefWeek;
  todayLossStreak: number;
  dailyStop: boolean;
  /** Two losing closes in a row turn the daily stop on. This is the rule, not a count. */
  dailyStopAfter: number;
}

export interface MarketBrief {
  asOf: string;
  tradingDay: string;
  previousTradingDay: string | null;
  marksNote: string;
  alerts: {
    today: BriefAlert[];
    previousTradingDay: BriefAlert[];
  };
  shadows: {
    open: BriefOpenShadow[];
    resolvedToday: BriefResolvedShadow[];
    /** Monday through today, Central. Includes shadows resolved today. */
    resolvedThisWeek: BriefResolvedShadow[];
    exitRules: {
      targetPercent: number;
      stopPercent: number;
      flatAfterTradingDays: number;
      flatBandDollars: number;
    };
  };
  paper: BriefPaper;
  /** Same fields as GET /api/health. */
  scan: HealthReport;
}

export function buildMarketBrief(input: {
  alerts: readonly StoredAlert[];
  shadows: readonly ShadowTrade[];
  trades: readonly StoredTrade[];
  scan: HealthReport;
  now: Date;
}): MarketBrief {
  const tradingDay = chicagoDate(input.now);
  const previous = tradingDay ? previousChicagoTradingDay(tradingDay) : null;
  const week = weekThroughToday(input.now);
  const openTrades = input.trades.filter((trade) => trade.closedAt == null);
  const paperKeys = contractKeys(openTrades);
  const paperAlertIds = alertIds(input.trades);
  const marks = latestStoredMarks(input.shadows);
  const stop = dailyStopState(input.trades, input.now);
  const weekPnl = weekPnlOf(input.trades, week);
  const threshold = weeklyDrawdownThreshold();

  return {
    asOf: input.now.toISOString(),
    tradingDay,
    previousTradingDay: previous,
    marksNote: MARKS_NOTE,
    alerts: {
      today: alertsForDay(input.alerts, tradingDay, input.now),
      previousTradingDay: alertsForDay(input.alerts, previous, input.now),
    },
    shadows: {
      open: openShadows(input.shadows, paperKeys, paperAlertIds, input.now),
      resolvedToday: resolvedShadows(input.shadows, paperKeys, paperAlertIds, input.now, (day) => day === tradingDay),
      resolvedThisWeek: resolvedShadows(input.shadows, paperKeys, paperAlertIds, input.now, (day) => inWeek(day, week)),
      exitRules: {
        targetPercent: Math.round(TRADE_RULES.profitTargetFraction * 100),
        stopPercent: Math.round(TRADE_RULES.stopLossFraction * 100),
        flatAfterTradingDays: TRADE_RULES.flatAfterTradingDays,
        flatBandDollars: TRADE_RULES.flatAbsDollars,
      },
    },
    paper: {
      note: input.trades.length === 0 ? NO_TRADES_NOTE : null,
      loggedTrades: input.trades.length,
      open: openTrades
        .slice()
        .sort((a, b) => b.openedAt - a.openedAt)
        .map((trade) => paperPosition(trade, marks.get(contractKey(trade)), input.now)),
      week: {
        from: week?.from ?? "",
        through: week?.through ?? "",
        realizedPnlDollars: cents(weekPnl.pnl),
        closed: weekPnl.closed,
        drawdownWarningDollars: threshold,
        flagged: weekPnl.pnl <= -threshold + 1e-6,
        dollarsUntilWarning: cents(threshold + weekPnl.pnl),
      },
      todayLossStreak: stop.consecutiveLosses,
      dailyStop: stop.dailyStop,
      dailyStopAfter: DAILY_STOP_CONSECUTIVE_LOSSES,
    },
    scan: input.scan,
  };
}

function alertsForDay(alerts: readonly StoredAlert[], day: string | null, now: Date): BriefAlert[] {
  if (!day) return [];
  const rows: BriefAlert[] = [];
  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    if (alert.tradingDay !== day) continue;
    if (alert.grade !== "A" && alert.grade !== "B") continue;
    rows.push(briefAlert(alert, now));
  }
  rows.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
  return rows;
}

function briefAlert(alert: StoredAlert, now: Date): BriefAlert {
  const side = alert.features?.likelySide ?? likelySideFromEstimate(alert.side) ?? "unknown";
  const opening = alert.openingCheck?.status ?? null;
  return {
    ticker: alert.ticker,
    grade: alert.grade === "A" ? "A" : "B",
    contract: contractOf(alert.putCall, alert.strike, alert.expiration, now),
    flowPremium: alertPremium(alert),
    bid: alert.bid,
    ask: alert.ask,
    last: finiteOrNull(alert.last),
    likelySide: side,
    likelySideLabel: likelySideText(side),
    openingCheck: opening,
    openingCheckLabel: opening ? openingLabel(opening) : OPENING_UNRECORDED,
    rulesVersion: alert.rulesVersion ?? null,
    savedAt: iso(alert.sentAt),
  };
}

function alertPremium(alert: StoredAlert): number | null {
  const stored = alert.features?.flowPremium;
  if (stored != null && Number.isFinite(stored) && stored >= 0) return stored;
  return notionalPremium(alert.volume, alert.mid);
}

function openShadows(
  shadows: readonly ShadowTrade[],
  paperKeys: ReadonlySet<string>,
  paperAlertIds: ReadonlySet<string>,
  now: Date,
): BriefOpenShadow[] {
  const rows: BriefOpenShadow[] = [];
  for (let i = 0; i < shadows.length; i++) {
    const row = shadows[i];
    if (row.status !== "open" || !isAb(row)) continue;
    rows.push(briefOpenShadow(row, overlapsPaper(row, paperKeys, paperAlertIds), now));
  }
  rows.sort((a, b) => (b.entryAt ?? "").localeCompare(a.entryAt ?? ""));
  return rows;
}

function briefOpenShadow(row: ShadowTrade, paperTrade: boolean, now: Date): BriefOpenShadow {
  const mark = finitePrice(row.lastMark);
  const plan = planExits({ premium: row.entryPrice, contracts: 1, structure: "single" });
  const target = plan?.profitPrice ?? null;
  const stop = plan?.stopPrice ?? null;
  const daysHeld = chicagoTradingDaysElapsed(new Date(row.openedAt), now);
  const flat = mark == null ? null : Math.abs((mark - row.entryPrice) * row.contracts * 100) < TRADE_RULES.flatAbsDollars;
  return {
    ticker: row.ticker,
    grade: row.grade === "A" ? "A" : "B",
    contract: contractOf(row.putCall, row.strike, row.expiration, now),
    entryPrice: row.entryPrice,
    entryAt: iso(row.openedAt),
    mark,
    markAt: mark == null ? null : iso(row.lastMarkedAt),
    changePercent: changePercent(row.entryPrice, mark),
    targetPrice: target,
    stopPrice: stop,
    distanceToTarget: mark != null && target != null ? target - mark : null,
    distanceToStop: mark != null && stop != null ? mark - stop : null,
    distanceToTargetPercent: distancePercent(row.entryPrice, mark, target, "target"),
    distanceToStopPercent: distancePercent(row.entryPrice, mark, stop, "stop"),
    daysHeld,
    flatDayCount: flat == null ? null : flat ? daysHeld : 0,
    flat,
    paperTrade,
  };
}

function resolvedShadows(
  shadows: readonly ShadowTrade[],
  paperKeys: ReadonlySet<string>,
  paperAlertIds: ReadonlySet<string>,
  now: Date,
  include: (day: string) => boolean,
): BriefResolvedShadow[] {
  const rows: BriefResolvedShadow[] = [];
  for (let i = 0; i < shadows.length; i++) {
    const row = shadows[i];
    if (row.status !== "closed" || !isAb(row) || row.closedAt == null) continue;
    const day = chicagoDate(new Date(row.closedAt));
    if (!day || !include(day)) continue;
    rows.push({
      ticker: row.ticker,
      grade: row.grade === "A" ? "A" : "B",
      contract: contractOf(row.putCall, row.strike, row.expiration, now),
      exitReason: row.exitReason,
      exitLabel: exitLabel(row.exitReason),
      resultPercent: row.pnlFraction == null || !Number.isFinite(row.pnlFraction) ? null : row.pnlFraction * 100,
      pnlDollars: row.pnlDollars != null && Number.isFinite(row.pnlDollars) ? cents(row.pnlDollars) : null,
      closedAt: iso(row.closedAt),
      paperTrade: overlapsPaper(row, paperKeys, paperAlertIds),
    });
  }
  rows.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  return rows;
}

function paperPosition(
  trade: StoredTrade,
  mark: StoredMark | undefined,
  now: Date,
): BriefPaperPosition {
  const price = mark?.price ?? null;
  const grade = trade.alertGrade === "A" || trade.alertGrade === "B" || trade.alertGrade === "C" || trade.alertGrade === "D"
    ? trade.alertGrade
    : null;
  return {
    ticker: trade.ticker,
    contract: contractOf(trade.putCall, trade.strike, trade.expiration, now),
    contracts: trade.contracts,
    entryPrice: trade.entryPrice,
    entryAt: iso(trade.openedAt),
    grade,
    mark: price,
    markAt: price == null ? null : mark?.at ?? null,
    markSource: price == null ? null : "stored-shadow",
    unrealizedPnlDollars: price == null ? null : cents((price - trade.entryPrice) * trade.contracts * 100),
    changePercent: changePercent(trade.entryPrice, price),
    note: price == null ? NO_STORED_MARK_NOTE : null,
  };
}

interface StoredMark {
  price: number;
  at: string | null;
  markedAt: number;
}

function latestStoredMarks(shadows: readonly ShadowTrade[]): Map<string, StoredMark> {
  const marks = new Map<string, StoredMark>();
  for (let i = 0; i < shadows.length; i++) {
    const row = shadows[i];
    if (!isAb(row)) continue;
    const price = finitePrice(row.lastMark);
    if (price == null) continue;
    const markedAt = row.lastMarkedAt != null && Number.isFinite(row.lastMarkedAt) ? row.lastMarkedAt : 0;
    const next: StoredMark = { price, at: iso(row.lastMarkedAt), markedAt };
    const key = contractKey(row);
    const prior = marks.get(key);
    if (!prior || next.markedAt >= prior.markedAt) marks.set(key, next);
  }
  return marks;
}

function weekPnlOf(
  trades: readonly StoredTrade[],
  week: { from: string; through: string } | null,
): { pnl: number; closed: number } {
  if (!week) return { pnl: 0, closed: 0 };
  let pnl = 0;
  let closed = 0;
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.closedAt == null) continue;
    const day = chicagoDate(new Date(trade.closedAt));
    if (!inWeek(day, week)) continue;
    const dollars = tradeMetrics(trade).pnlDollars;
    if (dollars == null) continue;
    pnl += dollars;
    closed += 1;
  }
  return { pnl, closed };
}

function weekThroughToday(now: Date): { from: string; through: string } | null {
  const clock = chicagoClock(now);
  if (!clock?.date) return null;
  const index = WEEKDAYS.indexOf(clock.weekday);
  const sinceMonday = index <= 0 ? 6 : index - 1;
  return { from: shiftYmd(clock.date, -sinceMonday), through: clock.date };
}

function inWeek(day: string, week: { from: string; through: string } | null): boolean {
  if (!week || !day) return false;
  return day >= week.from && day <= week.through;
}

function contractKeys(trades: readonly StoredTrade[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < trades.length; i++) keys.add(contractKey(trades[i]));
  return keys;
}

function alertIds(trades: readonly StoredTrade[]): Set<string> {
  const ids = new Set<string>();
  for (let i = 0; i < trades.length; i++) {
    const id = trades[i].alertId;
    if (id) ids.add(id);
  }
  return ids;
}

function overlapsPaper(row: ShadowTrade, paperKeys: ReadonlySet<string>, paperAlertIds: ReadonlySet<string>): boolean {
  if (row.alertId && paperAlertIds.has(row.alertId)) return true;
  return paperKeys.has(contractKey(row));
}

function contractKey(row: { ticker: string; expiration: string; strike: number; putCall: string }): string {
  return `${row.ticker}|${row.expiration}|${row.strike}|${row.putCall}`;
}

function contractOf(putCall: "call" | "put", strike: number, expiry: string, now: Date): BriefContract {
  return {
    type: putCall,
    strike,
    expiry,
    dte: calendarDaysBetween(newYorkDate(now), expiry),
  };
}

function isAb(row: Pick<ShadowTrade, "grade" | "cohort">): boolean {
  if (isExperimentShadow(row)) return false;
  return row.grade === "A" || row.grade === "B";
}

function changePercent(entry: number, mark: number | null): number | null {
  if (mark == null || !(entry > 0) || !Number.isFinite(entry)) return null;
  return ((mark - entry) / entry) * 100;
}

function distancePercent(
  entry: number,
  mark: number | null,
  level: number | null,
  which: "target" | "stop",
): number | null {
  if (mark == null || level == null || !(entry > 0)) return null;
  const gap = which === "target" ? level - mark : mark - level;
  return (gap / entry) * 100;
}

function exitLabel(reason: ShadowExitReason | null): string {
  if (reason === "profit") return "Profit target";
  if (reason === "stop") return "Stop";
  if (reason === "flat") return "Flat after 3 trading days";
  if (reason === "expiration") return "Out before the last week to expiration";
  return "";
}

/** Dollar amounts in the brief are cents, so a binary fraction does not show up as a long tail. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function finitePrice(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || !(value > 0)) return null;
  return value;
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

function iso(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function shiftYmd(ymd: string, days: number): string {
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  const utc = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) + days * 86_400_000;
  const date = new Date(utc);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}
