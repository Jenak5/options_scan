import { EARNINGS_WINDOW, EXPERIMENT_DTE, EXPERIMENT_SHORT_DTE, OUTCOME_RULES, TRADE_RULES } from "@/app/lib/alertConfig";
import { parseRulesVersion } from "@/app/lib/rulesVersion";
import type { ShadowMark } from "@/app/lib/exitWhatIf";
import { backfillFeatures, parseFeatureSnapshot, type AlertFeatureSnapshot } from "@/app/lib/alertFeatures";
import type { StoredAlert } from "@/app/lib/alertBook";
import { EARNINGS_SECTION_NOTE, alertInEarningsWindow, earningsWindowTrustNote } from "@/app/lib/earningsWindow";
import { EXPERIMENT_SECTION_NOTE, EXPERIMENT_SHORT_SECTION_NOTE, experimentShortTrustNote, experimentTrustNote } from "@/app/lib/experiment";
import { planExits } from "@/app/lib/exits";
import { calendarDaysBetween, newYorkDate, SHADOW_QUOTES_PER_RUN } from "@/app/lib/flow";
import { chicagoCloseBeforeExpirationMs, chicagoTradingDaysElapsed } from "@/app/lib/marketHours";
import { parseSpyTrend, spyTrendFromDirection, type IndexDirection } from "@/app/lib/marketContext";
import { mergeResearchTracks, parseResearchTracks, type ResearchTrack } from "@/app/lib/researchTrack";

/**
 * Shadow outcome for an A or B alert.
 * One contract bought at the alert ask. No order is placed.
 * Quotes are the chain midpoint, or the bid when the midpoint is missing.
 * A 5-minute snapshot is not a fill.
 */

export const SHADOW_MIN_TRUST = 30;

/** Once this many calendar days remain, the shadow is closed. That is the last week. */
export const LAST_WEEK_CALENDAR_DAYS = 7;

/**
 * Marks kept on one shadow. Older marks are dropped from the front.
 * The entry session plus 7 later trading days of 5-minute marks,
 * including the cash-close pass, is 656 quotes. 680 leaves that path intact
 * so a what-if replay can still see the live exit.
 */
export const SHADOW_MARK_CAP = 680;

export const SHADOW_ESTIMATE_NOTE =
  "These results are estimates from quotes (the midpoint, or the bid when the midpoint is missing), not fills. Open shadows are marked every 5 minutes, and the option chain is only a snapshot, so an exit can show up late.";

export type ShadowExitReason = "profit" | "stop" | "flat" | "expiration";
export type ShadowQuoteSource = "mid" | "bid";
export type ShadowGrade = "A" | "B" | "test";
export type ShadowCohort = "ab" | "experiment" | "experiment-short" | "experiment-earnings";

export interface ShadowTrade {
  id: string;
  alertId: string;
  openedAt: number;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  /** A or B for a real alert. "test" is a DTE experiment and is not a grade. */
  grade: ShadowGrade;
  /** Missing on shadows saved before the test. Those stay in the A/B totals. */
  cohort: ShadowCohort;
  experimentLabel: string | null;
  /** Letter the other rules would have given. Not shown as an A or a B. */
  probeGrade: "A" | "B" | null;
  /** Grading inputs. Null when the alert had nothing that could be recovered. */
  features: AlertFeatureSnapshot | null;
  /** Checklist version copied from the alert. Null when the alert was not stamped. */
  rulesVersion?: number | null;
  /** Quote path, oldest first. Missing on shadows saved before the path was stored. */
  marks?: ShadowMark[];
  /** Highest option price seen in stored marks. Null until a mark arrives. */
  maxFavorablePrice: number | null;
  /** Lowest option price seen in stored marks. */
  maxAdversePrice: number | null;
  marksSeen: number;
  contracts: 1;
  entryPrice: number;
  entryPriceSource: "ask";
  status: "open" | "closed";
  closedAt: number | null;
  exitPrice: number | null;
  exitReason: ShadowExitReason | null;
  exitQuote: ShadowQuoteSource | null;
  /** True when the close used the previous quote because the chain no longer had this contract. */
  exitStale: boolean;
  pnlDollars: number | null;
  /** Fraction. 0.40 is plus 40 percent. */
  pnlFraction: number | null;
  tradingDaysHeld: number | null;
  lastMark: number | null;
  lastMarkSource: ShadowQuoteSource | null;
  lastMarkedAt: number | null;
  /**
   * True only for an A or B saved after research tracking shipped.
   * The live exit stays put. Quote marks continue for 7 trading days or until expiration.
   * Missing means an older scorecard shadow. Those are not backfilled.
   */
  quoteTrack?: boolean;
  /** Underlying price at entry. Present only when quoteTrack is set. Null when the scan had none. */
  entryUnderlying?: number | null;
  /** SPY versus its session VWAP at entry. See SPY_TREND_NOTE. Present only when quoteTrack is set. */
  spyTrend?: IndexDirection | null;
  /** "backfill" when spyTrend was filled later from Tastytrade SPY candles. */
  spyTrendSource?: "backfill";
}

export interface ShadowBook {
  version: 1;
  records: ShadowTrade[];
  /** C and D quote paths. Omitted when empty so an unchanged scorecard is not rewritten. */
  research?: ResearchTrack[];
}

