import { ALERT_RULES, EXPERIMENT_DTE, EXPERIMENT_SHORT_DTE } from "@/app/lib/alertConfig";
import { snapshotFromFlow } from "@/app/lib/alertFeatures";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import type { FlowRow } from "@/app/lib/flow";
import { chicagoDate } from "@/app/lib/marketHours";
import type { ShadowCohort, ShadowTrade } from "@/app/lib/shadow";
import { gradeFlowRow } from "@/app/lib/verdict";

/**
 * Test shadows outside the 14–42 day window.
 * The contract is graded with the real checklist, then again with a stand-in
 * day count inside 14–42, only to ask whether the other rules would pass.
 * The stand-in is not saved as the grade, and the 14–42 rule is not changed.
 * Nothing here sends a Telegram alert or places an order.
 * 43–60 and 1–13 are separate cohorts. 0 DTE is not a cohort.
 */

export type ExperimentCohort = "experiment" | "experiment-short";

export interface ExperimentPick {
  row: FlowRow;
  /** Letter the other rules would assign inside the 14–42 day window. Not a grade. */
  probe: "A" | "B";
  cohort: ExperimentCohort;
}

const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;

const COHORT_CAPS = {
  experiment: EXPERIMENT_DTE,
  "experiment-short": EXPERIMENT_SHORT_DTE,
} as const;

/**
 * Which test cohort a day count belongs to.
 * Null for the 14–42 day A/B window, for 0 DTE, and for anything further out than 60.
 */
export function experimentWindow(dte: number | null): ExperimentCohort | null {
  if (dte == null || !Number.isFinite(dte)) return null;
  if (dte >= EXPERIMENT_SHORT_DTE.min && dte <= EXPERIMENT_SHORT_DTE.max) return "experiment-short";
  if (dte >= EXPERIMENT_DTE.min && dte <= EXPERIMENT_DTE.max) return "experiment";
  return null;
}

/**
 * What the checklist would say if days to expiration were not the reason to stop.
 * Returns null outside both test windows, or when another rule would also fail.
 * A short-dated earnings SKIP on the real contract still returns null.
 */
export function experimentProbe(row: FlowRow, consecutiveLosses: number | null, now: Date): "A" | "B" | null {
  const cohort = experimentWindow(row.dte);
  if (!cohort) return null;
  if (!row.liquidityPasses || row.delayed) return null;
  if (!(row.ask > 0) || !Number.isFinite(row.ask)) return null;
  const standIn = Math.round((ALERT_RULES.alertDteMin + ALERT_RULES.alertDteMax) / 2);
  const probed = gradeFlowRow({ ...row, dte: standIn }, consecutiveLosses, now);
  if (probed.verdict !== "TAKE") return null;
  if (probed.grade !== "A" && probed.grade !== "B") return null;
  const real = gradeFlowRow(row, consecutiveLosses, now);
  if (real.grade === "A" || real.grade === "B") return null;
  if (real.verdict === "SKIP") return null;
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
  const openedToday: Record<ExperimentCohort, number> = { experiment: 0, "experiment-short": 0 };
  const keys = new Set<string>();
  for (let i = 0; i < input.existing.length; i++) {
    const row = input.existing[i];
    keys.add(contractKey(row));
    if (chicagoDate(new Date(row.openedAt)) !== day) continue;
    if (row.cohort === "experiment" || row.cohort === "experiment-short") openedToday[row.cohort] += 1;
  }
  const caps: Record<ExperimentCohort, number> = {
    experiment: capFor("experiment", openedToday.experiment, input.limit),
    "experiment-short": capFor("experiment-short", openedToday["experiment-short"], input.limit),
  };
  if (caps.experiment <= 0 && caps["experiment-short"] <= 0) return [];

  const ranked: ExperimentPick[] = [];
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    if (keys.has(contractKey(row))) continue;
    const cohort = experimentWindow(row.dte);
    if (!cohort) continue;
    const probe = experimentProbe(row, input.consecutiveLosses, input.now);
    if (!probe) continue;
    ranked.push({ row, probe, cohort });
  }
  ranked.sort((a, b) => b.row.score - a.row.score || a.row.id.localeCompare(b.row.id));

  const picked: ExperimentPick[] = [];
  const seen = new Set<string>();
  const taken: Record<ExperimentCohort, number> = { experiment: 0, "experiment-short": 0 };
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    if (taken[item.cohort] >= caps[item.cohort]) continue;
    const key = contractKey(item.row);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
    taken[item.cohort] += 1;
  }
  return picked;
}

export function experimentalShadow(row: FlowRow, probe: "A" | "B", now: Date): ShadowTrade | null {
  const cohort = experimentWindow(row.dte);
  if (!cohort) return null;
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
    cohort,
    experimentLabel: cohortLabel(cohort),
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

export function cohortLabel(cohort: ExperimentCohort): string {
  return cohort === "experiment-short" ? EXPERIMENT_SHORT_DTE.label : EXPERIMENT_DTE.label;
}

export function experimentTrustNote(resolved: number): string {
  if (resolved < EXPERIMENT_DTE.minTrust) {
    return `${resolved} resolved test shadows. Fewer than ${EXPERIMENT_DTE.minTrust} is too few to consider widening the 14–42 day window.`;
  }
  return `${resolved} resolved test shadows. That is enough to describe. It is not a reason by itself to change the 14–42 day rule.`;
}

export function experimentShortTrustNote(resolved: number): string {
  if (resolved < EXPERIMENT_SHORT_DTE.minTrust) {
    return `${resolved} resolved test shadows. Fewer than ${EXPERIMENT_SHORT_DTE.minTrust} is too few to consider a shorter window.`;
  }
  return `${resolved} resolved test shadows. That is enough to describe. It is not a reason by itself to change the 14–42 day rule.`;
}

export const EXPERIMENT_SECTION_NOTE =
  `${EXPERIMENT_DTE.label}. These are not A or B grades, they are not sent, and they are left out of the totals above. One contract at the ask, with the same exits: plus 40%, minus 25%, flat after 3 trading days, and out before the last week. The 14–42 day rule is unchanged. ${EXPERIMENT_DTE.minTrust} resolved results are the minimum before considering a wider window. Estimates from quotes, not fills.`;

export const EXPERIMENT_SHORT_SECTION_NOTE =
  `${EXPERIMENT_SHORT_DTE.label}. These are not A or B grades, they are not sent, and they are left out of the totals above. One contract at the ask. Exits: plus 40%, minus 25%, and flat after 3 trading days. The last-week exit does not apply. The shadow closes at the 3:00 PM Central close on the trading day before expiration, or the same day when it was opened at 1 day to expiration. Weekends and full-day market holidays are not trading days. 0 DTE is not included. The 14–42 day rule is unchanged. ${EXPERIMENT_SHORT_DTE.minTrust} resolved results are the minimum before considering a shorter window. Estimates from quotes, not fills.`;

function capFor(cohort: ExperimentCohort, openedToday: number, limit: number | undefined): number {
  const spec = COHORT_CAPS[cohort];
  const room = Math.max(0, spec.opensPerDay - openedToday);
  return Math.min(limit ?? spec.opensPerRun, room);
}

function contractKey(row: { ticker: string; expiration: string; strike: number; putCall: string }): string {
  return `${row.ticker}|${row.expiration}|${row.strike}|${row.putCall}`;
}

export function isExperimentCohort(cohort: ShadowCohort | null | undefined): cohort is ExperimentCohort {
  return cohort === "experiment" || cohort === "experiment-short";
}
