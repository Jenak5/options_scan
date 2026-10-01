import { OUTCOME_RULES, SMALL_SAMPLE_NOTE } from "@/app/lib/alertConfig";
import {
  addRecord,
  alreadySentToday,
  applyFollowUps,
  buildStoredAlert,
  emptyBook,
  gradeOutcome,
  parseAlertBook,
  planFollowUp,
  summarizeAlerts,
  withDailyLoss,
  type AlertBook,
  type AlertSummary,
  type QuoteObservation,
  type StoredAlert,
} from "@/app/lib/alertBook";
import type { FlowRow } from "@/app/lib/flow";
import { chicagoDate } from "@/app/lib/marketHours";
import { readAlertBookText, readTradeLogText, updateAlertBook } from "@/app/lib/schwabStore";
import { dailyStopState, parseTradeLog, weeklyFlagSentence, weeklySummary } from "@/app/lib/trades";
import type { AlertVerdict } from "@/app/lib/verdict";

/**
 * Persists the alert book on the same private store as Schwab tokens.
 * No new environment variable. An unconfigured store leaves the book empty.
 */

export async function loadAlertBook(): Promise<AlertBook> {
  return parseAlertBook(await readAlertBookText());
}

/**
 * Consecutive losing closes from the trade log for this Chicago day.
 * A typed Gate count is not used. Zero when the log is empty or the store is down.
 */
export async function currentDailyLoss(now: Date): Promise<number> {
  return (await loadRiskStatus(now)).stop.consecutiveLosses;
}

export async function loadRiskStatus(now: Date): Promise<{
  stop: { tradingDay: string; consecutiveLosses: number; dailyStop: boolean };
  weeklyNote: string | null;
}> {
  const log = parseTradeLog(await readTradeLogText());
  const weekly = weeklySummary(log.trades, now);
  return { stop: dailyStopState(log.trades, now), weeklyNote: weeklyFlagSentence(weekly) };
}

export async function rememberDailyLoss(consecutiveLosses: number, now: Date): Promise<boolean> {
  const tradingDay = chicagoDate(now);
  if (!tradingDay) return false;
  return updateAlertBook((current) => {
    const book = withDailyLoss(parseAlertBook(current), tradingDay, consecutiveLosses);
    return JSON.stringify(book);
  });
}

export async function wasSentToday(contractKey: string, now: Date): Promise<boolean> {
  const book = await loadAlertBook();
  return alreadySentToday(book, contractKey, chicagoDate(now));
}

export async function rememberSentAlert(row: FlowRow, verdict: AlertVerdict, now: Date): Promise<boolean> {
  const record = buildStoredAlert(row, verdict, now);
  return updateAlertBook((current) => {
    const book = parseAlertBook(current);
    if (alreadySentToday(book, record.contractKey, record.tradingDay)) return JSON.stringify(book);
    return JSON.stringify(addRecord(book, record));
  });
}

export async function saveFollowUps(
  now: Date,
  quotes: ReadonlyMap<string, QuoteObservation | "error">,
): Promise<number> {
  const preview = applyFollowUps(await loadAlertBook(), now, quotes);
  if (preview.updated === 0) return 0;
  let updated = 0;
  const saved = await updateAlertBook((current) => {
    const result = applyFollowUps(parseAlertBook(current), now, quotes);
    updated = result.updated;
    return JSON.stringify(result.book);
  });
  return saved ? updated : 0;
}

export interface AlertReport {
  alerts: StoredAlert[];
  summary: AlertSummary;
  notes: {
    sample: string;
    outcome: string;
    checklist: string;
  };
}

export async function loadAlertReport(): Promise<AlertReport> {
  const book = await loadAlertBook();
  const alerts = book.records
    .map((record) => ({ ...record, outcome: gradeOutcome(record) }))
    .sort((a, b) => b.sentAt - a.sentAt);
  return {
    alerts,
    summary: summarizeAlerts(alerts),
    notes: {
      sample: SMALL_SAMPLE_NOTE,
      outcome: OUTCOME_RULES.note,
      checklist: "TAKE, WATCH, and SKIP were the checklist at alert time. Outcome labels are the later midpoint check. Neither one is trade profit or loss.",
    },
  };
}

export function contractsNeedingQuotes(book: AlertBook, now: Date): StoredAlert[] {
  const needed: StoredAlert[] = [];
  const seen = new Set<string>();
  const pending = book.records
    .filter((record) => planFollowUp(record, now) === "quote")
    .sort((a, b) => a.sentAt - b.sentAt);
  for (let i = 0; i < pending.length; i++) {
    const record = pending[i];
    if (seen.has(record.contractKey)) continue;
    if (seen.size >= OUTCOME_RULES.maxFollowUpQuotesPerRun) break;
    seen.add(record.contractKey);
    needed.push(record);
  }
  return needed;
}

export { emptyBook };