export interface ShadowQuote {
  mid: number | null;
  bid: number | null;
}

export interface ShadowBucket {
  key: string;
  closed: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  pnlDollars: number;
}

export interface ExperimentSection {
  label: string;
  note: string;
  trustNote: string;
  resolved: number;
  open: number;
  tooFew: boolean;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  rows: ShadowListItem[];
}

export interface ShadowListItem {
  id: string;
  ticker: string;
  putCall: "call" | "put";
  grade: ShadowGrade;
  cohort: ShadowCohort;
  experimentLabel: string | null;
  /** Plain sentence for a test row. Null on a real A or B. */
  probeNote: string | null;
  strike: number;
  expiration: string;
  status: "open" | "closed";
  exitReason: ShadowExitReason | null;
  exitLabel: string;
  exitPrice: number | null;
  exitQuote: ShadowQuoteSource | null;
  exitStale: boolean;
  pnlDollars: number | null;
  pnlFraction: number | null;
  tradingDaysHeld: number | null;
  entryPrice: number;
  openedAt: number;
  closedAt: number | null;
  mark: number | null;
  unrealizedPnl: number | null;
  counted: boolean;
  countNote: string | null;
  /** Next-day open-interest label, when the alert recorded one. */
  openingLabel?: string | null;
}

export interface ShadowScorecard {
  estimateNote: string;
  sampleNote: string;
  resolved: number;
  open: number;
  excludedPaper: number;
  unpriced: number;
  tooFew: boolean;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  byGrade: ShadowBucket[];
  byTicker: ShadowBucket[];
  byRight: ShadowBucket[];
  rows: ShadowListItem[];
  /** 43–60 day test. Left out of the totals above. */
  experimental: ExperimentSection;
  /** 1–13 day test. Left out of the totals above and out of the 43–60 section. */
  experimentalShort: ExperimentSection;
  /** Earnings 1–14 days ahead and inside the hold. Left out of the totals above. */
  experimentalEarnings: ExperimentSection;
}

const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const PRICE_EPS = 1e-6;
const REASONS: ShadowExitReason[] = ["profit", "stop", "flat", "expiration"];
const RECENT_LIMIT = 24;

export function emptyShadowBook(): ShadowBook {
  return { version: 1, records: [] };
}

/** Empty research is left off the JSON so a scorecard-only book is not rewritten for the new key. */
export function serializeShadowBook(book: ShadowBook): string {
  const payload: ShadowBook = { version: 1, records: book.records };
  if (book.research && book.research.length > 0) payload.research = book.research;
  return JSON.stringify(payload);
}

export function shadowBooksEqual(left: ShadowBook, right: ShadowBook): boolean {
  return serializeShadowBook(left) === serializeShadowBook(right);
}

export function shadowSampleNote(resolved: number): string {
  if (resolved < SHADOW_MIN_TRUST) {
    return `${resolved} resolved alerts. Fewer than ${SHADOW_MIN_TRUST} is too few to trust.`;
  }
  return `${resolved} resolved alerts.`;
}

export function shadowExitLabel(reason: ShadowExitReason | null, cohort?: ShadowCohort): string {
  if (reason === "profit") {
    return "Profit target. One contract, so half off closes the whole trade.";
  }
  if (reason === "stop") return "Stop.";
  if (reason === "flat") return "Flat after 3 trading days.";
  if (reason === "expiration" && cohort === "experiment-short") {
    return "Out at the 3:00 PM Central close on the trading day before expiration.";
  }
  if (reason === "expiration") return "Out before the last week to expiration.";
  return "";
}

export function shadowFromAlert(alert: StoredAlert): ShadowTrade | null {
  if (alert.grade !== "A" && alert.grade !== "B") return null;
  if (!Number.isFinite(alert.ask) || !(alert.ask > 0)) return null;
  if (!alert.id || !ID_PATTERN.test(alert.id)) return null;
  const earningsWindow = alertInEarningsWindow(alert);
  const row: ShadowTrade = {
    id: alert.id,
    alertId: alert.id,
    openedAt: alert.sentAt,
    ticker: alert.ticker,
    putCall: alert.putCall,
    strike: alert.strike,
    expiration: alert.expiration,
    grade: alert.grade,
    cohort: earningsWindow ? "experiment-earnings" : "ab",
    experimentLabel: earningsWindow ? EARNINGS_WINDOW.label : null,
    probeGrade: null,
    features: alert.features ?? backfillFeatures(alert),
    rulesVersion: alert.rulesVersion ?? null,
    marks: [],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
    contracts: 1,
    entryPrice: alert.ask,
    entryPriceSource: "ask",
    status: "open",
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    exitQuote: null,
    exitStale: false,
    pnlDollars: null,
    pnlFraction: null,
    tradingDaysHeld: null,
    lastMark: null,
    lastMarkSource: null,
    lastMarkedAt: null,
  };
  if (alert.trackQuotes === true) {
    row.quoteTrack = true;
    row.entryUnderlying = alert.underlyingPrice != null && alert.underlyingPrice > 0 ? alert.underlyingPrice : null;
    row.spyTrend = spyTrendFromDirection(alert.features?.spyDirection);
  }
  return row;
}

