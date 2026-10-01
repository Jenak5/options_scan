import { OUTCOME_RULES, type LetterGrade } from "@/app/lib/alertConfig";
import { chicagoClock, chicagoDate } from "@/app/lib/marketHours";
import type { EstimatedSideLabel, FlowRow } from "@/app/lib/flow";
import type { AlertVerdict, VerdictName } from "@/app/lib/verdict";

/**
 * Saved alerts and the later midpoint check.
 * A win, miss, or flat label compares option mids. It is not trade profit or loss.
 */

export type CheckpointName = "m15" | "h1" | "close";
export type CheckpointStatus = "pending" | "quoted" | "no_quote" | "expired" | "missed";
export type OutcomeGrade = "pending" | "win" | "miss" | "flat" | "unscored";

export interface CheckpointQuote {
  at: number | null;
  mid: number | null;
  underlying: number | null;
  /** Fraction. 0.20 means the option mid is up 20% versus the alert mid. */
  midChangePct: number | null;
  status: CheckpointStatus;
}

export interface StoredAlert {
  id: string;
  contractKey: string;
  sentAt: number;
  tradingDay: string;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  bid: number;
  ask: number;
  mid: number | null;
  underlyingPrice: number | null;
  volume: number;
  openInterest: number;
  flowScore: number;
  liquidityPasses: boolean;
  side: EstimatedSideLabel;
  verdict: VerdictName;
  verdictLabel: string;
  grade: LetterGrade;
  reasons: string[];
  note: string;
  levelsNote: string | null;
  maxContracts: number | null;
  checkpoints: Record<CheckpointName, CheckpointQuote>;
  outcome: OutcomeGrade;
}

export interface DailyLoss {
  tradingDay: string;
  consecutiveLosses: number;
}

export interface AlertBook {
  version: 1;
  records: StoredAlert[];
  dailyLoss: DailyLoss | null;
}

export interface QuoteObservation {
  mid: number | null;
  underlying: number | null;
}

const CHECKPOINTS: CheckpointName[] = ["m15", "h1", "close"];
const SIDES: EstimatedSideLabel[] = ["estimated at ask", "estimated at bid", "estimated mid", "estimated unknown"];
const VERDICTS: VerdictName[] = ["TAKE", "WATCH", "SKIP", "STOP"];
const GRADES: LetterGrade[] = ["A", "B", "C", "D"];
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export function emptyBook(): AlertBook {
  return { version: 1, records: [], dailyLoss: null };
}

export function emptyCheckpoint(): CheckpointQuote {
  return { at: null, mid: null, underlying: null, midChangePct: null, status: "pending" };
}

export function midChangePct(alertMid: number | null, nextMid: number | null): number | null {
  if (alertMid == null || nextMid == null) return null;
  if (!(alertMid > 0) || !Number.isFinite(nextMid)) return null;
  return (nextMid - alertMid) / alertMid;
}

/**
 * Win if any checkpoint mid is up by the win threshold.
 * Miss if the close mid is down by the miss threshold and nothing earlier won.
 * Flat when the close is quoted and neither of those happened.
 * Unscored when the close never got a mid and nothing won.
 */
export function gradeOutcome(alert: StoredAlert): OutcomeGrade {
  const pcts = CHECKPOINTS
    .map((name) => alert.checkpoints[name].midChangePct)
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (pcts.some((value) => reaches(value, OUTCOME_RULES.winMidChange))) return "win";
  const close = alert.checkpoints.close;
  if (close.status === "pending") return "pending";
  if (close.status !== "quoted" || close.midChangePct == null) return "unscored";
  if (reachesDown(close.midChangePct, OUTCOME_RULES.missMidChange)) return "miss";
  return "flat";
}

/** Keeps an exact 20% from falling through because 2 × 1.2 is not a clean binary fraction. */
const OUTCOME_EPSILON = 1e-8;

function reaches(value: number, threshold: number): boolean {
  return value + OUTCOME_EPSILON >= threshold;
}

function reachesDown(value: number, threshold: number): boolean {
  return value - OUTCOME_EPSILON <= threshold;
}

export function buildStoredAlert(row: FlowRow, verdict: AlertVerdict, now: Date): StoredAlert {
  const sentAt = now.getTime();
  return {
    id: `${sentAt}-${row.id}`,
    contractKey: row.id,
    sentAt,
    tradingDay: chicagoDate(now),
    ticker: row.ticker,
    putCall: row.putCall,
    strike: row.strike,
    expiration: row.expiration,
    bid: row.bid,
    ask: row.ask,
    mid: row.mid,
    underlyingPrice: row.underlyingPrice,
    volume: row.volume,
    openInterest: row.openInterest,
    flowScore: row.score,
    liquidityPasses: row.liquidityPasses,
    side: row.side,
    verdict: verdict.verdict,
    verdictLabel: verdict.verdictLabel,
    grade: verdict.grade,
    reasons: verdict.reasons.slice(0, 4),
    note: verdict.note,
    levelsNote: verdict.levelsNote,
    maxContracts: verdict.maxContracts,
    checkpoints: {
      m15: emptyCheckpoint(),
      h1: emptyCheckpoint(),
      close: emptyCheckpoint(),
    },
    outcome: "pending",
  };
}

