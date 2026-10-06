import { alertScanMinPremium, alertsPerDayLimit } from "@/app/lib/alertConfig";
import { loadAlertBook, rememberSentAlert } from "@/app/lib/alertStore";
import {
  chooseAlerts,
  gradeAlertCandidates,
  indexSentAlerts,
} from "@/app/lib/alertPolicy";
import { selectAlertRows, type FlowRow } from "@/app/lib/flow";
import { chicagoDate } from "@/app/lib/marketHours";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { readScanHealth, writeScanHealth } from "@/app/lib/schwabStore";
import { markShadowsFromRows, openMissingShadows } from "@/app/lib/shadowStore";
import { formatFlowAlert, sendTelegramAlert } from "@/app/lib/telegram";

/**
 * The Flow page grades contracts when it loads. That used to stay on the screen
 * and never reach the alert book, so Scorecard and Learning mode stayed stale
 * unless the scheduled scan also ran.
 * This writes the same A/B rows the scheduled scan would save, opens their shadows,
 * and marks them from the chain already in hand. No extra Schwab read.
 */

export interface PageScanRecord {
  saved: number;
  opened: number;
  marked: number;
  closed: number;
}

export async function recordDisplayedAlerts(
  rows: readonly FlowRow[],
  consecutiveLosses: number | null,
  now: Date,
): Promise<PageScanRecord> {
  const minPremium = alertScanMinPremium(process.env.ALERT_MIN_PREMIUM);
  const otmOnly = process.env.ALERT_OTM_ONLY === "true";
  const maxPerDay = alertsPerDayLimit(process.env.ALERT_MAX_PER_DAY);
  const tradingDay = chicagoDate(now);
  const candidates = selectAlertRows(rows.slice(), { minPremium, otmOnly, limit: 80 });
  const graded = gradeAlertCandidates(candidates, consecutiveLosses, now);
  const sent = indexSentAlerts((await loadAlertBook()).records, tradingDay);
  const room = Math.max(0, maxPerDay - sent.count);
  const queued = chooseAlerts({
    candidates: graded,
    alreadySentContractKeys: sent.contracts,
    alreadySentSetupKeys: sent.setups,
    limit: room,
  });

  let saved = 0;
  for (let i = 0; i < queued.length; i++) {
    const item = queued[i];
    const created = await saveNewAlert(item.row, item.verdict, now);
    if (!created) continue;
    saved += 1;
    const alertId = `${now.getTime()}-${item.row.id}`;
    await sendTelegramAlert(formatFlowAlert({
      ...item.row,
      verdict: item.verdict,
      alertId,
      saved: true,
    }));
  }

  const opened = await openMissingShadows();
  const marks = await markShadowsFromRows(rows, now);
  return {
    saved,
    opened: opened.saved ? opened.opened : 0,
    marked: marks.saved ? marks.marked : 0,
    closed: marks.saved ? marks.closed : 0,
  };
}

async function saveNewAlert(
  row: FlowRow,
  verdict: Parameters<typeof rememberSentAlert>[1],
  now: Date,
): Promise<boolean> {
  const tradingDay = chicagoDate(now);
  const sentAt = now.getTime();
  const ok = await rememberSentAlert(row, verdict, now);
  if (!ok) return false;
  const book = await loadAlertBook();
  for (let i = 0; i < book.records.length; i++) {
    const record = book.records[i];
    if (record.contractKey === row.id && record.tradingDay === tradingDay && record.sentAt === sentAt) {
      return true;
    }
  }
  return false;
}

/** Remember a Flow page load without taking the scheduled scan's slot. */
export async function noteBrowserScan(now: Date, shadowAt: number | null): Promise<void> {
  try {
    const current = await readScanHealth().catch(() => emptyScanHealth());
    await writeScanHealth({
      ...current,
      lastBrowserScanAt: now.getTime(),
      lastShadowAt: shadowAt ?? current.lastShadowAt,
    });
  } catch {
    // The Flow response still returns. The health check shows the previous time.
  }
}