export function isShortExperimentShadow(row: Pick<ShadowTrade, "cohort">): boolean {
  return row.cohort === "experiment-short";
}

/** DTE tests, and any row stored with grade "test". Left out of the 30-trade trust count. */
export function isExperimentShadow(row: Pick<ShadowTrade, "cohort" | "grade">): boolean {
  return row.cohort === "experiment" || row.cohort === "experiment-short" || row.grade === "test";
}

/**
 * Scorecard rows that stay out of the A/B totals.
 * Earnings in window includes a saved A or B, so grade alone is not enough.
 */
export function excludedFromMainTotals(row: Pick<ShadowTrade, "cohort" | "grade">): boolean {
  return row.cohort === "experiment-earnings" || isExperimentShadow(row);
}

/** Append rows and keep the same book cap the A/B shadows already use. */
export function addShadowRecords(book: ShadowBook, added: readonly ShadowTrade[]): ShadowBook {
  if (added.length === 0) return book;
  return { version: 1, records: trimShadows(book.records.concat(added)), research: book.research };
}

/** Copy a stored snapshot, or an honest backfill, onto shadows that do not have one yet. */
export function attachMissingFeatures(records: readonly ShadowTrade[], alerts: readonly StoredAlert[]): ShadowTrade[] {
  const byId = new Map<string, StoredAlert>();
  for (let i = 0; i < alerts.length; i++) byId.set(alerts[i].id, alerts[i]);
  return records.map((row) => {
    if (row.features || isExperimentShadow(row)) return row;
    const alert = byId.get(row.alertId);
    if (!alert) return row;
    return { ...row, features: alert.features ?? backfillFeatures(alert) };
  });
}

export function addMissingShadows(book: ShadowBook, alerts: readonly StoredAlert[]): { book: ShadowBook; opened: number } {
  const ids = new Set<string>();
  for (let i = 0; i < book.records.length; i++) ids.add(book.records[i].alertId);
  const added: ShadowTrade[] = [];
  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    if (ids.has(alert.id)) continue;
    const row = shadowFromAlert(alert);
    if (!row) continue;
    ids.add(alert.id);
    added.push(row);
  }
  if (added.length === 0) return { book, opened: 0 };
  return {
    book: { version: 1, records: trimShadows(book.records.concat(added)), research: book.research },
    opened: added.length,
  };
}

export function markFromQuote(quote: ShadowQuote | null): { price: number; source: ShadowQuoteSource } | null {
  if (!quote) return null;
  if (quote.mid != null && Number.isFinite(quote.mid) && quote.mid > 0) {
    return { price: quote.mid, source: "mid" };
  }
  if (quote.bid != null && Number.isFinite(quote.bid) && quote.bid > 0) {
    return { price: quote.bid, source: "bid" };
  }
  return null;
}

/**
 * Append one quote to a closed shadow's stored path.
 * The live exit, P/L, rules version, and scorecard fields stay as they were.
 * This does not invent the quotes that were missed after the exit.
 */
export function appendShadowPathMark(row: ShadowTrade, quote: ShadowQuote | null, now: Date): ShadowTrade {
  if (row.status !== "closed") return row;
  const marked = markFromQuote(quote);
  if (!marked) return row;
  const marks = appendMark(row.marks, { at: now.getTime(), price: marked.price });
  if (marks.length === (row.marks ?? []).length) return row;
  return { ...row, marks };
}

/**
 * Apply one fresh quote, then the current exit rules for a single contract.
 * Half of one contract is the whole trade, so the profit target closes it.
 * The stop price comes from planExits, which already caps the planned loss at $875.
 * The recorded P/L uses the quote, which can be past that stop because this is a snapshot.
 * A closed shadow is left unchanged. Continued path marks use appendShadowPathMark.
 */
export function applyShadowQuote(row: ShadowTrade, quote: ShadowQuote | null, now: Date): ShadowTrade {
  if (row.status === "closed") return row;
  const marked = markFromQuote(quote);
  let next: ShadowTrade = marked
    ? {
      ...row,
      lastMark: marked.price,
      lastMarkSource: marked.source,
      lastMarkedAt: now.getTime(),
      marks: appendMark(row.marks, { at: now.getTime(), price: marked.price }),
    }
    : row;
  if (marked) next = trackMark(next, marked.price);
  const decision = decideExit(next, marked, now);
  if (!decision) return next;
  return closeShadow(next, decision, now);
}

function appendMark(marks: ShadowMark[] | undefined, mark: ShadowMark): ShadowMark[] {
  const list = (marks ?? []).filter((item) => Number.isFinite(item.at) && item.price > 0);
  const last = list[list.length - 1];
  if (last && last.at === mark.at && last.price === mark.price) return list;
  list.push(mark);
  return list.slice(-SHADOW_MARK_CAP);
}

function trackMark(row: ShadowTrade, price: number): ShadowTrade {
  if (!(price > 0) || !Number.isFinite(price)) return row;
  return {
    ...row,
    maxFavorablePrice: row.maxFavorablePrice == null ? price : Math.max(row.maxFavorablePrice, price),
    maxAdversePrice: row.maxAdversePrice == null ? price : Math.min(row.maxAdversePrice, price),
    marksSeen: row.marksSeen + 1,
  };
}

