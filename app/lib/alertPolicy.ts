import { ALERT_POLICY, formatFlowPremium, isAlertGrade } from "@/app/lib/alertConfig";
import { notionalPremium, type FlowRow } from "@/app/lib/flow";
import { gradeFlowRow, type AlertVerdict } from "@/app/lib/verdict";

/**
 * Which scored rows become a Telegram alert and an alert-book row.
 * A and B only, TAKE only, A before B, with a daily cap.
 * One alert per flow. The flow is the contract plus the trade id, or the contract
 * plus the Chicago day when the quote has no trade id. The same trade is not sent
 * again when the grade rises or the day's premium grows. A later trade on that
 * contract can still be sent until the daily cap.
 */

/**
 * Last-trade times inside this window are one trade.
 * Tastytrade and Schwab often stamp the same print a few seconds apart.
 */
export const FLOW_TRADE_BUCKET_MS = 60_000;

/** Flow premium must at least double and grow by this many dollars to re-alert. */
export const REALERT_PREMIUM_MULTIPLE = 2;
export const REALERT_PREMIUM_INCREASE = 100_000;

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
  strike?: number;
  grade?: string;
  sentAt?: number;
  volume?: number;
  mid?: number | null;
  alertedPremium?: number | null;
  features?: { flowPremium?: number | null } | null;
  /** Stored on alerts saved after flow keys. Older rows are the contract for that Chicago day. */
  flowKey?: string | null;
}

export interface AlertedContract {
  grade: string;
  premium: number | null;
  sentAt: number;
}

/** Same ticker, same direction, same expiration. Strike is not part of this key. */
export function alertSetupKey(row: { ticker: string; putCall: string; expiration: string }): string {
  return `${row.ticker.trim().toUpperCase()}|${row.putCall}|${row.expiration}`;
}

/** One contract: ticker, strike, expiration, and call or put. 64 and 64.0 are the same strike. */
export function alertContractKey(row: { ticker: string; strike: number; expiration: string; putCall: string }): string {
  const ticker = row.ticker.trim().toUpperCase();
  const strike = Number(row.strike);
  const strikeText = Number.isFinite(strike) ? formatStrike(strike) : String(row.strike).trim();
  return `${ticker}|${strikeText}|${row.expiration}|${row.putCall}`;
}

function formatStrike(strike: number): string {
  if (Number.isInteger(strike)) return String(strike);
  return String(strike);
}

export interface FlowAlertIdentity {
  ticker: string;
  strike: number;
  expiration: string;
  putCall: string;
  tradeId?: string | null;
  tradeTime?: number | null;
}

/**
 * Contract plus trade id. Without a trade id, the last-trade time rounded to a minute.
 * Without either, the contract plus the Chicago day, so the next 5-minute scan is the same flow.
 */
export function flowAlertKeyFromRow(row: FlowAlertIdentity, tradingDay: string): string {
  const contract = alertContractKey(row);
  const tradeId = cleanTradeId(row.tradeId);
  if (tradeId) return `${contract}|id:${tradeId}`;
  const bucket = tradeBucket(row.tradeTime);
  if (bucket != null) return `${contract}|t:${bucket}`;
  return `${contract}|day:${tradingDay}`;
}

/** Key written on the alert, or the day window for a row saved before flow keys existed. */
export function storedFlowKey(alert: SentAlertIdentity): string {
  if (typeof alert.flowKey === "string" && alert.flowKey.length > 0) return alert.flowKey;
  if (typeof alert.strike !== "number" || !(alert.strike > 0)) {
    return `${alert.ticker.trim().toUpperCase()}|day:${alert.tradingDay}`;
  }
  return flowAlertKeyFromRow({
    ticker: alert.ticker,
    strike: alert.strike,
    expiration: alert.expiration,
    putCall: alert.putCall,
  }, alert.tradingDay);
}

/**
 * True when both keys are the same flow.
 * A day-window key matches any trade of that contract: a quote with no trade id
 * and a quote whose id changed between Tastytrade and Schwab are one flow.
 * Two different trade buckets are two flows.
 */
export function isSameFlowAlert(stored: string, next: string): boolean {
  if (stored === next) return true;
  const left = splitFlowKey(stored);
  const right = splitFlowKey(next);
  if (!left || !right || left.contract !== right.contract) return false;
  if (left.kind === "day" || right.kind === "day") {
    if (left.kind === "day" && right.kind === "day") return left.value === right.value;
    return true;
  }
  return left.kind === right.kind && left.value === right.value;
}

function cleanTradeId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 80) return null;
  if (!/^[A-Za-z0-9:._-]+$/.test(text)) return null;
  return text;
}

function tradeBucket(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return Math.floor(ms / FLOW_TRADE_BUCKET_MS);
}

function splitFlowKey(key: string): { contract: string; kind: "id" | "t" | "day"; value: string } | null {
  const marks = [
    { token: "|id:", kind: "id" as const },
    { token: "|t:", kind: "t" as const },
    { token: "|day:", kind: "day" as const },
  ];
  let at = -1;
  let kind: "id" | "t" | "day" = "day";
  let token = "";
  for (let i = 0; i < marks.length; i++) {
    const index = key.lastIndexOf(marks[i].token);
    if (index > at) {
      at = index;
      kind = marks[i].kind;
      token = marks[i].token;
    }
  }
  if (at <= 0 || !token) return null;
  const value = key.slice(at + token.length);
  if (!value) return null;
  return { contract: key.slice(0, at), kind, value };
}

