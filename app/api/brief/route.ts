import { NextRequest, NextResponse } from "next/server";
import { loadAlertBook } from "@/app/lib/alertStore";
import { hasHealthBearer } from "@/app/lib/auth";
import { buildMarketBrief } from "@/app/lib/brief";
import { buildHealthReport, countShadowTotals } from "@/app/lib/healthReport";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { getSchwabStatus } from "@/app/lib/schwab";
import { readScanHealth, readShadowBookText, readTradeLogText } from "@/app/lib/schwabStore";
import { parseShadowBook } from "@/app/lib/shadow";
import { tastytradeEnabled } from "@/app/lib/tastytrade";
import { quoteOpenPaperTrades } from "@/app/lib/tradeQuotes";
import { parseTradeLog } from "@/app/lib/trades";

export const dynamic = "force-dynamic";

/**
 * Read-only brief for pre-market, midday, and the close.
 * Bearer HEALTH_TOKEN, or CRON_SECRET when HEALTH_TOKEN is unset.
 * No session cookie. No secrets in the body.
 * Open paper trades get one batched Schwab quote, with a short timeout.
 * Open scorecard shadows keep the mark stored by the 15-minute scan.
 * This route does not write the trade log, the shadow book, alerts, or scan health.
 * It does not call Tastytrade or place an order.
 */
export async function GET(request: NextRequest) {
  if (!(await hasHealthBearer(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const [health, schwab, book, shadowText, tradeText] = await Promise.all([
    readScanHealth().catch(() => emptyScanHealth()),
    getSchwabStatus().then(
      (status) => status.connected === true,
      () => false,
    ),
    loadAlertBook().catch(() => ({ records: [] })),
    readShadowBookText().catch(() => null),
    readTradeLogText().catch(() => null),
  ]);
  const shadows = parseShadowBook(shadowText).records;
  const trades = parseTradeLog(tradeText).trades;
  const paperQuotes = await quoteOpenPaperTrades(trades).catch(() => ({}));
  const totals = countShadowTotals(shadows);
  const scan = buildHealthReport({
    health,
    schwabConnected: schwab,
    tastytradeEnabled: tastytradeEnabled(),
    alerts: book.records,
    openShadows: totals.openShadows,
    resolvedShadows: totals.resolvedShadows,
    now,
  });
  return NextResponse.json(buildMarketBrief({
    alerts: book.records,
    shadows,
    trades,
    scan,
    now,
    paperQuotes,
  }));
}