export function contractKey(row: Pick<ShadowTrade, "ticker" | "expiration" | "strike" | "putCall">): string {
  return `${row.ticker}|${row.expiration}|${row.strike}|${row.putCall}`;
}

/**
 * Open shadows to quote this run. Extra contracts past the cap wait for a later run.
 * A/B shadows are quoted first, including a saved A or B in Earnings in window.
 * DTE tests and paper Earnings in window rows share the leftover slots, and at most
 * EXPERIMENT_DTE.quotesPerRun of them together, so the run stays inside the existing quote cap.
 */
export function shadowsToQuote(
  rows: readonly ShadowTrade[],
  limit: number = SHADOW_QUOTES_PER_RUN,
  experimentLimit: number = EXPERIMENT_DTE.quotesPerRun,
): ShadowTrade[] {
  const open = rows.filter((row) => row.status === "open").slice().sort(byMarkAge);
  const primary = open.filter((row) => !isExperimentShadow(row));
  const tests = open.filter((row) => isExperimentShadow(row));
  const seen = new Set<string>();
  const out: ShadowTrade[] = [];
  takeQuotes(primary, out, seen, limit);
  const testRoom = Math.min(Math.max(0, experimentLimit), Math.max(0, limit - seen.size));
  takeQuotes(tests, out, seen, seen.size + testRoom);
  return out;
}

function takeQuotes(rows: readonly ShadowTrade[], out: ShadowTrade[], seen: Set<string>, uniqueCap: number): void {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = contractKey(row);
    if (seen.has(key)) {
      out.push(row);
      continue;
    }
    if (seen.size >= uniqueCap) continue;
    seen.add(key);
    out.push(row);
  }
}

export function mergeShadowBooks(latest: ShadowBook, edited: ShadowBook): ShadowBook {
  const byId = new Map<string, ShadowTrade>();
  for (let i = 0; i < latest.records.length; i++) byId.set(latest.records[i].id, latest.records[i]);
  for (let i = 0; i < edited.records.length; i++) {
    const row = edited.records[i];
    const prior = byId.get(row.id);
    if (prior && prior.status === "closed") {
      byId.set(row.id, keepClosedExit(prior, row));
      continue;
    }
    byId.set(row.id, row);
  }
  return {
    version: 1,
    records: trimShadows(Array.from(byId.values())),
    research: mergeResearchTracks(latest.research ?? [], edited.research ?? []),
  };
}

/** A closed shadow keeps the exit already saved. A longer stored path may be added. */
function keepClosedExit(prior: ShadowTrade, edited: ShadowTrade): ShadowTrade {
  const marks = extendedPath(prior.marks, edited.marks);
  if (!marks) return prior;
  return { ...prior, marks };
}

function extendedPath(prior: ShadowMark[] | undefined, edited: ShadowMark[] | undefined): ShadowMark[] | null {
  const base = prior ?? [];
  const next = edited ?? [];
  if (next.length <= base.length) return null;
  for (let i = 0; i < base.length; i++) {
    if (base[i].at !== next[i].at || base[i].price !== next[i].price) return null;
  }
  return next;
}

export function summarizeShadows(
  records: readonly ShadowTrade[],
  paperAlertIds: ReadonlySet<string>,
  now: Date,
): ShadowScorecard {
  const byGrade = [emptyBucket("A"), emptyBucket("B")];
  const byRight = [emptyBucket("call"), emptyBucket("put")];
  const byTicker: Array<ShadowBucket & { winDollars: number; lossDollars: number }> = [];
  const overall = emptyBucket("all");
  const testOverall = emptyBucket("test");
  const shortOverall = emptyBucket("test-short");
  const earningsOverall = emptyBucket("test-earnings");
  let open = 0;
  let excludedPaper = 0;
  let unpriced = 0;
  let testOpen = 0;
  let shortOpen = 0;
  let earningsOpen = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const section = experimentSectionKind(row);
    if (section) {
      const paper = paperAlertIds.has(row.alertId);
      if (row.status === "open") {
        if (!paper) {
          if (section === "short") shortOpen += 1;
          else if (section === "earnings") earningsOpen += 1;
          else testOpen += 1;
        }
        continue;
      }
      if (paper) continue;
      if (row.pnlDollars == null || row.exitPrice == null) continue;
      const bucket = section === "short" ? shortOverall : section === "earnings" ? earningsOverall : testOverall;
      addBucket([bucket], bucket.key, row.pnlDollars, resultOf(row.pnlDollars));
      continue;
    }
    const paper = paperAlertIds.has(row.alertId);
    if (paper) excludedPaper += 1;
    if (row.status === "open") {
      if (!paper) open += 1;
      continue;
    }
    if (paper) continue;
    if (row.pnlDollars == null || row.exitPrice == null) {
      unpriced += 1;
      continue;
    }
    const result = resultOf(row.pnlDollars);
    addBucket(byGrade, row.grade, row.pnlDollars, result);
    addBucket(byRight, row.putCall, row.pnlDollars, result);
    addBucket(byTicker, row.ticker, row.pnlDollars, result);
    addBucket([overall], "all", row.pnlDollars, result);
  }

  byTicker.sort((a, b) => a.key.localeCompare(b.key));
  const resolved = overall.closed;
  return {
    estimateNote: SHADOW_ESTIMATE_NOTE,
    sampleNote: shadowSampleNote(resolved),
    resolved,
    open,
    excludedPaper,
    unpriced,
    tooFew: resolved < SHADOW_MIN_TRUST,
    wins: overall.wins,
    losses: overall.losses,
    flats: overall.flats,
    winRate: overall.winRate,
    averageWin: overall.averageWin,
    averageLoss: overall.averageLoss,
    totalPnl: overall.pnlDollars,
    byGrade: byGrade.map(publishBucket),
    byTicker: byTicker.map(publishBucket),
    byRight: byRight.map(publishBucket),
    rows: recentRows(records, paperAlertIds, now),
    experimental: experimentSection(
      EXPERIMENT_DTE.label,
      EXPERIMENT_SECTION_NOTE,
      experimentTrustNote(testOverall.closed),
      testOverall,
      testOpen,
      EXPERIMENT_DTE.minTrust,
      experimentRows(records, paperAlertIds, now, "long"),
    ),
    experimentalShort: experimentSection(
      EXPERIMENT_SHORT_DTE.label,
      EXPERIMENT_SHORT_SECTION_NOTE,
      experimentShortTrustNote(shortOverall.closed),
      shortOverall,
      shortOpen,
      EXPERIMENT_SHORT_DTE.minTrust,
      experimentRows(records, paperAlertIds, now, "short"),
    ),
    experimentalEarnings: experimentSection(
      EARNINGS_WINDOW.label,
      EARNINGS_SECTION_NOTE,
      earningsWindowTrustNote(earningsOverall.closed),
      earningsOverall,
      earningsOpen,
      EARNINGS_WINDOW.minTrust,
      experimentRows(records, paperAlertIds, now, "earnings"),
    ),
  };
}

