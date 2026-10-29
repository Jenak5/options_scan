import type { StoredAlert } from "@/app/lib/alertBook";
import { emptyAvwapPaperHealth, type AvwapPaperHealth } from "@/app/lib/avwapPaper";
import { emptyCallsPaperHealth, type CallsPaperHealth } from "@/app/lib/callsPaper";
import { emptyMarketDataHealth, type MarketDataHealth } from "@/app/lib/marketDataHealth";
import { emptyUnusualFlowHealth, type UnusualFlowHealth } from "@/app/lib/unusualFlow";
import { chicagoDate, isMarketDay, isNyseHoliday } from "@/app/lib/marketHours";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import { latestScan, type ScanHealth, type ScanOutcome } from "@/app/lib/scanHealth";
import { countTrackedAlerts, type ResearchTrack, type TrackedShadow } from "@/app/lib/researchTrack";
import { excludedFromMainTotals, type ShadowTrade } from "@/app/lib/shadow";

/**
 * Numbers for the hourly monitor. No tokens, no account numbers, no messages.
 */

export interface HealthReport {
  lastScanAt: string | null;
  lastScanOutcome: ScanOutcome | null;
  /** How many tickers the last scan did not read. */
  skippedTickers: number;
  /** Those tickers. Empty when the last scan skipped none. */
  skippedTickerList: string[];
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
  /** False on weekends and on full-day NYSE holidays. */
  marketDay: boolean;
  /** "holiday" on a full-day NYSE close, so a missing scan is expected. Otherwise null. */
  reason: "holiday" | null;
  /** Scorecard quote-tracks plus research tracks. Alerts saved before tracking are not in this count. */
  trackedAlertsTotal: number;
  /** Still inside 7 Chicago trading days and not past expiration. */
  trackedAlertsActive: number;
  /** Finished the 7-trading-day window. An earlier expiration is not this count. */
  trackedAlertsComplete: number;
  /** ISO time of the last candle cron or backfill. Null until one has been saved. */
  candlesLastRun: string | null;
  /** Alerts with at least one stored 1-minute candle day. */
  candleAlertsCovered: number;
  /** Symbols that failed on the last candle run. */
  candleErrors: number;
  /** Tastytrade OAuth error and error_description from the last candle run. Null on success. */
  candleErrorSample: string | null;
  /** Gap-day anchored VWAP paper log, including the last check and why each symbol did not enter. No orders. */
  avwapPaper: AvwapPaperHealth;
  /** Flush-then-reclaim call paper log. Counts only. No orders. lastCheckAt is the last scan that evaluated the session. */
  callsPaper: CallsPaperHealth;
  /** Unusual-flow flags saved by the scan. Counts only. No Telegram alerts. */
  unusualFlow: UnusualFlowHealth;
  /**
   * Active provider per data type, fallback count, last error, and the last
   * successful Tastytrade call. No secrets. tradeSideDataAvailable is yes or no.
   */
  marketData: MarketDataHealth;
}

export function buildHealthReport(input: {
  health: ScanHealth;
  schwabConnected: boolean;
  tastytradeEnabled: boolean;
  alerts: readonly StoredAlert[];
  openShadows: number;
  resolvedShadows: number;
  trackedAlertsTotal?: number;
  trackedAlertsActive?: number;
  trackedAlertsComplete?: number;
  candlesLastRun?: string | null;
  candleAlertsCovered?: number;
  candleErrors?: number;
  candleErrorSample?: string | null;
  avwapPaper?: AvwapPaperHealth;
  callsPaper?: CallsPaperHealth;
  unusualFlow?: UnusualFlowHealth;
  marketData?: MarketDataHealth;
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
    skippedTickers: latest.skippedTickers.length,
    skippedTickerList: latest.skippedTickers,
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
    marketDay: isMarketDay(input.now),
    reason: isNyseHoliday(input.now) ? "holiday" : null,
    trackedAlertsTotal: input.trackedAlertsTotal ?? 0,
    trackedAlertsActive: input.trackedAlertsActive ?? 0,
    trackedAlertsComplete: input.trackedAlertsComplete ?? 0,
    candlesLastRun: input.candlesLastRun ?? null,
    candleAlertsCovered: input.candleAlertsCovered ?? 0,
    candleErrors: input.candleErrors ?? 0,
    candleErrorSample: input.candleErrorSample ?? null,
    avwapPaper: input.avwapPaper ?? emptyAvwapPaperHealth(),
    callsPaper: input.callsPaper ?? emptyCallsPaperHealth(),
    unusualFlow: input.unusualFlow ?? emptyUnusualFlowHealth(),
    marketData: input.marketData ?? emptyMarketDataHealth(),
  };
}

export function trackedAlertCounts(
  shadows: readonly TrackedShadow[],
  research: readonly ResearchTrack[],
  now: Date,
): { trackedAlertsTotal: number; trackedAlertsActive: number; trackedAlertsComplete: number } {
  return countTrackedAlerts(shadows, research, now);
}

export function countShadowTotals(records: readonly ShadowTrade[]): { openShadows: number; resolvedShadows: number } {
  let openShadows = 0;
  let resolvedShadows = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (excludedFromMainTotals(row)) continue;
    if (row.status === "open") openShadows += 1;
    else if (row.status === "closed" && row.pnlDollars != null && row.exitPrice != null) resolvedShadows += 1;
  }
  return { openShadows, resolvedShadows };
}

function iso(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}