export function addRecord(book: AlertBook, record: StoredAlert, max: number = OUTCOME_RULES.maxStoredAlerts): AlertBook {
  return {
    ...book,
    records: book.records.concat(record).slice(-Math.max(1, max)),
  };
}

export function alreadySentToday(book: AlertBook, contractKey: string, tradingDay: string): boolean {
  for (let i = 0; i < book.records.length; i++) {
    const row = book.records[i];
    if (row.contractKey === contractKey && row.tradingDay === tradingDay) return true;
  }
  return false;
}

export function lossCountForDay(book: AlertBook, tradingDay: string): number | null {
  const row = book.dailyLoss;
  if (!row || row.tradingDay !== tradingDay) return null;
  if (!Number.isInteger(row.consecutiveLosses) || row.consecutiveLosses < 0) return null;
  return row.consecutiveLosses;
}

export function withDailyLoss(book: AlertBook, tradingDay: string, consecutiveLosses: number): AlertBook {
  if (!tradingDay || !Number.isInteger(consecutiveLosses) || consecutiveLosses < 0) return book;
  return { ...book, dailyLoss: { tradingDay, consecutiveLosses } };
}

export function dueCheckpointNames(alert: StoredAlert, now: Date): CheckpointName[] {
  const due: CheckpointName[] = [];
  const age = now.getTime() - alert.sentAt;
  if (alert.checkpoints.m15.status === "pending" && age >= OUTCOME_RULES.checkpoint15MinMs) due.push("m15");
  if (alert.checkpoints.h1.status === "pending" && age >= OUTCOME_RULES.checkpoint1HourMs) due.push("h1");
  if (alert.checkpoints.close.status === "pending" && closeIsDue(alert, now)) due.push("close");
  return due;
}

export type FollowUpStep = "none" | "missed" | "expired" | "quote";

export function planFollowUp(alert: StoredAlert, now: Date): FollowUpStep {
  if (!hasPending(alert)) return "none";
  const today = chicagoDate(now);
  if (!today) return "none";
  if (today > alert.tradingDay) return "missed";
  if (alert.expiration < today) return "expired";
  return dueCheckpointNames(alert, now).length > 0 ? "quote" : "none";
}

/**
 * Apply one follow-up observation.
 * "missed" closes out a prior session without a quote.
 * "expired" marks the contract gone.
 * A quote with no positive mid is stored as no quote.
 */
export function advanceAlert(
  alert: StoredAlert,
  now: Date,
  quote: QuoteObservation | "missed" | "expired",
): StoredAlert {
  const step = planFollowUp(alert, now);
  if (step === "none") return refreshOutcome(alert);
  if (step === "missed" || quote === "missed") return refreshOutcome(fillPending(alert, now, "missed"));
  if (step === "expired" || quote === "expired") return refreshOutcome(fillPending(alert, now, "expired"));
  const due = dueCheckpointNames(alert, now);
  if (due.length === 0) return refreshOutcome(alert);
  const quoted = quote.mid != null && Number.isFinite(quote.mid) && quote.mid > 0;
  let next = alert;
  for (let i = 0; i < due.length; i++) {
    next = fillOne(next, due[i], {
      at: now.getTime(),
      mid: quoted ? quote.mid : null,
      underlying: numberOrNull(quote.underlying),
      midChangePct: quoted ? midChangePct(alert.mid, quote.mid) : null,
      status: quoted ? "quoted" : "no_quote",
    });
  }
  return refreshOutcome(next);
}

export function applyFollowUps(
  book: AlertBook,
  now: Date,
  quotes: ReadonlyMap<string, QuoteObservation | "error">,
): { book: AlertBook; updated: number } {
  let updated = 0;
  const records = book.records.map((record) => {
    const step = planFollowUp(record, now);
    if (step === "none") return record;
    if (step === "missed") {
      updated += 1;
      return advanceAlert(record, now, "missed");
    }
    if (step === "expired") {
      updated += 1;
      return advanceAlert(record, now, "expired");
    }
    const quote = quotes.get(record.contractKey);
    if (!quote || quote === "error") return record;
    const next = advanceAlert(record, now, quote);
    if (next !== record) updated += 1;
    return next;
  });
  return { book: { ...book, records }, updated };
}

