import type { StoredAlert } from "@/app/lib/alertBook";
import { TRADE_RULES } from "@/app/lib/alertConfig";
import { planExits } from "@/app/lib/exits";
import { calendarDaysBetween, newYorkDate, notionalPremium } from "@/app/lib/flow";
import type { HealthReport } from "@/app/lib/healthReport";
import { chicagoClock, chicagoDate, chicagoTradingDaysElapsed, isChicagoMarketHours, previousChicagoTradingDay } from "@/app/lib/marketHours";
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
 * Alerts, shadows, and the paper log come from what is already stored.
 * The route passes a Schwab quote for each open paper trade. This function
 * does not fetch, and it does not write a trade, a shadow, or an alert.
 * Open scorecard shadows stay on the mark the 15-minute scan stored.
 */

export const MARKS_NOTE =
  "Open paper trades are quoted from Schwab: bid, ask, mid, and the quote time. The headline mark is the bid. P&L and the distance to the stop and target are also given at the mid. During the Central regular session that quote is current. Outside that session it is the latest quote Schwab returned. Open scorecard shadows keep the mark stored by the 15-minute scan, and this brief does not refresh them. If a paper trade has no quote, it falls back to that stored mark and is labeled stored, with the time the mark was saved and why the quote was missing.";

export const NO_TRADES_NOTE =
  "No paper trades are in the log. Open positions, this week's realized P&L, and today's loss streak are zeros, not estimates.";

export const NO_STORED_MARK_NOTE =
  "No current quote and no stored mark.";

export const LATEST_QUOTE_NOTE =
  "Market is closed. This is the latest Schwab quote, not a regular-session price.";

/** Age label for a stored fallback. markAsOf is the ISO time the mark was saved. */
export function storedMarkNote(markAsOf: string | null, now: Date): string {
  if (!markAsOf) return "Stored scorecard mark. The time it was saved is missing. Not a current quote.";
  const at = Date.parse(markAsOf);
  if (!Number.isFinite(at)) return `Stored scorecard mark as of ${markAsOf}. Not a current quote.`;
  return `Stored scorecard mark as of ${markAsOf} (${ageLabel(now.getTime() - at)}). Not a current quote.`;
}

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
  /** stored: the 15-minute scan saved this mark. This brief does not re-quote shadows. */
  markSource: "stored" | null;
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

/** A Schwab quote for one open paper trade. The route fills this. The brief does not fetch it. */
export interface BriefPaperQuote {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** Milliseconds since epoch, from the Schwab quote time. */
  quotedAt: number | null;
}

