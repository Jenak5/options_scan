import { ALERT_RULES, LEVEL_RULES } from "@/app/lib/alertConfig";
import type { StoredAlert } from "@/app/lib/alertBook";
import { assessEventRisk, EARNINGS_UNKNOWN_PHRASE, IV_CRUSH_SENTENCE, type EarningsFact } from "@/app/lib/eventRisk";
import {
  calendarDaysBetween,
  newYorkDate,
  notionalPremium,
  otmDistance,
  volumeOiRatio,
  type EstimatedSideLabel,
  type FlowRow,
} from "@/app/lib/flow";
import { checkBidAskSpread } from "@/app/lib/gate";
import type { StoredPriceLevels } from "@/app/lib/levels";

/**
 * Grading inputs saved with an alert.
 * A captured snapshot is what the chain said at send time.
 * A backfill only fills numbers that can be recomputed from the stored alert.
 * Volume jump, implied vol, and delta are not on older alerts, so they stay null.
 */

export type EarningsProximity = "inside" | "after" | "none" | "unknown";

export interface AlertFeatureSnapshot {
  version: 1;
  /** True when the chain values were saved with the alert. False when recovered later. */
  capturedAtAlert: boolean;
  flowPremium: number | null;
  volOiRatio: number | null;
  /** Null when no same-day prior scan was stored. Never guessed. */
  volumeJump: number | null;
  /**
   * 0–4 when every flow-signal input is known.
   * Null when the volume jump is missing, because the count would be a guess.
   */
  flowSignalCount: number | null;
  spreadFraction: number | null;
  /** Decimal, as Schwab sent it. 0.25 is 25%. Null when it was not stored. */
  iv: number | null;
  delta: number | null;
  otmFraction: number | null;
  /** How far in the money, as a fraction of the underlying. 0 when the strike is out of the money. */
  itmFraction: number | null;
  otm: boolean | null;
  dte: number | null;
  /** Fraction of the underlying to the level in the trade's direction. */
  rewardDistance: number | null;
  /** Fraction of the underlying the other way. */
  riskDistance: number | null;
  earnings: EarningsProximity;
  side: EstimatedSideLabel | null;
}

const SIDES: EstimatedSideLabel[] = ["estimated at ask", "estimated at bid", "estimated mid", "estimated unknown"];

export function emptyFeatures(): AlertFeatureSnapshot {
  return {
    version: 1,
    capturedAtAlert: false,
    flowPremium: null,
    volOiRatio: null,
    volumeJump: null,
    flowSignalCount: null,
    spreadFraction: null,
    iv: null,
    delta: null,
    otmFraction: null,
    itmFraction: null,
    otm: null,
    dte: null,
    rewardDistance: null,
    riskDistance: null,
    earnings: "unknown",
    side: null,
  };
}

/** Same four signals as the checklist. The jump has to be known or the count is withheld. */
export function flowSignalCount(input: {
  volOiRatio: number | null;
  notionalPremium: number | null;
  side: EstimatedSideLabel | null;
  volumeJump: number | null;
}): number | null {
  if (input.volumeJump == null || !Number.isFinite(input.volumeJump)) return null;
  let count = 0;
  if (input.volOiRatio != null && input.volOiRatio >= ALERT_RULES.strongVolOiRatio) count += 1;
  if (input.notionalPremium != null && input.notionalPremium >= ALERT_RULES.strongNotional) count += 1;
  if (input.side === "estimated at ask") count += 1;
  if (input.volumeJump >= ALERT_RULES.strongVolumeJump) count += 1;
  return count;
}

export function snapshotFromFlow(row: FlowRow, now: Date): AlertFeatureSnapshot {
  const distances = levelDistances(row.putCall, row.levels);
  const earnings = earningsFromFact(row.earnings ?? null, row.expiration, row.dte, now);
  const jump = finiteOrNull(row.volumeJump);
  return {
    version: 1,
    capturedAtAlert: true,
    flowPremium: finiteOrNull(row.notionalPremium),
    volOiRatio: finiteOrNull(row.volOiRatio),
    volumeJump: jump,
    flowSignalCount: flowSignalCount({
      volOiRatio: finiteOrNull(row.volOiRatio),
      notionalPremium: finiteOrNull(row.notionalPremium),
      side: row.side,
      volumeJump: jump,
    }),
    spreadFraction: fractionOrNull(row.spreadFraction),
    iv: ivOrNull(row.iv),
    delta: deltaOrNull(row.delta),
    otmFraction: fractionOrNull(row.otmFraction),
    itmFraction: itmFrom(row.putCall, row.strike, row.underlyingPrice, row.otm),
    otm: row.otm === true ? true : row.otm === false ? false : null,
    dte: dayCount(row.dte),
    rewardDistance: distances.reward,
    riskDistance: distances.risk,
    earnings,
    side: row.side,
  };
}

/**
 * Recover what the stored alert already contains.
 * Implied vol, delta, and the same-day volume jump are not on the alert, so they stay null.
 */