function experimentSection(
  label: string,
  note: string,
  trustNote: string,
  bucket: ShadowBucket & { winDollars: number; lossDollars: number },
  open: number,
  minTrust: number,
  rows: ShadowListItem[],
): ExperimentSection {
  return {
    label,
    note,
    trustNote,
    resolved: bucket.closed,
    open,
    tooFew: bucket.closed < minTrust,
    wins: bucket.wins,
    losses: bucket.losses,
    flats: bucket.flats,
    winRate: bucket.winRate,
    averageWin: bucket.averageWin,
    averageLoss: bucket.averageLoss,
    totalPnl: bucket.pnlDollars,
    rows,
  };
}

export function shadowsToCsv(
  records: readonly ShadowTrade[],
  paperAlertIds: ReadonlySet<string>,
  openingLabels?: ReadonlyMap<string, string>,
): string {
  const header = [
    "id", "ticker", "putCall", "grade", "cohort", "experiment", "probeGrade", "strike", "expiration", "openedAt", "entryPrice",
    "status", "closedAt", "exitReason", "exitPrice", "exitQuote", "exitStale",
    "pnlDollars", "pnlPercent", "tradingDaysHeld", "marksSeen", "opening", "counted",
  ];
  const lines = [header.join(",")];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const counted = row.status === "closed" && row.pnlDollars != null && !paperAlertIds.has(row.alertId) && !excludedFromMainTotals(row);
    lines.push([
      row.id,
      row.ticker,
      row.putCall,
      row.grade,
      csvCohort(row),
      row.experimentLabel ?? "",
      row.probeGrade ?? "",
      String(row.strike),
      row.expiration,
      new Date(row.openedAt).toISOString(),
      String(row.entryPrice),
      row.status,
      row.closedAt == null ? "" : new Date(row.closedAt).toISOString(),
      row.exitReason ?? "",
      row.exitPrice == null ? "" : String(row.exitPrice),
      row.exitQuote ?? "",
      row.exitStale ? "yes" : "no",
      row.pnlDollars == null ? "" : row.pnlDollars.toFixed(2),
      row.pnlFraction == null ? "" : (row.pnlFraction * 100).toFixed(2),
      row.tradingDaysHeld == null ? "" : String(row.tradingDaysHeld),
      String(row.marksSeen),
      openingLabels?.get(row.id) ?? "",
      counted ? "yes" : "no",
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

export function parseShadowBook(text: string | null | undefined): ShadowBook {
  if (!text) return emptyShadowBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyShadowBook();
  }
  const row = parsed && typeof parsed === "object" ? parsed as { records?: unknown; research?: unknown } : null;
  if (!row || !Array.isArray(row.records)) return emptyShadowBook();
  const records: ShadowTrade[] = [];
  for (let i = 0; i < row.records.length; i++) {
    const trade = parseShadow(row.records[i]);
    if (trade) records.push(trade);
  }
  const research = parseResearchTracks(row.research);
  return {
    version: 1,
    records: trimShadows(records),
    research: research.length > 0 ? research : undefined,
  };
}

interface ExitDecision {
  reason: ShadowExitReason;
  price: number | null;
  source: ShadowQuoteSource | null;
  stale: boolean;
}

function decideExit(
  row: ShadowTrade,
  marked: { price: number; source: ShadowQuoteSource } | null,
  now: Date,
): ExitDecision | null {
  const plan = planExits({ premium: row.entryPrice, contracts: 1, structure: "single" });
  if (!plan) return null;
  const dte = calendarDaysBetween(newYorkDate(now), row.expiration);
  if (marked) {
    if (marked.price <= plan.stopPrice + PRICE_EPS) {
      return { reason: "stop", price: marked.price, source: marked.source, stale: false };
    }
    if (marked.price + PRICE_EPS >= plan.profitPrice) {
      return { reason: "profit", price: marked.price, source: marked.source, stale: false };
    }
  }
  if (isShortExperimentShadow(row)) {
    const due = chicagoCloseBeforeExpirationMs(row.expiration);
    if (due != null && now.getTime() >= due) {
      if (marked) return { reason: "expiration", price: marked.price, source: marked.source, stale: false };
      if (row.lastMark != null && row.lastMark > 0 && row.lastMarkSource) {
        return { reason: "expiration", price: row.lastMark, source: row.lastMarkSource, stale: true };
      }
      return { reason: "expiration", price: null, source: null, stale: false };
    }
  } else if (dte != null && dte <= LAST_WEEK_CALENDAR_DAYS) {
    if (marked) return { reason: "expiration", price: marked.price, source: marked.source, stale: false };
    if (dte < 0 && row.lastMark != null && row.lastMark > 0 && row.lastMarkSource) {
      return { reason: "expiration", price: row.lastMark, source: row.lastMarkSource, stale: true };
    }
    if (dte < 0) return { reason: "expiration", price: null, source: null, stale: false };
    return null;
  }
  if (!marked) return null;
  const pnl = (marked.price - row.entryPrice) * row.contracts * 100;
  const flat = Math.abs(pnl) < TRADE_RULES.flatAbsDollars
    && chicagoTradingDaysElapsed(new Date(row.openedAt), now) >= TRADE_RULES.flatAfterTradingDays;
  if (!flat) return null;
  return { reason: "flat", price: marked.price, source: marked.source, stale: false };
}

function closeShadow(row: ShadowTrade, decision: ExitDecision, now: Date): ShadowTrade {
  const exitPrice = decision.price;
  const pnlDollars = exitPrice == null ? null : (exitPrice - row.entryPrice) * row.contracts * 100;
  const pnlFraction = exitPrice == null || !(row.entryPrice > 0)
    ? null
    : (exitPrice - row.entryPrice) / row.entryPrice;
  return {
    ...row,
    status: "closed",
    closedAt: now.getTime(),
    exitPrice,
    exitReason: decision.reason,
    exitQuote: decision.source,
    exitStale: decision.stale,
    pnlDollars,
    pnlFraction,
    tradingDaysHeld: chicagoTradingDaysElapsed(new Date(row.openedAt), now),
  };
}

function recentRows(records: readonly ShadowTrade[], paperAlertIds: ReadonlySet<string>, now: Date): ShadowListItem[] {
  const main = records.filter((row) => !excludedFromMainTotals(row));
  const open = main.filter((row) => row.status === "open").slice().sort((a, b) => b.openedAt - a.openedAt);
  const closed = main.filter((row) => row.status === "closed").slice().sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const picked = open.concat(closed).slice(0, RECENT_LIMIT);
  return picked.map((row) => toListItem(row, paperAlertIds, now));
}

function experimentRows(
  records: readonly ShadowTrade[],
  paperAlertIds: ReadonlySet<string>,
  now: Date,
  section: "long" | "short" | "earnings",
): ShadowListItem[] {
  const tests = records.filter((row) => experimentSectionKind(row) === section);
  const open = tests.filter((row) => row.status === "open").slice().sort((a, b) => b.openedAt - a.openedAt);
  const closed = tests.filter((row) => row.status === "closed").slice().sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  return open.concat(closed).slice(0, RECENT_LIMIT).map((row) => toListItem(row, paperAlertIds, now));
}

function toListItem(row: ShadowTrade, paperAlertIds: ReadonlySet<string>, now: Date): ShadowListItem {
  const paper = paperAlertIds.has(row.alertId);
  const priced = row.status === "closed" && row.pnlDollars != null;
  const counted = priced && !paper;
  const mark = row.status === "open" ? row.lastMark : null;
  const unrealized = mark != null ? (mark - row.entryPrice) * row.contracts * 100 : null;
  let countNote: string | null = null;
  if (paper) countNote = "Already a paper trade, so it is left out of these totals.";
  else if (row.status === "closed" && row.pnlDollars == null) countNote = "Closed with no quote, so it is left out of the win rate.";
  return {
    id: row.id,
    ticker: row.ticker,
    putCall: row.putCall,
    grade: row.grade,
    cohort: listedCohort(row),
    experimentLabel: row.experimentLabel,
    probeNote: probeNote(row),
    strike: row.strike,
    expiration: row.expiration,
    status: row.status,
    exitReason: row.exitReason,
    exitLabel: shadowExitLabel(row.exitReason, row.cohort),
    exitPrice: row.exitPrice,
    exitQuote: row.exitQuote,
    exitStale: row.exitStale,
    pnlDollars: row.pnlDollars,
    pnlFraction: row.pnlFraction,
    tradingDaysHeld: row.status === "closed"
      ? row.tradingDaysHeld
      : chicagoTradingDaysElapsed(new Date(row.openedAt), now),
    entryPrice: row.entryPrice,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    mark,
    unrealizedPnl: unrealized,
    counted,
    countNote,
  };
}

function listedCohort(row: Pick<ShadowTrade, "cohort" | "grade">): ShadowCohort {
  if (row.cohort === "experiment-earnings") return "experiment-earnings";
  if (row.cohort === "experiment-short") return "experiment-short";
  if (isExperimentShadow(row)) return "experiment";
  return "ab";
}

function experimentSectionKind(row: Pick<ShadowTrade, "cohort" | "grade">): "long" | "short" | "earnings" | null {
  if (row.cohort === "experiment-earnings") return "earnings";
  if (row.cohort === "experiment-short") return "short";
  if (row.cohort === "experiment" || row.grade === "test") return "long";
  return null;
}

function csvCohort(row: Pick<ShadowTrade, "cohort" | "grade">): ShadowCohort {
  return listedCohort(row);
}

function probeNote(row: ShadowTrade): string | null {
  if (row.cohort === "experiment-earnings") {
    if (row.grade === "A" || row.grade === "B") {
      return `Saved as ${row.grade}. Earnings fall inside the hold, so this row is left out of the totals above.`;
    }
    if (row.probeGrade === "A" || row.probeGrade === "B") {
      return `The other rules would say ${row.probeGrade}. The earnings downgrade kept it out of A and B. This is not sent.`;
    }
    return "Earnings fall inside the hold. This is not sent.";
  }
  if (!isExperimentShadow(row)) return null;
  if (row.probeGrade === "A" || row.probeGrade === "B") {
    return `The other rules would say ${row.probeGrade}. This is not an A or a B.`;
  }
  return "This is a test shadow, not an A or a B.";
}

function resultOf(pnlDollars: number): "win" | "loss" | "flat" {
  if (Math.abs(pnlDollars) < TRADE_RULES.flatAbsDollars) return "flat";
  return pnlDollars > 0 ? "win" : "loss";
}

function byMarkAge(a: ShadowTrade, b: ShadowTrade): number {
  return (a.lastMarkedAt ?? 0) - (b.lastMarkedAt ?? 0);
}

function emptyBucket(key: string): ShadowBucket & { winDollars: number; lossDollars: number } {
  return {
    key,
    closed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    winRate: null,
    averageWin: null,
    averageLoss: null,
    pnlDollars: 0,
    winDollars: 0,
    lossDollars: 0,
  };
}

function publishBucket(bucket: ShadowBucket & { winDollars: number; lossDollars: number }): ShadowBucket {
  return {
    key: bucket.key,
    closed: bucket.closed,
    wins: bucket.wins,
    losses: bucket.losses,
    flats: bucket.flats,
    winRate: bucket.winRate,
    averageWin: bucket.averageWin,
    averageLoss: bucket.averageLoss,
    pnlDollars: bucket.pnlDollars,
  };
}

function addBucket(
  buckets: Array<ShadowBucket & { winDollars: number; lossDollars: number }>,
  key: string,
  pnl: number,
  result: "win" | "loss" | "flat",
): void {
  let bucket: (ShadowBucket & { winDollars: number; lossDollars: number }) | null = null;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].key === key) {
      bucket = buckets[i];
      break;
    }
  }
  if (!bucket) {
    bucket = emptyBucket(key);
    buckets.push(bucket);
  }
  bucket.closed += 1;
  bucket.pnlDollars += pnl;
  if (result === "win") {
    bucket.wins += 1;
    bucket.winDollars += pnl;
  } else if (result === "loss") {
    bucket.losses += 1;
    bucket.lossDollars += Math.abs(pnl);
  } else {
    bucket.flats += 1;
  }
  const decided = bucket.wins + bucket.losses;
  bucket.winRate = decided > 0 ? bucket.wins / decided : null;
  bucket.averageWin = bucket.wins > 0 ? bucket.winDollars / bucket.wins : null;
  bucket.averageLoss = bucket.losses > 0 ? bucket.lossDollars / bucket.losses : null;
}

