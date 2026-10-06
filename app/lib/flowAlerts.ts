import { isAlertGrade } from "@/app/lib/alertConfig";
import type { StoredAlert } from "@/app/lib/alertBook";
import {
  SIDE_NOTE,
  calendarDaysBetween,
  newYorkDate,
  notionalPremium,
  otmDistance,
  spreadQualityOf,
  volumeOiJump,
  volumeOiRatio,
  type FlowRow,
} from "@/app/lib/flow";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { openingLabel } from "@/app/lib/quoteSide";
import type { AlertVerdict } from "@/app/lib/verdict";

/**
 * Flow cards come from one live scan: near-the-money strikes, a premium
 * floor, a liquidity filter, and a score cap. A contract that already
 * alerted can miss the next scan. These helpers put today's saved A and B
 * alerts back on the list, with the grade from the alert book.
 */

export interface ScoredFlowRow extends FlowRow {
  verdict: AlertVerdict;
  /** Set when this contract was saved in today's alert book. */
  alertId: string | null;
  /** Next-day open-interest label when this card is a saved alert. */
  openingLabel?: string | null;
}

export function pinTodayAlerts(
  rows: readonly ScoredFlowRow[],
  alerts: readonly StoredAlert[],
  tradingDay: string,
  now: Date,
  tickerFilter: string,
): ScoredFlowRow[] {
  const wanted = indexTodayAlerts(alerts, tradingDay, tickerFilter);
  const seen = new Set<string>();
  const out: ScoredFlowRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const alert = wanted.get(row.id);
    if (!alert) {
      out.push(row.alertId ? row : { ...row, alertId: null, openingLabel: null });
      continue;
    }
    seen.add(row.id);
    out.push({
      ...row,
      verdict: verdictFromStoredAlert(alert),
      alertId: alert.id,
      openingLabel: openingLabelFor(alert),
    });
  }
  const missing: StoredAlert[] = [];
  wanted.forEach((alert, id) => {
    if (!seen.has(id)) missing.push(alert);
  });
  missing.sort((a, b) => b.sentAt - a.sentAt);
  for (let i = 0; i < missing.length; i++) out.push(flowCardFromAlert(missing[i], now));
  return out;
}

function indexTodayAlerts(
  alerts: readonly StoredAlert[],
  tradingDay: string,
  tickerFilter: string,
): Map<string, StoredAlert> {
  const ticker = tickerFilter.trim().toUpperCase();
  const byContract = new Map<string, StoredAlert>();
  if (!tradingDay) return byContract;
  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    if (alert.tradingDay !== tradingDay) continue;
    if (!isAlertGrade(alert.grade)) continue;
    if (ticker && alert.ticker !== ticker) continue;
    const id = alert.contractKey;
    if (!id) continue;
    const prior = byContract.get(id);
    if (!prior || alert.sentAt >= prior.sentAt) byContract.set(id, alert);
  }
  return byContract;
}

export function verdictFromStoredAlert(alert: StoredAlert): AlertVerdict {
  return {
    verdict: alert.verdict,
    verdictLabel: alert.verdictLabel,
    grade: alert.grade,
    uncappedGrade: alert.grade,
    reasons: alert.reasons.length > 0 ? alert.reasons.slice() : ["Saved when the alert was sent."],
    note: alert.note,
    levels: alert.levels,
    levelsNote: alert.levelsNote,
    eventLine: alert.eventLine ?? "",
    maxContracts: alert.maxContracts,
    singleContractExceedsCap: alert.maxContracts != null && alert.maxContracts < 1,
    suggestion: null,
    liquidityPasses: alert.liquidityPasses,
    dailyStop: alert.verdict === "STOP",
  };
}

export function flowCardFromAlert(alert: StoredAlert, now: Date): ScoredFlowRow {
  const mid = alert.mid != null && alert.mid > 0 ? alert.mid : null;
  const spreadFraction = mid != null && alert.ask >= alert.bid ? (alert.ask - alert.bid) / mid : null;
  const distance = otmDistance(alert.putCall, alert.strike, alert.underlyingPrice);
  const ratio = volumeOiRatio(alert.volume, alert.openInterest);
  return {
    id: alert.contractKey,
    ticker: alert.ticker,
    putCall: alert.putCall,
    strike: alert.strike,
    expiration: alert.expiration,
    bid: alert.bid,
    ask: alert.ask,
    last: Number.isFinite(alert.last) ? alert.last as number : Number.NaN,
    volume: alert.volume,
    openInterest: alert.openInterest,
    iv: null,
    delta: null,
    mid,
    notionalPremium: notionalPremium(alert.volume, mid),
    volOiRatio: ratio,
    volumeOiJump: volumeOiJump(alert.volume, alert.openInterest),
    volumeExceedsOi: ratio != null && ratio > 1,
    previousVolume: null,
    volumeJump: null,
    otmPoints: distance.points,
    otmFraction: distance.fraction,
    otm: distance.otm,
    dte: calendarDaysBetween(newYorkDate(now), alert.expiration),
    spreadFraction,
    spreadQuality: spreadQualityOf(spreadFraction, alert.liquidityPasses),
    side: alert.side,
    sideNote: SIDE_NOTE,
    askFraction: null,
    liquidityPasses: alert.liquidityPasses,
    delayed: false,
    underlyingPrice: alert.underlyingPrice,
    levels: null,
    prints: EMPTY_PRINTS,
    score: alert.flowScore,
    verdict: verdictFromStoredAlert(alert),
    alertId: alert.id,
    openingLabel: openingLabelFor(alert),
  };
}

function openingLabelFor(alert: StoredAlert): string | null {
  if (!alert.openingCheck) return null;
  return openingLabel(alert.openingCheck.status);
}
