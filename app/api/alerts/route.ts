import { NextRequest, NextResponse } from "next/server";
import { alertScanMinPremium, alertsPerDayLimit } from "@/app/lib/alertConfig";
import {
  alertSetupKey,
  chooseAlerts,
  gradeAlertCandidates,
  indexSentAlerts,
} from "@/app/lib/alertPolicy";
import { currentDailyLoss, loadAlertBook, rememberSentAlert } from "@/app/lib/alertStore";
import { lastAlertBookWriteError, noteAlertSentUnsaved } from "@/app/lib/schwabStore";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { flowCronSliceNote, planCronScan, selectAlertRows, watchlistFromEnv } from "@/app/lib/flow";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { openScanTickers } from "@/app/lib/shadowStore";
import { chicagoDate } from "@/app/lib/marketHours";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { sendTelegramAlert, formatFlowAlert } from "@/app/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  const action = request.nextUrl.searchParams.get("action");

  try {
    switch (action) {
      case "test": {
        const sent = await sendTelegramAlert(
          "🧪 <b>OPTIONS EDGE SCANNER</b>\n\n✅ Telegram alerts are working!\n\nYou'll receive an alert when a setup grades A or B. C and D stay on the Flow tab."
        );
        return NextResponse.json({ success: sent, message: sent ? "Test alert sent!" : "Failed — check your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
      }

      case "scan": {
        const minPremium = alertScanMinPremium(process.env.ALERT_MIN_PREMIUM);
        const otmOnly = process.env.ALERT_OTM_ONLY === "true";
        const watchlist = watchlistFromEnv(process.env.FLOW_WATCHLIST);
        const now = new Date();
        const plan = planCronScan(watchlist, now, await openScanTickers());
        const scan = await scanEstimatedFlow({
          tickers: plan.tickers,
        });
        const rows = selectAlertRows(scan.rows, {
          minPremium,
          otmOnly,
          limit: 80,
        });
        const tradingDay = chicagoDate(now);
        const losses = await currentDailyLoss(now);
        const maxPerDay = alertsPerDayLimit(process.env.ALERT_MAX_PER_DAY);
        const sent = indexSentAlerts((await loadAlertBook()).records, tradingDay);
        const room = Math.max(0, maxPerDay - sent.count);
        const picks = chooseAlerts({
          candidates: gradeAlertCandidates(rows, losses, now),
          alreadySentContractKeys: sent.contracts,
          alreadySentSetupKeys: sent.setups,
          limit: room,
        });
        let alertsSent = 0;
        const log: string[] = [flowCronSliceNote(plan, watchlist.length, process.env.FLOW_WATCHLIST)];

        for (const item of picks) {
          if (alertsSent >= room) break;
          const latest = indexSentAlerts((await loadAlertBook()).records, tradingDay);
          if (latest.count >= maxPerDay) break;
          if (latest.contracts.has(item.row.id) || latest.setups.has(alertSetupKey(item.row))) continue;
          const alertId = `${now.getTime()}-${item.row.id}`;
          const saved = await rememberSentAlert(item.row, item.verdict, now);
          const message = formatFlowAlert({ ...item.row, verdict: item.verdict, alertId, saved });
          const delivered = await sendTelegramAlert(message);
          if (delivered) alertsSent++;
          if (!saved) {
            const failure = await lastAlertBookWriteError();
            if (delivered) await noteAlertSentUnsaved(now);
            const http = failure?.status == null ? "no HTTP status" : `HTTP ${failure.status}`;
            const detail = failure ? ` (${http}: ${failure.message})` : "";
            log.push(`${item.row.ticker}: alert book was not saved${detail}`);
          } else if (!delivered) {
            log.push(`${item.row.ticker}: saved in the alert book, but Telegram send failed`);
          } else {
            log.push(`${item.row.ticker}: Telegram alert sent and saved`);
          }
          await new Promise((r) => setTimeout(r, 1100));
        }

        return NextResponse.json({
          success: true,
          scanned: scan.rows.length,
          matched: rows.length,
          alerts_sent: alertsSent,
          log,
          errors: scan.errors,
        });
      }

      default:
        return NextResponse.json({ error: "Use action=test or action=scan" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof SchwabNotConnectedError) {
      return NextResponse.json({ error: err.message, reconnect: "/api/schwab/connect", connected: false }, { status: 409 });
    }
    if (err instanceof SchwabConfigError) {
      return NextResponse.json({ error: err.message, connected: false }, { status: 503 });
    }
    const message = err instanceof Error && err.message.startsWith("Schwab ")
      ? err.message.slice(0, 180)
      : "Alert scan failed";
    console.error("Alert error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  try {
    const { message } = await request.json();
    if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
    const sent = await sendTelegramAlert(message);
    return NextResponse.json({ success: sent });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Alert failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