function trimShadows(records: ShadowTrade[]): ShadowTrade[] {
  const max = OUTCOME_RULES.maxStoredAlerts;
  if (records.length <= max) return records;
  const drop = new Set<string>();
  let extra = records.length - max;
  const closed = records.filter((row) => row.status === "closed").slice().sort((a, b) => a.openedAt - b.openedAt);
  for (let i = 0; i < closed.length && extra > 0; i++) {
    drop.add(closed[i].id);
    extra -= 1;
  }
  if (extra > 0) {
    const open = records.filter((row) => row.status === "open").slice().sort((a, b) => a.openedAt - b.openedAt);
    for (let i = 0; i < open.length && extra > 0; i++) {
      drop.add(open[i].id);
      extra -= 1;
    }
  }
  return records.filter((row) => !drop.has(row.id));
}

function parseMarks(value: unknown): ShadowMark[] {
  if (!Array.isArray(value)) return [];
  const marks: ShadowMark[] = [];
  for (let i = 0; i < value.length && marks.length < SHADOW_MARK_CAP; i++) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    const item = row as { at?: unknown; price?: unknown };
    if (typeof item.at !== "number" || !Number.isFinite(item.at)) continue;
    if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price <= 0) continue;
    marks.push({ at: item.at, price: item.price });
  }
  return marks.slice(-SHADOW_MARK_CAP);
}