export function backfillFeatures(alert: StoredAlert): AlertFeatureSnapshot {
  const spread = checkBidAskSpread(alert.bid, alert.ask);
  const distance = otmDistance(alert.putCall, alert.strike, alert.underlyingPrice);
  const premium = notionalPremium(alert.volume, alert.mid);
  const ratio = volumeOiRatio(alert.volume, alert.openInterest);
  const dte = calendarDaysBetween(newYorkDate(new Date(alert.sentAt)), alert.expiration);
  const distances = storedLevelDistances(alert.putCall, alert.levels);
  return {
    version: 1,
    capturedAtAlert: false,
    flowPremium: premium,
    volOiRatio: ratio,
    volumeJump: null,
    flowSignalCount: null,
    spreadFraction: fractionOrNull(spread.fraction),
    iv: null,
    delta: null,
    otmFraction: fractionOrNull(distance.fraction),
    itmFraction: itmFrom(alert.putCall, alert.strike, alert.underlyingPrice, distance.otm),
    otm: distance.otm,
    dte: dayCount(dte),
    rewardDistance: distances.reward,
    riskDistance: distances.risk,
    earnings: earningsFromLine(alert.eventLine),
    side: alert.side,
  };
}

export function featuresForAlert(alert: StoredAlert): AlertFeatureSnapshot {
  if (alert.features?.capturedAtAlert) return alert.features;
  return backfillFeatures(alert);
}

/** Known phrases only. A line that does not match stays unknown. */
export function earningsFromLine(line: string | null | undefined): EarningsProximity {
  if (!line || !line.trim()) return "unknown";
  const text = line.toLowerCase();
  if (text.includes(EARNINGS_UNKNOWN_PHRASE)) return "unknown";
  if (line.includes(IV_CRUSH_SENTENCE) || text.includes("on or before this expiration")) return "inside";
  if (text.includes("no earnings date listed")) return "none";
  if (text.includes("next earnings")) return "after";
  return "unknown";
}

export function parseFeatureSnapshot(value: unknown): AlertFeatureSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<AlertFeatureSnapshot>;
  const side = SIDES.indexOf(row.side as EstimatedSideLabel) >= 0 ? row.side as EstimatedSideLabel : null;
  const earnings = earningsValue(row.earnings);
  const jump = finiteOrNull(row.volumeJump);
  const ratio = finiteOrNull(row.volOiRatio);
  const premium = finiteOrNull(row.flowPremium);
  return {
    version: 1,
    capturedAtAlert: row.capturedAtAlert === true,
    flowPremium: premium,
    volOiRatio: ratio,
    volumeJump: jump,
    flowSignalCount: countOrNull(row.flowSignalCount),
    spreadFraction: fractionOrNull(row.spreadFraction),
    iv: ivOrNull(row.iv),
    delta: deltaOrNull(row.delta),
    otmFraction: fractionOrNull(row.otmFraction),
    itmFraction: fractionOrNull(row.itmFraction),
    otm: row.otm === true ? true : row.otm === false ? false : null,
    dte: dayCount(row.dte),
    rewardDistance: fractionOrNull(row.rewardDistance),
    riskDistance: fractionOrNull(row.riskDistance),
    earnings,
    side,
  };
}

function earningsFromFact(
  earnings: EarningsFact | null,
  expiration: string,
  dte: number | null,
  now: Date,
): EarningsProximity {
  if (!earnings || earnings.status === "unknown") return "unknown";
  if (earnings.status === "none") return "none";
  const event = assessEventRisk({
    now,
    expiration,
    dte,
    earnings,
    definedRiskSpread: false,
  });
  return earningsFromLine(event.eventLine);
}

function levelDistances(
  putCall: "call" | "put",
  levels: FlowRow["levels"],
): { reward: number | null; risk: number | null } {
  if (!levels?.checked || !levels.support || !levels.resistance) return { reward: null, risk: null };
  const reward = putCall === "call" ? levels.resistance.distance : levels.support.distance;
  const risk = putCall === "call" ? levels.support.distance : levels.resistance.distance;
  return { reward: fractionOrNull(reward), risk: fractionOrNull(risk) };
}

function storedLevelDistances(
  putCall: "call" | "put",
  levels: StoredPriceLevels | null,
): { reward: number | null; risk: number | null } {
  if (!levels) return { reward: null, risk: null };
  const reward = putCall === "call" ? levels.resistanceDistance : levels.supportDistance;
  const risk = putCall === "call" ? levels.supportDistance : levels.resistanceDistance;
  return { reward: fractionOrNull(reward), risk: fractionOrNull(risk) };
}

function itmFrom(
  putCall: "call" | "put",
  strike: number,
  underlying: number | null,
  otm: boolean | null,
): number | null {
  if (otm == null || underlying == null || !(underlying > 0) || !Number.isFinite(strike)) return null;
  if (otm) return 0;
  return fractionOrNull(Math.abs(strike - underlying) / underlying);
}

function earningsValue(value: unknown): EarningsProximity {
  if (value === "inside" || value === "after" || value === "none" || value === "unknown") return value;
  return "unknown";
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < -1_000_000_000 || value > 1_000_000_000) return null;
  return value;
}

function fractionOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) return null;
  return value;
}

function ivOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 5) return null;
  return value;
}

function deltaOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) return null;
  return value;
}

function dayCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2000) return null;
  return value;
}

function countOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) return null;
  return value;
}

/** Room to the next level, using the same distances the checklist uses. */
export function levelBucket(reward: number | null, risk: number | null): string | null {
  if (reward == null) return null;
  if (reward <= LEVEL_RULES.pinnedFraction || reward < LEVEL_RULES.minRoomFraction) return "Tight to the next level";
  const ratio = risk != null && risk > 0 ? reward / risk : Number.POSITIVE_INFINITY;
  if (ratio < LEVEL_RULES.minRewardToRisk) return "Poor reward versus the other way";
  return "Room to the next level";
}
