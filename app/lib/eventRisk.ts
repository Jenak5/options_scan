import { EVENT_RULES, type LetterGrade, type MacroRelease } from "@/app/lib/alertConfig";
import { calendarDaysBetween, newYorkDate } from "@/app/lib/flow";

/**
 * Pure event-risk check. No network.
 * Earnings on or before expiration lowers the grade and names IV crush.
 * Earnings today or tomorrow on a short-dated single is a SKIP.
 * A macro release on or before expiration adds a caution and one downgrade.
 * An unknown earnings date is not treated as safe.
 */

export type EarningsStatus = "known" | "unknown" | "none";
export type EarningsTiming = "before-market" | "after-market" | "unspecified";

export interface EarningsFact {
  status: EarningsStatus;
  date: string | null;
  timing: EarningsTiming | null;
  estimated: boolean;
}

export const UNKNOWN_EARNINGS: EarningsFact = {
  status: "unknown",
  date: null,
  timing: null,
  estimated: false,
};

export const NO_EARNINGS_LISTED: EarningsFact = {
  status: "none",
  date: null,
  timing: null,
  estimated: false,
};

/** Exact phrase shown when the date cannot be read. */
export const EARNINGS_UNKNOWN_PHRASE = "earnings date unknown";

export const IV_CRUSH_SENTENCE =
  "Implied volatility typically drops after earnings (IV crush) even when direction is right.";

export const EARNINGS_SKIP_SENTENCE =
  "Earnings are today or tomorrow on a short-dated single, so this is a SKIP unless it is a defined-risk spread.";

export const MACRO_CAUTION =
  "High-impact macro day. A release can move the underlying even when direction is right.";

export interface EventAssessment {
  eventLine: string;
  /** Checklist sentence. Null when nothing about the grade changed. */
  reason: string | null;
  skipForEarnings: boolean;
  downgradeSteps: number;
  /** Letter the grade may not beat. Null when the earnings date is known or not listed. */
  capGrade: LetterGrade | null;
}

export function assessEventRisk(input: {
  now: Date;
  expiration: string;
  dte: number | null;
  earnings: EarningsFact | null;
  definedRiskSpread: boolean;
}): EventAssessment {
  const today = newYorkDate(input.now);
  const earnings = normalizeEarnings(input.earnings, today);
  const parts: string[] = [];
  let steps = 0;
  let cap: LetterGrade | null = null;
  let skip = false;
  let reason: string | null = null;

  if (earnings.status === "unknown") {
    parts.push(`${EARNINGS_UNKNOWN_PHRASE}. The grade stops at ${EVENT_RULES.maxGradeUntilEarnings}.`);
    cap = EVENT_RULES.maxGradeUntilEarnings;
    reason = `${EARNINGS_UNKNOWN_PHRASE}. The grade stops at ${EVENT_RULES.maxGradeUntilEarnings}.`;
  } else if (earnings.status === "none" || earnings.date == null) {
    parts.push("No earnings date listed for this ticker.");
  } else {
    parts.push(earningsSentence(earnings));
    const onOrBeforeExpiration = earnings.date <= input.expiration;
    if (onOrBeforeExpiration) {
      steps += EVENT_RULES.earningsDowngradeSteps;
      parts.push(`Earnings fall on or before this expiration. ${IV_CRUSH_SENTENCE}`);
      reason = IV_CRUSH_SENTENCE;
    }
    const daysUntil = calendarDaysBetween(today, earnings.date);
    const imminent = daysUntil != null && daysUntil >= 0 && daysUntil <= EVENT_RULES.imminentEarningsDays;
    const shortDated = input.dte != null && input.dte >= 0 && input.dte <= EVENT_RULES.shortDatedDteMax;
    if (imminent && shortDated && !input.definedRiskSpread) {
      skip = true;
      parts.push(EARNINGS_SKIP_SENTENCE);
      reason = EARNINGS_SKIP_SENTENCE;
    }
  }

  const macros = macroReleasesThrough(today, input.expiration);
  if (macros.length > 0) {
    steps += EVENT_RULES.macroDowngradeSteps;
    parts.push(`Macro: ${formatMacroList(macros)}. ${MACRO_CAUTION}`);
    if (reason == null) reason = MACRO_CAUTION;
  }

  return {
    eventLine: parts.join(" "),
    reason,
    skipForEarnings: skip,
    downgradeSteps: steps,
    capGrade: cap,
  };
}

export function macroReleasesThrough(today: string, expiration: string): MacroRelease[] {
  if (!isYmd(today) || !isYmd(expiration) || expiration < today) return [];
  const hit: MacroRelease[] = [];
  const dates = EVENT_RULES.macroDates;
  for (let i = 0; i < dates.length; i++) {
    const row = dates[i];
    if (row.date >= today && row.date <= expiration) hit.push(row);
  }
  return hit;
}

function normalizeEarnings(earnings: EarningsFact | null, today: string): EarningsFact {
  if (!earnings || earnings.status === "unknown") return UNKNOWN_EARNINGS;
  if (earnings.status === "none") return NO_EARNINGS_LISTED;
  if (!earnings.date || !isYmd(earnings.date) || earnings.date < today) return UNKNOWN_EARNINGS;
  return earnings;
}

function earningsSentence(earnings: EarningsFact): string {
  const estimate = earnings.estimated ? " (estimated)" : "";
  const session = earnings.timing === "before-market"
    ? " before the open"
    : earnings.timing === "after-market"
      ? " after the close"
      : "";
  return `Next earnings ${earnings.date}${estimate}${session}.`;
}

function formatMacroList(rows: MacroRelease[]): string {
  const parts: string[] = [];
  for (let i = 0; i < rows.length; i++) parts.push(`${rows[i].name} on ${rows[i].date}`);
  return parts.join("; ");
}

function isYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