function parseShadow(value: unknown): ShadowTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!ID_PATTERN.test(id)) return null;
  const alertId = typeof row.alertId === "string" ? row.alertId.trim() : "";
  if (!ID_PATTERN.test(alertId)) return null;
  const openedAt = asTime(row.openedAt);
  if (openedAt == null) return null;
  const ticker = typeof row.ticker === "string" ? row.ticker.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) return null;
  const putCall = row.putCall === "put" ? "put" : row.putCall === "call" ? "call" : null;
  if (!putCall) return null;
  const strike = asPositive(row.strike);
  if (strike == null) return null;
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  if (!DATE_PATTERN.test(expiration)) return null;
  const grade: ShadowGrade | null = row.grade === "A" || row.grade === "B" || row.grade === "test" ? row.grade : null;
  if (!grade) return null;
  const cohort: ShadowCohort = row.cohort === "experiment-earnings"
    ? "experiment-earnings"
    : row.cohort === "experiment-short"
      ? "experiment-short"
      : row.cohort === "experiment" || grade === "test"
        ? "experiment"
        : "ab";
  if (cohort === "experiment-earnings" && grade !== "test" && grade !== "A" && grade !== "B") return null;
  if ((cohort === "experiment" || cohort === "experiment-short") && grade !== "test") return null;
  if (cohort === "ab" && grade === "test") return null;
  const probeGrade = row.probeGrade === "A" || row.probeGrade === "B" ? row.probeGrade : null;
  if (row.contracts !== 1) return null;
  const entryPrice = asPositive(row.entryPrice);
  if (entryPrice == null) return null;
  const status = row.status === "closed" ? "closed" : row.status === "open" ? "open" : null;
  if (!status) return null;
  const closedAt = row.closedAt == null ? null : asTime(row.closedAt);
  if (row.closedAt != null && closedAt == null) return null;
  const exitPrice = row.exitPrice == null ? null : asPositive(row.exitPrice);
  const exitReason = REASONS.indexOf(row.exitReason as ShadowExitReason) >= 0
    ? row.exitReason as ShadowExitReason
    : null;
  if (status === "open" && (closedAt != null || exitPrice != null || exitReason != null)) return null;
  if (status === "closed" && (closedAt == null || exitReason == null || closedAt < openedAt)) return null;
  const exitQuote = row.exitQuote === "mid" || row.exitQuote === "bid" ? row.exitQuote : null;
  const lastMarkSource = row.lastMarkSource === "mid" || row.lastMarkSource === "bid" ? row.lastMarkSource : null;
  const pnlDollars = row.pnlDollars == null ? null : asFinite(row.pnlDollars);
  const pnlFraction = row.pnlFraction == null ? null : asFinite(row.pnlFraction);
  const tradingDaysHeld = row.tradingDaysHeld == null ? null : asWhole(row.tradingDaysHeld);
  const trade: ShadowTrade = {
    id,
    alertId,
    openedAt,
    ticker,
    putCall,
    strike,
    expiration,
    grade,
    cohort,
    experimentLabel: experimentLabelOf(row.experimentLabel, cohort),
    probeGrade: cohort === "ab" ? null : probeGrade,
    features: parseFeatureSnapshot(row.features),
    rulesVersion: parseRulesVersion(row.rulesVersion),
    marks: parseMarks(row.marks),
    maxFavorablePrice: row.maxFavorablePrice == null ? null : asPositive(row.maxFavorablePrice),
    maxAdversePrice: row.maxAdversePrice == null ? null : asPositive(row.maxAdversePrice),
    marksSeen: row.marksSeen == null ? 0 : asWhole(row.marksSeen) ?? 0,
    contracts: 1,
    entryPrice,
    entryPriceSource: "ask",
    status,
    closedAt,
    exitPrice,
    exitReason,
    exitQuote,
    exitStale: row.exitStale === true,
    pnlDollars,
    pnlFraction,
    tradingDaysHeld,
    lastMark: row.lastMark == null ? null : asPositive(row.lastMark),
    lastMarkSource,
    lastMarkedAt: row.lastMarkedAt == null ? null : asTime(row.lastMarkedAt),
  };
  if (row.quoteTrack === true) {
    trade.quoteTrack = true;
    trade.entryUnderlying = row.entryUnderlying == null ? null : asPositive(row.entryUnderlying);
    trade.spyTrend = parseSpyTrend(row.spyTrend);
    if (row.spyTrendSource === "backfill") trade.spyTrendSource = "backfill";
  }
  return trade;
}

function experimentLabelOf(value: unknown, cohort: ShadowCohort): string | null {
  if (cohort !== "experiment" && cohort !== "experiment-short" && cohort !== "experiment-earnings") return null;
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  if (cohort === "experiment-earnings") return EARNINGS_WINDOW.label;
  return cohort === "experiment-short" ? EXPERIMENT_SHORT_DTE.label : EXPERIMENT_DTE.label;
}

function asTime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1_500_000_000_000 || value > 2_200_000_000_000) return null;
  return value;
}

function asPositive(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000) return null;
  return value;
}

function asFinite(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asWhole(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) return null;
  return value;
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}
