import { flowRowLabels } from "@/app/lib/scanLabels";
import { alertScanMinPremium, alertsPerDayLimit } from "@/app/lib/alertConfig";
import { loadAlertBook, recordOpeningChecks, rememberSentAlert } from "@/app/lib/alertStore";
import {
  chooseAlerts,
  gradeAlertCandidates,
  indexSentAlerts,
} from "@/app/lib/alertPolicy";
import { earningsDateMapForRows, windowEarningsDateForContract } from "@/app/lib/earningsWindow";
import { selectAlertRows, type FlowRow } from "@/app/lib/flow";
import { chicagoDate, isChicagoMarketHours, isMarketDay } from "@/app/lib/marketHours";
import type { ChainInterest } from "@/app/lib/openingCheck";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { readScanHealth, writeScanHealth } from "@/app/lib/schwabStore";
import { markShadowsFromRows, openMissingShadows } from "@/app/lib/shadowStore";
import { formatFlowAlert, sendTelegramAlert } from "@/app/lib/telegram";

/**
 * The Flow page grades contracts when it loads. That used to stay on the screen
 * and never reach the alert book, so Scorecard and Learning mode stayed stale
 * unless the scheduled scan also ran.
 * During weekdays 8:30–15:00 Central this writes the same A/B rows the scheduled
 * scan would save, opens their shadows, and marks them from the chain already in hand.
 * Outside that window, and on a full-day NYSE holiday, it writes nothing. No extra Schwab read.
 */

export interface PageScanRecord {
  saved: number;
  opened: number;
  marked: number;
  closed: number;
}

/**
 * Persist what the Flow page just displayed.
 * Outside weekdays 8:30–15:00 Central, and on a full-day NYSE holiday, this
 * returns without writing. The page can still show the chain. After-close
 * quotes and holiday sessions are not used to save alerts, open or mark
 * shadows, store a learning snapshot, or run the next-day open-interest check.
 */
export async function recordFlowPageSession(
  rows: readonly FlowRow[],
  chainInterest: ChainInterest | null | undefined,
  consecutiveLosses: number | null,
  now: Date,
): Promise<PageScanRecord> {
  if (!isMarketDay(now) || !isChicagoMarketHours(now)) {
    return { saved: 0, opened: 0, marked: 0, closed: 0 };
  }
  const recorded = await recordDisplayedAlerts(rows, consecutiveLosses, now);
  try {
    await recordOpeningChecks(chainInterest, now);
  } catch {
    // The page still shows this chain. The next in-session scan can record the check.
  }
  return recorded;
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
  const bookRecords = (await loadAlertBook()).records;
  const sent = indexSentAlerts(bookRecords, tradingDay);
  const sentTickers = new Set<string>();
  for (const record of bookRecords) if (record.tradingDay === tradingDay) sentTickers.add(record.ticker);
  const room = Math.max(0, maxPerDay - sent.count);
  const queued = chooseAlerts({
    candidates: graded,
    alreadySentContractKeys: sent.contracts,
    alreadySentSetupKeys: sent.setups,
    limit: room,
  });
  const earningsDates = queued.length === 0
    ? new Map<string, string | null>()
    : await earningsDateMapForRows(queued.map((item) => item.row), now);

  let saved = 0;
  for (let i = 0; i < queued.length; i++) {
    const item = queued[i];
    const windowDate = windowEarningsDateForContract({
      ticker: item.row.ticker,
      expiration: item.row.expiration,
      now,
      dates: earningsDates,
    });
    const created = await saveNewAlert(item.row, item.verdict, now, windowDate);
    if (!created) continue;
    saved += 1;
    const alertId = `${now.getTime()}-${item.row.id}`;
    const labels: string[] = flowRowLabels(item.row, now.getTime());
    if (sentTickers.has(item.row.ticker)) labels.splice(1, 0, "repeat");
    sentTickers.add(item.row.ticker);
    await sendTelegramAlert(formatFlowAlert({
      ...item.row,
      verdict: item.verdict,
      alertId,
      saved: true,
      labels,
    }));
  }

  const opened = await openMissingShadows();
  const marks = await markShadowsFromRows(
    rows,
    now,
    graded.map((item) => ({ row: item.row, grade: item.verdict.grade })),
  );
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
  windowEarningsDate: string | null,
): Promise<boolean> {
  const tradingDay = chicagoDate(now);
  const sentAt = now.getTime();
  const ok = await rememberSentAlert(row, verdict, now, windowEarningsDate);
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
export async function noteBrowserScan(
  now: Date,
  shadowAt: number | null,
  outcome: "success" | "partial" = "success",
  skippedTickers: readonly string[] = [],
): Promise<void> {
  try {
    const current = await readScanHealth().catch(() => emptyScanHealth());
    await writeScanHealth({
      ...current,
      lastBrowserScanAt: now.getTime(),
      lastBrowserOutcome: outcome,
      lastBrowserSkippedTickers: outcome === "partial" ? skippedTickers.slice() : [],
      lastShadowAt: shadowAt ?? current.lastShadowAt,
    });
  } catch {
    // The Flow response still returns. The health check shows the previous time.
  }
}