/** Premium stored on the alert, then the feature snapshot, then volume × mid × 100. */
export function storedAlertPremium(alert: {
  alertedPremium?: number | null;
  volume?: number;
  mid?: number | null;
  features?: { flowPremium?: number | null } | null;
}): number | null {
  if (typeof alert.alertedPremium === "number" && Number.isFinite(alert.alertedPremium) && alert.alertedPremium >= 0) {
    return alert.alertedPremium;
  }
  const feature = alert.features?.flowPremium;
  if (typeof feature === "number" && Number.isFinite(feature) && feature >= 0) return feature;
  if (typeof alert.volume === "number") return notionalPremium(alert.volume, alert.mid ?? null);
  return null;
}

/**
 * Reasons to send the same contract again today.
 * Empty means the prior alert still stands.
 */
export function realertReasons(
  prior: { grade: string; premium: number | null },
  next: { grade: string; premium: number | null },
): string[] {
  const reasons: string[] = [];
  if (gradeRank(next.grade) > gradeRank(prior.grade)) {
    reasons.push(`Upgraded ${prior.grade}→${next.grade}`);
  }
  const before = prior.premium;
  const after = next.premium;
  if (
    before != null && after != null &&
    before > 0 && after > 0 &&
    after >= before * REALERT_PREMIUM_MULTIPLE &&
    after >= before + REALERT_PREMIUM_INCREASE
  ) {
    reasons.push(`Flow grew ${formatFlowPremium(before)}→${formatFlowPremium(after)}`);
  }
  return reasons;
}

function gradeRank(grade: string): number {
  if (grade === "A") return 3;
  if (grade === "B") return 2;
  if (grade === "C") return 1;
  if (grade === "D") return 0;
  return -1;
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
  byContract: Map<string, AlertedContract>;
  flowKeys: Set<string>;
} {
  const contracts = new Set<string>();
  const setups = new Set<string>();
  const byContract = new Map<string, AlertedContract>();
  const flowKeys = new Set<string>();
  let count = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.tradingDay !== tradingDay) continue;
    count += 1;
    contracts.add(row.contractKey);
    setups.add(alertSetupKey(row));
    flowKeys.add(storedFlowKey(row));
    if (typeof row.strike === "number" && typeof row.grade === "string" && row.grade.length > 0) {
      contracts.add(alertContractKey({
        ticker: row.ticker,
        strike: row.strike,
        expiration: row.expiration,
        putCall: row.putCall,
      }));
      rememberContract(byContract, alertContractKey({
        ticker: row.ticker,
        strike: row.strike,
        expiration: row.expiration,
        putCall: row.putCall,
      }), {
        grade: row.grade,
        premium: storedAlertPremium(row),
        sentAt: typeof row.sentAt === "number" ? row.sentAt : 0,
      });
    }
  }
  return { count, contracts, setups, byContract, flowKeys };
}

function rememberContract(map: Map<string, AlertedContract>, key: string, next: AlertedContract): void {
  const existing = map.get(key);
  if (existing && existing.sentAt > next.sentAt) return;
  map.set(key, next);
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
  sentByContract?: ReadonlyMap<string, AlertedContract>;
  /**
   * Flow keys already stored for this Chicago day.
   * When this set is passed, the same trade is not queued again.
   * Callers that omit it still use the older contract re-alert rule.
   */
  sentFlowKeys?: ReadonlySet<string>;
  tradingDay?: string;
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
  const contracts = new Set<string>();
  const seenFlows: string[] = [];
  const flowMode = input.sentFlowKeys != null;
  for (let i = 0; i < ranked.length && picked.length < input.limit; i++) {
    const item = ranked[i];
    const contractKey = alertContractKey(item.row);
    if (flowMode) {
      const nextKey = flowAlertKeyFromRow(item.row, input.tradingDay ?? "");
      if (matchesFlow(seenFlows, nextKey) || matchesFlow(input.sentFlowKeys, nextKey)) continue;
      seenFlows.push(nextKey);
      picked.push(item);
      continue;
    }
    if (contracts.has(contractKey)) continue;
    const prior = input.sentByContract?.get(contractKey) ?? null;
    if (prior) {
      const reasons = realertReasons(prior, { grade: item.verdict.grade, premium: item.row.notionalPremium });
      if (reasons.length === 0) continue;
    } else if (
      input.alreadySentContractKeys.has(item.row.id) ||
      input.alreadySentContractKeys.has(contractKey)
    ) {
      continue;
    }
    contracts.add(contractKey);
    picked.push(item);
  }
  return picked;
}

function matchesFlow(keys: ReadonlySet<string> | readonly string[] | undefined, nextKey: string): boolean {
  if (!keys) return false;
  if (keys instanceof Set) {
    let same = false;
    keys.forEach((key) => {
      if (isSameFlowAlert(key, nextKey)) same = true;
    });
    return same;
  }
  const list = keys as readonly string[];
  for (let i = 0; i < list.length; i++) {
    if (isSameFlowAlert(list[i], nextKey)) return true;
  }
  return false;
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
