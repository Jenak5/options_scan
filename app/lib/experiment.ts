import { ALERT_RULES, EXPERIMENT_DTE } from "@/app/lib/alertConfig";
import { snapshotFromFlow } from "@/app/lib/alertFeatures";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import type { FlowRow } from "@/app/lib/flow";
import { chicagoDate } from "@/app/lib/marketHours";
import type { ShadowTrade } from "@/app/lib/shadow";
import { gradeFlowRow } from "@/app/lib/verdict";

/**
 * Test shadows for 43–60 days to expiration.
 * The contract is graded with the real checklist, then again with a stand-in
 * day count inside 14–42, only to ask whether the other rules would pass.
 * The stand-in is not saved as the grade, and the 14–42 rule is not changed.
 * Nothing here sends a Telegram alert or places an order.
 */

export interface ExperimentPick {
  row: FlowRow;
  /** Letter the other rules would assign inside the 14–42 day window. Not a grade. */
  probe: "A" | "B";
}

const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;

export function experimentWindow(dte: number | null): boolean {
  return dte != null && dte >= EXPERIMENT_DTE.min && dte <= EXPERIMENT_DTE.max;
}

/**
 * What the checklist would say if days to expiration were not the reason to stop.
 * Returns null when the contract is outside 43–60, or when another rule would also fail.
 */
export function experimentProbe(row: FlowRow, consecutiveLosses: number | null, now: Date): "A" | "B" | null {
  if (!experimentWindow(row.dte)) return null;
  if (!row.liquidityPasses || row.delayed) return null;
  if (!(row.ask > 0) || !Number.isFinite(row.ask)) return null;
  const standIn = Math.round((ALERT_RULES.alertDteMin + ALERT_RULES.alertDteMax) / 2);
  const probed = gradeFlowRow({ ...row, dte: standIn }, consecutiveLosses, now);
  if (probed.verdict !== "TAKE") return null;
  if (probed.grade !== "A" && probed.grade !== "B") return null;
  const real = gradeFlowRow(row, consecutiveLosses, now);
  if (real.grade === "A" || real.grade === "B") return null;
  return probed.grade;
}

export function chooseExperimental(input: {
  rows: readonly FlowRow[];
  consecutiveLosses: number | null;
  now: Date;
  existing: readonly ShadowTrade[];
  limit?: number;
}): ExperimentPick[] {
  const day = chicagoDate(input.now);
  let openedToday = 0;
  const keys = new Set<string>();
  for (let i = 0; i < input.existing.length; i++) {
    const row = input.existing[i];
    keys.add(contractKey(row));
    if (row.cohort === "experiment" && chicagoDate(new Date(row.openedAt)) === day) openedToday += 1;
  }
  const room = Math.max(0, EXPERIMENT_DTE.opensPerDay - openedToday);
  const cap = Math.min(input.limit ?? EXPERIMENT_DTE.opensPerRun, room);
  if (cap <= 0) return [];

  const ranked: ExperimentPick[] = [];
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    if (keys.has(contractKey(row))) continue;
    const probe = experimentProbe(row, input.consecutiveLosses, input.now);
    if (!probe) continue;
    ranked.push({ row, probe });
  }
  ranked.sort((a, b) => b.row.score - a.row.score || a.row.id.localeCompare(b.row.id));

  const picked: ExperimentPick[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ranked.length && picked.length < cap; i++) {
    const key = contractKey(ranked[i].row);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(ranked[i]);
  }
  return picked;
}

export function experimentalShadow(row: FlowRow, probe: "A" | "B", now: Date): ShadowTrade | null {
  if (!experimentWindow(row.dte)) return null;
  if (!(row.ask > 0) || !Number.isFinite(row.ask)) return null;
  const id = experimentShadowId(row, now);
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    alertId: id,
    openedAt: now.getTime(),
    ticker: row.ticker,
    putCall: row.putCall,
    strike: row.strike,
    expiration: row.expiration,
    grade: "test",
    cohort: "experiment",
    experimentLabel: EXPERIMENT_DTE.label,
    probeGrade: probe,
    contracts: 1,
    entryPrice: row.ask,
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
    features: snapshotFromFlow(row, now),
    rulesVersion: RULES_VERSION,
    marks: [],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
  };
}

export function experimentShadowId(row: Pick<FlowRow, "id">, now: Date): string {
  const day = chicagoDate(now).replace(/-/g, "");
  return `exp${day}-${row.id}`.slice(0, 180);
}

export function experimentTrustNote(resolved: number): string {
  if (resolved < EXPERIMENT_DTE.minTrust) {
    return `${resolved} resolved test shadows. Fewer than ${EXPERIMENT_DTE.minTrust} is too few to consider widening the 14–42 day window.`;
  }
  return `${resolved} resolved test shadows. That is enough to describe. It is not a reason by itself to change the 14–42 day rule.`;
}

export const EXPERIMENT_SECTION_NOTE =
  `${EXPERIMENT_DTE.label}. These are not A or B grades, they are not sent, and they are left out of the totals above. One contract at the ask, with the same exits: plus 40%, minus 25%, flat after 3 trading days, and out before the last week. The 14–42 day rule is unchanged. ${EXPERIMENT_DTE.minTrust} resolved results are the minimum before considering a wider window. Estimates from quotes, not fills.`;

function contractKey(row: { ticker: string; expiration: string; strike: number; putCall: string }): string {
  return `${row.ticker}|${row.expiration}|${row.strike}|${row.putCall}`;
}