export interface BriefPaperPosition {
  ticker: string;
  contract: BriefContract;
  contracts: number;
  entryPrice: number;
  entryAt: string | null;
  grade: "A" | "B" | "C" | "D" | null;
  /** Bid from the Schwab quote. Null when the brief fell back to a stored mark. */
  bid: number | null;
  /** Ask from the Schwab quote. Null when the brief fell back to a stored mark. */
  ask: number | null;
  /** (bid + ask) / 2 when the quote had both sides. Null on a stored fallback. */
  mid: number | null;
  /** Schwab quote time. Null on a stored fallback, or when Schwab sent no time. */
  quotedAt: string | null;
  /**
   * regular during the Central cash session (weekdays, 8:30–15:00).
   * latest when the market is closed and the quote is the last one Schwab returned.
   * Null on a stored fallback.
   */
  quoteSession: "regular" | "latest" | null;
  /**
   * Price used for the headline P&L and the headline stop and target distances.
   * The bid when a quote has one, otherwise the mid, otherwise the stored mark.
   */
  mark: number | null;
  markAt: string | null;
  /** quote when Schwab returned a bid or a mid. stored when the brief fell back. */
  markSource: "quote" | "stored" | null;
  /** Time the stored mark was saved. Null when the mark is a quote. */
  markAsOf: string | null;
  /** Headline P&L in dollars, from the bid when the quote has a bid. */
  unrealizedPnlDollars: number | null;
  unrealizedPnlAtBid: number | null;
  unrealizedPnlAtMid: number | null;
  /** Percent from the entry to the headline price. Negative means down. */
  changePercent: number | null;
  changePercentAtBid: number | null;
  changePercentAtMid: number | null;
  /** +40% target from the same exit plan as the trade log. Null when the plan cannot be priced. */
  targetPrice: number | null;
  /**
   * -25% stop from the same exit plan as the trade log.
   * The dollar cap can tighten it. Null when the plan cannot be priced.
   */
  stopPrice: number | null;
  /** Option price still left to the target, from the headline price. Positive means not there yet. */
  distanceToTarget: number | null;
  /** Option price still above the stop, from the headline price. Negative means the price is through the stop. */
  distanceToStop: number | null;
  distanceToTargetPercent: number | null;
  distanceToStopPercent: number | null;
  distanceToTargetAtBid: number | null;
  distanceToStopAtBid: number | null;
  distanceToTargetPercentAtBid: number | null;
  distanceToStopPercentAtBid: number | null;
  distanceToTargetAtMid: number | null;
  distanceToStopAtMid: number | null;
  distanceToTargetPercentAtMid: number | null;
  distanceToStopPercentAtMid: number | null;
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
  /** Live quotes keyed by trade id. Missing and empty means the stored mark. */
  paperQuotes?: Readonly<Record<string, BriefPaperQuote>>;
  /** Why a live quote is missing, keyed by trade id. Appended to a stored-mark note. */
  paperQuoteMisses?: Readonly<Record<string, string>>;
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
        .map((trade) => paperPosition(
          trade,
          marks.get(contractKey(trade)),
          input.paperQuotes?.[trade.id],
          input.now,
          input.paperQuoteMisses?.[trade.id],
        )),
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
    markSource: mark == null ? null : "stored",
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
  stored: StoredMark | undefined,
  quote: BriefPaperQuote | undefined,
  now: Date,
  miss: string | undefined,
): BriefPaperPosition {
  const storedPrice = stored?.price ?? null;
  const bid = positivePrice(quote?.bid);
  const ask = positivePrice(quote?.ask);
  const mid = positivePrice(quote?.mid);
  const quoted = bid != null || mid != null;
  const headline = bid ?? (quoted ? mid : null) ?? storedPrice;
  const markSource: BriefPaperPosition["markSource"] = quoted ? "quote" : storedPrice != null ? "stored" : null;
  const quoteSession: BriefPaperPosition["quoteSession"] = quoted
    ? (isChicagoMarketHours(now) ? "regular" : "latest")
    : null;
  const quotedAt = quoted ? iso(quote?.quotedAt) : null;
  const markAsOf = markSource === "stored" ? stored?.at ?? null : null;
  const plan = planExits({
    premium: trade.entryPrice,
    contracts: trade.contracts,
    structure: trade.structure === "debit-spread" ? "debit-spread" : "single",
  });
  const target = plan?.profitPrice ?? null;
  const stop = plan?.stopPrice ?? null;
  const atBid = priceGap(trade.entryPrice, trade.contracts, bid, target, stop);
  const atMid = priceGap(trade.entryPrice, trade.contracts, quoted ? mid : null, target, stop);
  const atHeadline = priceGap(trade.entryPrice, trade.contracts, headline, target, stop);
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
    bid: quoted ? bid : null,
    ask: quoted ? ask : null,
    mid: quoted ? mid : null,
    quotedAt,
    quoteSession,
    mark: headline,
    markAt: markSource === "quote" ? quotedAt : markSource === "stored" ? stored?.at ?? null : null,
    markSource,
    markAsOf,
    unrealizedPnlDollars: atHeadline.pnl,
    unrealizedPnlAtBid: atBid.pnl,
    unrealizedPnlAtMid: atMid.pnl,
    changePercent: atHeadline.changePercent,
    changePercentAtBid: atBid.changePercent,
    changePercentAtMid: atMid.changePercent,
    targetPrice: target,
    stopPrice: stop,
    distanceToTarget: atHeadline.distanceToTarget,
    distanceToStop: atHeadline.distanceToStop,
    distanceToTargetPercent: atHeadline.distanceToTargetPercent,
    distanceToStopPercent: atHeadline.distanceToStopPercent,
    distanceToTargetAtBid: atBid.distanceToTarget,
    distanceToStopAtBid: atBid.distanceToStop,
    distanceToTargetPercentAtBid: atBid.distanceToTargetPercent,
    distanceToStopPercentAtBid: atBid.distanceToStopPercent,
    distanceToTargetAtMid: atMid.distanceToTarget,
    distanceToStopAtMid: atMid.distanceToStop,
    distanceToTargetPercentAtMid: atMid.distanceToTargetPercent,
    distanceToStopPercentAtMid: atMid.distanceToStopPercent,
    note: quoteNote(markSource, quoteSession, markAsOf, now, miss),
  };
}

function quoteNote(
  markSource: BriefPaperPosition["markSource"],
  quoteSession: BriefPaperPosition["quoteSession"],
  markAsOf: string | null,
  now: Date,
  miss: string | undefined,
): string | null {
  if (markSource === "quote") return quoteSession === "latest" ? LATEST_QUOTE_NOTE : null;
  const base = markSource === "stored" ? storedMarkNote(markAsOf, now) : NO_STORED_MARK_NOTE;
  const reason = miss?.trim();
  if (!reason) return base;
  return `${base} ${reason}`;
}

function priceGap(
  entry: number,
  contracts: number,
  price: number | null,
  target: number | null,
  stop: number | null,
): {
  pnl: number | null;
  changePercent: number | null;
  distanceToTarget: number | null;
  distanceToStop: number | null;
  distanceToTargetPercent: number | null;
  distanceToStopPercent: number | null;
} {
  return {
    pnl: price == null ? null : cents((price - entry) * contracts * 100),
    changePercent: changePercent(entry, price),
    distanceToTarget: price != null && target != null ? target - price : null,
    distanceToStop: price != null && stop != null ? price - stop : null,
    distanceToTargetPercent: distancePercent(entry, price, target, "target"),
    distanceToStopPercent: distancePercent(entry, price, stop, "stop"),
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
  return positivePrice(value);
}

function positivePrice(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || !(value > 0)) return null;
  return value;
}

function ageLabel(elapsedMs: number): string {
  if (elapsedMs < 0) return "timestamp is ahead of this brief";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "less than a minute old";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} old`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} old`;
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