export interface SliceBreakdown {
  label: string;
  count: number;
  graded: number;
  wins: number;
  hitRate: number | null;
  avgHourPct: number | null;
  avgClosePct: number | null;
}

export interface VerdictBreakdown {
  verdict: VerdictName;
  count: number;
  graded: number;
  wins: number;
  hitRate: number | null;
  avgClosePct: number | null;
}

export interface AlertSummary {
  total: number;
  graded: number;
  wins: number;
  misses: number;
  flats: number;
  hitRate: number | null;
  avgHourPct: number | null;
  avgClosePct: number | null;
  byTicker: SliceBreakdown[];
  byLiquidity: SliceBreakdown[];
  byVerdict: VerdictBreakdown[];
}

export function summarizeAlerts(records: StoredAlert[]): AlertSummary {
  const gradedRows = records.filter((row) => isGraded(gradeOutcome(row)));
  const wins = gradedRows.filter((row) => gradeOutcome(row) === "win").length;
  const misses = gradedRows.filter((row) => gradeOutcome(row) === "miss").length;
  const flats = gradedRows.filter((row) => gradeOutcome(row) === "flat").length;
  return {
    total: records.length,
    graded: gradedRows.length,
    wins,
    misses,
    flats,
    hitRate: gradedRows.length > 0 ? wins / gradedRows.length : null,
    avgHourPct: averagePct(records, "h1"),
    avgClosePct: averagePct(records, "close"),
    byTicker: groupSlices(records, (row) => row.ticker),
    byLiquidity: groupSlices(records, (row) => row.liquidityPasses ? "Passed Gate liquidity" : "Did not pass Gate liquidity"),
    byVerdict: VERDICTS.map((verdict) => verdictSlice(records, verdict)),
  };
}

export function parseAlertBook(text: string | null | undefined): AlertBook {
  if (!text) return emptyBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyBook();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyBook();
  const row = parsed as { records?: unknown; dailyLoss?: unknown };
  const records: StoredAlert[] = [];
  if (Array.isArray(row.records)) {
    for (let i = 0; i < row.records.length; i++) {
      const alert = parseAlert(row.records[i]);
      if (alert) records.push(alert);
    }
  }
  return {
    version: 1,
    records: records.slice(-OUTCOME_RULES.maxStoredAlerts),
    dailyLoss: parseDailyLoss(row.dailyLoss),
  };
}

function closeIsDue(alert: StoredAlert, now: Date): boolean {
  const clock = chicagoClock(now);
  if (!clock || clock.date !== alert.tradingDay) return false;
  return clock.minutes >= OUTCOME_RULES.closeCheckpointMinutes;
}

function hasPending(alert: StoredAlert): boolean {
  return CHECKPOINTS.some((name) => alert.checkpoints[name].status === "pending");
}

function fillPending(alert: StoredAlert, now: Date, status: "missed" | "expired"): StoredAlert {
  let next = alert;
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const name = CHECKPOINTS[i];
    if (next.checkpoints[name].status !== "pending") continue;
    next = fillOne(next, name, {
      at: now.getTime(),
      mid: null,
      underlying: null,
      midChangePct: null,
      status,
    });
  }
  return next;
}

function fillOne(alert: StoredAlert, name: CheckpointName, quote: CheckpointQuote): StoredAlert {
  return {
    ...alert,
    checkpoints: { ...alert.checkpoints, [name]: quote },
  };
}

function refreshOutcome(alert: StoredAlert): StoredAlert {
  const outcome = gradeOutcome(alert);
  if (outcome === alert.outcome) return alert;
  return { ...alert, outcome };
}

function isGraded(outcome: OutcomeGrade): boolean {
  return outcome === "win" || outcome === "miss" || outcome === "flat";
}

