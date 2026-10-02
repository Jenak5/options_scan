import { ALERT_POLICY, isAlertGrade } from "@/app/lib/alertConfig";
import type { FlowRow } from "@/app/lib/flow";
import { gradeFlowRow, type AlertVerdict } from "@/app/lib/verdict";

/**
 * Which scored rows become a Telegram alert and an alert-book row.
 * A and B only, TAKE only, A before B, with a daily cap and one alert
 * per ticker, call or put, and expiration.
 */

export interface AlertCandidate {
  row: FlowRow;
  verdict: AlertVerdict;
}

export interface SentAlertIdentity {
  tradingDay: string;
  contractKey: string;
  ticker: string;
  putCall: string;
  expiration: string;
}

/** Same ticker, same direction, same expiration. Strike is not part of the key. */
export function alertSetupKey(row: { ticker: string; putCall: string; expiration: string }): string {
  return `${row.ticker.trim().toUpperCase()}|${row.putCall}|${row.expiration}`;
}

export function gradeAlertCandidates(
  rows: FlowRow[],
  consecutiveLosses: number | null,
  now: Date,
): AlertCandidate[] {
  const graded: AlertCandidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    graded.push({ row: rows[i], verdict: gradeFlowRow(rows[i], consecutiveLosses, now) });
  }
  return graded;
}

export function indexSentAlerts(records: SentAlertIdentity[], tradingDay: string): {
  count: number;
  contracts: Set<string>;
  setups: Set<string>;
} {
  const contracts = new Set<string>();
  const setups = new Set<string>();
  let count = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.tradingDay !== tradingDay) continue;
    count += 1;
    contracts.add(row.contractKey);
    setups.add(alertSetupKey(row));
  }
  return { count, contracts, setups };
}

/**
 * Rank A ahead of B, then higher flow score.
 * Skip anything already sent, anything that is not a TAKE, and anything below B.
 * `limit` is how many to hand back for screening. The caller still stops at the daily cap.
 */
export function chooseAlerts(input: {
  candidates: AlertCandidate[];
  alreadySentContractKeys: ReadonlySet<string>;
  alreadySentSetupKeys: ReadonlySet<string>;
  limit: number;
}): AlertCandidate[] {
  if (input.limit <= 0) return [];
  const ranked = input.candidates.filter((item) => qualifies(item));
  ranked.sort((a, b) => {
    const byGrade = gradeOrder(a.verdict.grade) - gradeOrder(b.verdict.grade);
    if (byGrade !== 0) return byGrade;
    return b.row.score - a.row.score || a.row.id.localeCompare(b.row.id);
  });
  const picked: AlertCandidate[] = [];
  const setups = new Set<string>();
  const contracts = new Set<string>();
  for (let i = 0; i < ranked.length && picked.length < input.limit; i++) {
    const item = ranked[i];
    const setup = alertSetupKey(item.row);
    if (input.alreadySentContractKeys.has(item.row.id) || contracts.has(item.row.id)) continue;
    if (input.alreadySentSetupKeys.has(setup) || setups.has(setup)) continue;
    contracts.add(item.row.id);
    setups.add(setup);
    picked.push(item);
  }
  return picked;
}

export function screenQueueLimit(room: number): number {
  if (room <= 0) return 0;
  return room + ALERT_POLICY.screenBuffer;
}

function qualifies(item: AlertCandidate): boolean {
  if (item.verdict.verdict !== "TAKE") return false;
  if (!isAlertGrade(item.verdict.grade)) return false;
  if (!item.row.liquidityPasses || item.row.delayed) return false;
  return true;
}

function gradeOrder(grade: string): number {
  if (grade === "A") return 0;
  if (grade === "B") return 1;
  return 2;
}
