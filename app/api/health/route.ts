import { NextRequest, NextResponse } from "next/server";
import { loadAlertBook } from "@/app/lib/alertStore";
import { hasHealthBearer } from "@/app/lib/auth";
import { emptyCandleHealth, readCandleHealth } from "@/app/lib/candleStore";
import { buildHealthReport, countShadowTotals, trackedAlertCounts } from "@/app/lib/healthReport";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { getSchwabStatus } from "@/app/lib/schwab";
import { readScanHealth, readShadowBookText } from "@/app/lib/schwabStore";
import { parseShadowBook } from "@/app/lib/shadow";
import { tastytradeEnabled } from "@/app/lib/tastytrade";

export const dynamic = "force-dynamic";

/**
 * Read-only monitor. Bearer HEALTH_TOKEN, or CRON_SECRET when HEALTH_TOKEN is unset.
 * No session cookie. No secrets in the body. Nothing here calls Tastytrade or places an order.
 */
export async function GET(request: NextRequest) {
  if (!(await hasHealthBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const [health, schwab, book, shadowText, candles] = await Promise.all([
    readScanHealth().catch(() => emptyScanHealth()),
    getSchwabStatus().then(
      (status) => status.connected === true,
      () => false,
    ),
    loadAlertBook().catch(() => ({ records: [] })),
    readShadowBookText().catch(() => ""),
    readCandleHealth().catch(() => emptyCandleHealth()),
  ]);
  const shadowBook = parseShadowBook(shadowText);
  const totals = countShadowTotals(shadowBook.records);
  const tracked = trackedAlertCounts(shadowBook.records, shadowBook.research ?? [], now);
  return NextResponse.json(buildHealthReport({
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
    now,
  }));
}