function averagePct(records: StoredAlert[], name: CheckpointName): number | null {
  const values: number[] = [];
  for (let i = 0; i < records.length; i++) {
    const value = records[i].checkpoints[name].midChangePct;
    if (value != null && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

function groupSlices(records: StoredAlert[], labelOf: (row: StoredAlert) => string): SliceBreakdown[] {
  const labels: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const label = labelOf(records[i]);
    if (labels.indexOf(label) === -1) labels.push(label);
  }
  const slices = labels.map((label) => {
    const rows = records.filter((row) => labelOf(row) === label);
    const graded = rows.filter((row) => isGraded(gradeOutcome(row)));
    const wins = graded.filter((row) => gradeOutcome(row) === "win").length;
    return {
      label,
      count: rows.length,
      graded: graded.length,
      wins,
      hitRate: graded.length > 0 ? wins / graded.length : null,
      avgHourPct: averagePct(rows, "h1"),
      avgClosePct: averagePct(rows, "close"),
    };
  });
  slices.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return slices;
}

function verdictSlice(records: StoredAlert[], verdict: VerdictName): VerdictBreakdown {
  const rows = records.filter((row) => row.verdict === verdict);
  const graded = rows.filter((row) => isGraded(gradeOutcome(row)));
  const wins = graded.filter((row) => gradeOutcome(row) === "win").length;
  return {
    verdict,
    count: rows.length,
    graded: graded.length,
    wins,
    hitRate: graded.length > 0 ? wins / graded.length : null,
    avgClosePct: averagePct(rows, "close"),
  };
}

function numberOrNull(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

function parseDailyLoss(value: unknown): DailyLoss | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { tradingDay?: unknown; consecutiveLosses?: unknown };
  if (typeof row.tradingDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.tradingDay)) return null;
  if (!Number.isInteger(row.consecutiveLosses) || (row.consecutiveLosses as number) < 0) return null;
  return { tradingDay: row.tradingDay, consecutiveLosses: row.consecutiveLosses as number };
}

function parseAlert(value: unknown): StoredAlert | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<StoredAlert>;
  if (typeof row.id !== "string" || row.id.length === 0 || row.id.length > 160) return null;
  if (typeof row.contractKey !== "string" || row.contractKey.length === 0 || row.contractKey.length > 120) return null;
  if (typeof row.sentAt !== "number" || !Number.isFinite(row.sentAt)) return null;
  if (typeof row.tradingDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.tradingDay)) return null;
  if (typeof row.ticker !== "string" || !TICKER_PATTERN.test(row.ticker)) return null;
  if (row.putCall !== "call" && row.putCall !== "put") return null;
  if (typeof row.strike !== "number" || !(row.strike > 0)) return null;
  if (typeof row.expiration !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiration)) return null;
  if (!isFiniteNumber(row.bid) || !isFiniteNumber(row.ask)) return null;
  if (typeof row.side !== "string" || SIDES.indexOf(row.side) === -1) return null;
  if (typeof row.verdict !== "string" || VERDICTS.indexOf(row.verdict) === -1) return null;
  if (typeof row.grade !== "string" || GRADES.indexOf(row.grade) === -1) return null;
  const checkpoints = parseCheckpoints(row.checkpoints);
  if (!checkpoints) return null;
  const reasons = Array.isArray(row.reasons)
    ? row.reasons.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 400).slice(0, 4)
    : [];
  const alert: StoredAlert = {
    id: row.id,
    contractKey: row.contractKey,
    sentAt: row.sentAt,
    tradingDay: row.tradingDay,
    ticker: row.ticker,
    putCall: row.putCall,
    strike: row.strike,
    expiration: row.expiration,
    bid: row.bid as number,
    ask: row.ask as number,
    mid: optionalNumber(row.mid),
    underlyingPrice: optionalNumber(row.underlyingPrice),
    volume: isFiniteNumber(row.volume) ? row.volume as number : 0,
    openInterest: isFiniteNumber(row.openInterest) ? row.openInterest as number : 0,
    flowScore: isFiniteNumber(row.flowScore) ? row.flowScore as number : 0,
    liquidityPasses: row.liquidityPasses === true,
    side: row.side,
    verdict: row.verdict,
    verdictLabel: typeof row.verdictLabel === "string" && row.verdictLabel.length > 0
      ? row.verdictLabel.slice(0, 40)
      : row.verdict,
    grade: row.grade,
    reasons,
    note: typeof row.note === "string" ? row.note.slice(0, 240) : "",
    levelsNote: typeof row.levelsNote === "string" ? row.levelsNote.slice(0, 240) : null,
    maxContracts: optionalCount(row.maxContracts),
    checkpoints,
    outcome: "pending",
  };
  alert.outcome = gradeOutcome(alert);
  return alert;
}

function parseCheckpoints(value: unknown): Record<CheckpointName, CheckpointQuote> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<Record<CheckpointName, unknown>>;
  const m15 = parseCheckpoint(row.m15);
  const h1 = parseCheckpoint(row.h1);
  const close = parseCheckpoint(row.close);
  if (!m15 || !h1 || !close) return null;
  return { m15, h1, close };
}

function parseCheckpoint(value: unknown): CheckpointQuote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyCheckpoint();
  const row = value as Partial<CheckpointQuote>;
  const status = checkpointStatus(row.status);
  return {
    at: optionalNumber(row.at),
    mid: optionalNumber(row.mid),
    underlying: optionalNumber(row.underlying),
    midChangePct: optionalNumber(row.midChangePct),
    status,
  };
}

function checkpointStatus(value: unknown): CheckpointStatus {
  if (value === "quoted" || value === "no_quote" || value === "expired" || value === "missed" || value === "pending") {
    return value;
  }
  return "pending";
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function optionalCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) return null;
  return value;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
