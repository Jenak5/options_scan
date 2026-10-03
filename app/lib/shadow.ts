import { OUTCOME_RULES, TRADE_RULES, type LetterGrade } from "@/app/lib/alertConfig";
import type { StoredAlert } from "@/app/lib/alertBook";
import { planExits } from "@/app/lib/exits";
import { calendarDaysBetween, newYorkDate, SHADOW_QUOTES_PER_RUN } from "@/app/lib/flow";
import { chicagoTradingDaysElapsed } from "@/app/lib/marketHours";

/**
 * Shadow outcome for an A or B alert.
 * One contract bought at the alert ask. No order is placed.
 * Quotes are the chain midpoint, or the bid when the midpoint is missing.
 * A 15-minute snapshot is not a fill.
 */

export const SHADOW_MIN_TRUST = 30;

/** Once this many calendar days remain, the shadow is closed. That is the last week. */
export const LAST_WEEK_CALENDAR_DAYS = 7;

export const SHADOW_ESTIMATE_NOTE =
  "These results are estimates from quotes (the midpoint, or the bid when the midpoint is missing), not fills. Open shadows are marked every 15 minutes, and the option chain is only a snapshot, so an exit can show up late.";

export type ShadowExitReason = "profit" | "stop" | "flat" | "expiration";
export type ShadowQuoteSource = "mid" | "bid";

export interface ShadowTrade {
  id: string;
  alertId: string;
  openedAt: number;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  grade: "A" | "B";
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
}

export interface ShadowBook {
  version: 1;
  records: ShadowTrade[];
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

export interface ShadowListItem {
  id: string;
  ticker: string;
  putCall: "call" | "put";
  grade: "A" | "B";
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

export function shadowSampleNote(resolved: number): string {
  if (resolved < SHADOW_MIN_TRUST) {
    return `${resolved} resolved alerts. Fewer than ${SHADOW_MIN_TRUST} is too few to trust.`;
  }
  return `${resolved} resolved alerts.`;
}

export function shadowExitLabel(reason: ShadowExitReason | null): string {
  if (reason === "profit") {
    return "Profit target. One contract, so half off closes the whole trade.";
  }
  if (reason === "stop") return "Stop.";
  if (reason === "flat") return "Flat after 3 trading days.";
  if (reason === "expiration") return "Out before the last week to expiration.";
  return "";
}

export function shadowFromAlert(alert: StoredAlert): ShadowTrade | null {
  if (alert.grade !== "A" && alert.grade !== "B") return null;
  if (!Number.isFinite(alert.ask) || !(alert.ask > 0)) return null;
  if (!alert.id || !ID_PATTERN.test(alert.id)) return null;
  return {
    id: alert.id,
    alertId: alert.id,
    openedAt: alert.sentAt,
    ticker: alert.ticker,
    putCall: alert.putCall,
    strike: alert.strike,
    expiration: alert.expiration,
    grade: alert.grade,
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
    book: { version: 1, records: trimShadows(book.records.concat(added)) },
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
 * Apply one fresh quote, then the current exit rules for a single contract.
 * Half of one contract is the whole trade, so the profit target closes it.
 * The stop price comes from planExits, which already caps the planned loss at $875.
 * The recorded P/L uses the quote, which can be past that stop because this is a snapshot.
 */
export function applyShadowQuote(row: ShadowTrade, quote: ShadowQuote | null, now: Date): ShadowTrade {
  if (row.status === "closed") return row;
  const marked = markFromQuote(quote);
  const next: ShadowTrade = marked
    ? { ...row, lastMark: marked.price, lastMarkSource: marked.source, lastMarkedAt: now.getTime() }
    : row;
  const decision = decideExit(next, marked, now);
  if (!decision) return next;
  return closeShadow(next, decision, now);
}

export function contractKey(row: Pick<ShadowTrade, "ticker" | "expiration" | "strike" | "putCall">): string {
  return `${row.ticker}|${row.expiration}|${row.strike}|${row.putCall}`;
}

/** Open shadows to quote this run. Extra contracts past the cap wait for a later run. */
export function shadowsToQuote(rows: readonly ShadowTrade[], limit: number = SHADOW_QUOTES_PER_RUN): ShadowTrade[] {
  const open = rows.filter((row) => row.status === "open").slice().sort(byMarkAge);
  const seen = new Set<string>();
  const out: ShadowTrade[] = [];
  for (let i = 0; i < open.length; i++) {
    const row = open[i];
    const key = contractKey(row);
    if (seen.has(key)) {
      out.push(row);
      continue;
    }
    if (seen.size >= limit) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function mergeShadowBooks(latest: ShadowBook, edited: ShadowBook): ShadowBook {
  const byId = new Map<string, ShadowTrade>();
  for (let i = 0; i < latest.records.length; i++) byId.set(latest.records[i].id, latest.records[i]);
  for (let i = 0; i < edited.records.length; i++) {
    const row = edited.records[i];
    const prior = byId.get(row.id);
    if (prior && prior.status === "closed") continue;
    byId.set(row.id, row);
  }
  return { version: 1, records: trimShadows(Array.from(byId.values())) };
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
  let open = 0;
  let excludedPaper = 0;
  let unpriced = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
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
  };
}

export function shadowsToCsv(records: readonly ShadowTrade[], paperAlertIds: ReadonlySet<string>): string {
  const header = [
    "id", "ticker", "putCall", "grade", "strike", "expiration", "openedAt", "entryPrice",
    "status", "closedAt", "exitReason", "exitPrice", "exitQuote", "exitStale",
    "pnlDollars", "pnlPercent", "tradingDaysHeld", "counted",
  ];
  const lines = [header.join(",")];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const counted = row.status === "closed" && row.pnlDollars != null && !paperAlertIds.has(row.alertId);
    lines.push([
      row.id,
      row.ticker,
      row.putCall,
      row.grade,
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
  const row = parsed && typeof parsed === "object" ? parsed as { records?: unknown } : null;
  if (!row || !Array.isArray(row.records)) return emptyShadowBook();
  const records: ShadowTrade[] = [];
  for (let i = 0; i < row.records.length; i++) {
    const trade = parseShadow(row.records[i]);
    if (trade) records.push(trade);
  }
  return { version: 1, records: trimShadows(records) };
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
  if (dte != null && dte <= LAST_WEEK_CALENDAR_DAYS) {
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
  const open = records.filter((row) => row.status === "open").slice().sort((a, b) => b.openedAt - a.openedAt);
  const closed = records.filter((row) => row.status === "closed").slice().sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const picked = open.concat(closed).slice(0, RECENT_LIMIT);
  return picked.map((row) => toListItem(row, paperAlertIds, now));
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
    strike: row.strike,
    expiration: row.expiration,
    status: row.status,
    exitReason: row.exitReason,
    exitLabel: shadowExitLabel(row.exitReason),
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
  const grade: LetterGrade | null = row.grade === "A" || row.grade === "B" ? row.grade : null;
  if (!grade) return null;
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
  return {
    id,
    alertId,
    openedAt,
    ticker,
    putCall,
    strike,
    expiration,
    grade,
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
