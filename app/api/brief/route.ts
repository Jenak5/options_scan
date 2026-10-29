import { NextRequest, NextResponse } from "next/server";
import { loadAlertBook } from "@/app/lib/alertStore";
import { parseAvwapPaperBook } from "@/app/lib/avwapPaper";
import { parseCallsPaperBook } from "@/app/lib/callsPaper";
import { hasHealthBearer } from "@/app/lib/auth";
import { buildMarketBrief } from "@/app/lib/brief";
import { buildHealthReport, countShadowTotals } from "@/app/lib/healthReport";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { getSchwabStatus } from "@/app/lib/schwab";
import { readAvwapPaperBookText, readCallsPaperBookText, readScanHealth, readShadowBookText, readTradeLogText } from "@/app/lib/schwabStore";
import { parseShadowBook } from "@/app/lib/shadow";
import { tastytradeEnabled } from "@/app/lib/tastytrade";
import { quoteOpenPaperTrades } from "@/app/lib/tradeQuotes";
import { parseTradeLog } from "@/app/lib/trades";
import { readUnusualBook } from "@/app/lib/unusualFlowStore";
import { unusualFlowHealth } from "@/app/lib/unusualFlow";

export const dynamic = "force-dynamic";

/**
 * Read-only brief for pre-market, midday, and the close.
 * Bearer HEALTH_TOKEN, or CRON_SECRET when HEALTH_TOKEN is unset.
 * No session cookie. No secrets in the body.
 * Open paper trades get one batched Schwab quote, with a short timeout.
 * Open scorecard shadows keep the mark stored by the 5-minute scan.
 * This route does not write the trade log, the shadow book, the AVWAP paper log, the calls paper log, alerts, or scan health.
 * It does not call Tastytrade or place an order.
 * Unusual-flow flags are the ones the scan already stored. This route does not rescan.
 */
export async function GET(request: NextRequest) {
  if (!(await hasHealthBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const [health, schwab, book, shadowText, tradeText, avwapText, callsText, unusualBook] = await Promise.all([
    readScanHealth().catch(() => emptyScanHealth()),
    getSchwabStatus().then(
      (status) => status.connected === true,
      () => false,
    ),
    loadAlertBook().catch(() => ({ records: [] })),
    readShadowBookText().catch(() => null),
    readTradeLogText().catch(() => null),
    readAvwapPaperBookText().catch(() => null),
    readCallsPaperBookText().catch(() => null),
    readUnusualBook().catch(() => null),
  ]);
  const shadows = parseShadowBook(shadowText).records;
  const trades = parseTradeLog(tradeText).trades;
  const paperQuoteBatch = await quoteOpenPaperTrades(trades).catch(() => ({ quotes: {}, misses: {} }));
  const totals = countShadowTotals(shadows);
  const scan = buildHealthReport({
    health,
    schwabConnected: schwab,
    tastytradeEnabled: tastytradeEnabled(),
    alerts: book.records,
    openShadows: totals.openShadows,
    resolvedShadows: totals.resolvedShadows,
    unusualFlow: unusualBook ? unusualFlowHealth(unusualBook, now) : undefined,
    now,
  });
  return NextResponse.json(buildMarketBrief({
    alerts: book.records,
    shadows,
    trades,
    scan,
    now,
    paperQuotes: paperQuoteBatch.quotes,
    paperQuoteMisses: paperQuoteBatch.misses,
    avwapBook: parseAvwapPaperBook(avwapText),
    callsBook: parseCallsPaperBook(callsText),
    unusualFlags: unusualBook?.flags ?? [],
  }));
}
