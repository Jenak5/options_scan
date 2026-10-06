import type { StoredAlert } from "@/app/lib/alertBook";
import { chicagoDate } from "@/app/lib/marketHours";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import { latestScan, type ScanHealth, type ScanOutcome } from "@/app/lib/scanHealth";
import { isExperimentShadow, type ShadowTrade } from "@/app/lib/shadow";

/**
 * Numbers for the hourly monitor. No tokens, no account numbers, no messages.
 */

export interface HealthReport {
  lastScanAt: string | null;
  lastScanOutcome: ScanOutcome | null;
  lastCronAt: string | null;
  lastCronOutcome: ScanOutcome | null;
  lastBrowserScanAt: string | null;
  schwabConnected: boolean;
  tastytradeEnabled: boolean;
  alertsSavedToday: number;
  openShadows: number;
  lastShadowAt: string | null;
  learningSnapshotsToday: number;
  resolvedShadows: number;
  rulesVersion: number;
}

export function buildHealthReport(input: {
  health: ScanHealth;
  schwabConnected: boolean;
  tastytradeEnabled: boolean;
  alerts: readonly StoredAlert[];
  openShadows: number;
  resolvedShadows: number;
  now: Date;
}): HealthReport {
  const latest = latestScan(input.health);
  const day = chicagoDate(input.now);
  let alertsSavedToday = 0;
  let learningSnapshotsToday = 0;
  for (let i = 0; i < input.alerts.length; i++) {
    const alert = input.alerts[i];
    if (alert.tradingDay !== day) continue;
    alertsSavedToday += 1;
    if (alert.features?.capturedAtAlert === true) learningSnapshotsToday += 1;
  }
  return {
    lastScanAt: iso(latest.at),
    lastScanOutcome: latest.outcome,
    lastCronAt: iso(input.health.lastRunAt),
    lastCronOutcome: input.health.lastOutcome,
    lastBrowserScanAt: iso(input.health.lastBrowserScanAt),
    schwabConnected: input.schwabConnected,
    tastytradeEnabled: input.tastytradeEnabled,
    alertsSavedToday,
    openShadows: input.openShadows,
    lastShadowAt: iso(input.health.lastShadowAt),
    learningSnapshotsToday,
    resolvedShadows: input.resolvedShadows,
    rulesVersion: RULES_VERSION,
  };
}

export function countShadowTotals(records: readonly ShadowTrade[]): { openShadows: number; resolvedShadows: number } {
  let openShadows = 0;
  let resolvedShadows = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (isExperimentShadow(row)) continue;
    if (row.status === "open") openShadows += 1;
    else if (row.status === "closed" && row.pnlDollars != null && row.exitPrice != null) resolvedShadows += 1;
  }
  return { openShadows, resolvedShadows };
}

function iso(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}
