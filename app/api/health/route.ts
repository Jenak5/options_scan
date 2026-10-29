import { NextRequest, NextResponse } from "next/server";
import { loadAlertBook } from "@/app/lib/alertStore";
import { avwapPaperHealth, parseAvwapPaperBook } from "@/app/lib/avwapPaper";
import { callsPaperHealth, parseCallsPaperBook } from "@/app/lib/callsPaper";
import { hasHealthBearer } from "@/app/lib/auth";
import { emptyCandleHealth, readCandleHealth } from "@/app/lib/candleStore";
import { buildHealthReport, countShadowTotals, trackedAlertCounts } from "@/app/lib/healthReport";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { loadMarketDataHealth } from "@/app/lib/marketData";
import { getSchwabStatus } from "@/app/lib/schwab";
import { readAvwapPaperBookText, readCallsPaperBookText, readScanHealth, readShadowBookText } from "@/app/lib/schwabStore";
import { readUnusualBook } from "@/app/lib/unusualFlowStore";
import { unusualFlowHealth } from "@/app/lib/unusualFlow";
import { parseShadowBook } from "@/app/lib/shadow";
import { tastytradeEnabled } from "@/app/lib/tastytrade";

export const dynamic = "force-dynamic";

/**
 * Read-only monitor. Bearer HEALTH_TOKEN, or CRON_SECRET when HEALTH_TOKEN is unset.
 * No session cookie. No secrets in the body. Nothing here places an order.
 */
export async function GET(request: NextRequest) {
  if (!(await hasHealthBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const [health, schwab, book, shadowText, candles, avwapText, callsText, unusualBook, marketData] = await Promise.all([
    readScanHealth().catch(() => emptyScanHealth()),
    getSchwabStatus().then(
      (status) => status.connected === true,
      () => false,
    ),
    loadAlertBook().catch(() => ({ records: [] })),
    readShadowBookText().catch(() => ""),
    readCandleHealth().catch(() => emptyCandleHealth()),
    readAvwapPaperBookText().catch(() => null),
    readCallsPaperBookText().catch(() => null),
    readUnusualBook().catch(() => null),
    loadMarketDataHealth().catch(() => null),
  ]);
  const shadowBook = parseShadowBook(shadowText);
  const avwapBook = parseAvwapPaperBook(avwapText);
  const totals = countShadowTotals(shadowBook.records);
  const tracked = trackedAlertCounts(shadowBook.records, shadowBook.research ?? [], now);
  const report = buildHealthReport({
    health,
    schwabConnected: schwab,
    tastytradeEnabled: tastytradeEnabled(),
    alerts: book.records,
    openShadows: totals.openShadows,
    resolvedShadows: totals.resolvedShadows,
    trackedAlertsTotal: tracked.trackedAlertsTotal,
    trackedAlertsActive: tracked.trackedAlertsActive,
    trackedAlertsComplete: tracked.trackedAlertsComplete,
    candlesLastRun: candles.candlesLastRun,
    candleAlertsCovered: candles.candleAlertsCovered,
    candleErrors: candles.candleErrors,
    candleErrorSample: candles.candleErrorSample,
    avwapPaper: avwapPaperHealth(avwapBook.trades, now, avwapBook),
    callsPaper: callsPaperHealth(parseCallsPaperBook(callsText), now),
    unusualFlow: unusualBook ? unusualFlowHealth(unusualBook, now) : undefined,
    marketData: marketData ?? undefined,
    now,
  });
  return NextResponse.json({ ...report, dataSource: report.marketData });
}
