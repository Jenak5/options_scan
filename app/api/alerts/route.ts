import { flowRowLabels, tickerSentToday } from "@/app/lib/scanLabels";
import { NextRequest, NextResponse } from "next/server";
import { alertScanMinPremium, alertsPerDayLimit } from "@/app/lib/alertConfig";
import {
  alertContractKey,
  chooseAlerts,
  gradeAlertCandidates,
  indexSentAlerts,
  realertReasons,
  storedAlertPremium,
} from "@/app/lib/alertPolicy";
import { currentDailyLoss, loadAlertBook, recordOpeningChecks, rememberSentAlert } from "@/app/lib/alertStore";
import { lastAlertBookWriteError } from "@/app/lib/schwabStore";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { flowCronSliceNote, planCronScan, selectAlertRows, watchlistFromEnv } from "@/app/lib/flow";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { preferredDataSource } from "@/app/lib/dataSourcePref";
import { BothSourcesFailedError, isSchwabBackupMiss } from "@/app/lib/marketData";
import { noteBrowserScan } from "@/app/lib/pageScan";
import { normalizeSkippedTickers } from "@/app/lib/scanHealth";
import { earningsDateMapForRows, windowEarningsDateForContract } from "@/app/lib/earningsWindow";
import { markShadowsFromRows, openMissingShadows, openScanTickers } from "@/app/lib/shadowStore";
import { chicagoDate, isMarketDay } from "@/app/lib/marketHours";
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
        const now = new Date();
        if (!isMarketDay(now)) {
          return NextResponse.json({ skipped: "market holiday" });
        }
        const minPremium = alertScanMinPremium(process.env.ALERT_MIN_PREMIUM);
        const otmOnly = process.env.ALERT_OTM_ONLY === "true";
        const watchlist = watchlistFromEnv(process.env.FLOW_WATCHLIST);
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
        const graded = gradeAlertCandidates(rows, losses, now);
        const picks = chooseAlerts({
          candidates: graded,
          alreadySentContractKeys: sent.contracts,
          alreadySentSetupKeys: sent.setups,
          sentByContract: sent.byContract,
          limit: room,
        });
        let alertsSent = 0;
        const log: string[] = [flowCronSliceNote(plan, watchlist.length, process.env.FLOW_WATCHLIST)];
        const earningsDates = await earningsDateMapForRows(scan.rows, now);
        try {
          const checked = await recordOpeningChecks(scan.chainInterest, now);
          log.push(`Opening check: ${checked} alert${checked === 1 ? "" : "s"} updated from this chain`);
        } catch {
          log.push("Opening check was not saved");
        }

        for (const item of picks) {
          if (alertsSent >= room) break;
          const latestBook = (await loadAlertBook()).records;
          const latest = indexSentAlerts(latestBook, tradingDay);
          if (latest.count >= maxPerDay) break;
          const prior = latest.byContract.get(alertContractKey(item.row)) ?? null;
          const repeatReasons = prior
            ? realertReasons(prior, {
              grade: item.verdict.grade,
              premium: storedAlertPremium({ alertedPremium: item.row.notionalPremium }),
            })
            : [];
          if (prior && repeatReasons.length === 0) continue;
          if (!prior && (latest.contracts.has(item.row.id) || latest.contracts.has(alertContractKey(item.row)))) continue;
          const alertId = `${now.getTime()}-${item.row.id}`;
          const windowDate = windowEarningsDateForContract({
            ticker: item.row.ticker,
            expiration: item.row.expiration,
            now,
            dates: earningsDates,
          });
          const claim = await rememberSentAlert(item.row, item.verdict, now, windowDate);
          if (!claim.send) {
            if (!claim.saved) {
              const failure = await lastAlertBookWriteError();
              const http = failure?.status == null ? "no HTTP status" : `HTTP ${failure.status}`;
              const detail = failure ? ` (${http}: ${failure.message})` : "";
              log.push(`${item.row.ticker}: alert book was not saved, so Telegram was not sent${detail}`);
            }
            continue;
          }
          const labels: string[] = flowRowLabels(item.row, now.getTime());
          if (tickerSentToday(latestBook, item.row.ticker, tradingDay)) labels.splice(1, 0, "repeat");
          const message = formatFlowAlert({
            ...item.row,
            verdict: item.verdict,
            alertId,
            saved: true,
            labels,
            realertReasons: claim.reasons,
          });
          const delivered = await sendTelegramAlert(message);
          if (delivered) alertsSent++;
          if (!delivered) {
            log.push(`${item.row.ticker}: saved in the alert book, but Telegram send failed`);
          } else {
            log.push(`${item.row.ticker}: Telegram alert sent and saved`);
          }
          await new Promise((r) => setTimeout(r, 1100));
        }

        try {
          const opened = await openMissingShadows();
          const marks = await markShadowsFromRows(
            scan.rows,
            now,
            graded.map((item) => ({ row: item.row, grade: item.verdict.grade })),
          );
          const touched = (opened.saved && opened.opened > 0) || (marks.saved && (marks.marked > 0 || marks.closed > 0));
          const skippedNames = normalizeSkippedTickers(scan.errors.map((item) => item.ticker));
          await noteBrowserScan(
            now,
            touched ? now.getTime() : null,
            skippedNames.length > 0 ? "partial" : "success",
            skippedNames,
          );
          log.push(`Shadows: ${opened.opened} opened, ${marks.marked} marked from this scan`);
        } catch {
          log.push("Shadow update failed");
        }

        return NextResponse.json({
          success: true,
          scanned: scan.rows.length,
          matched: rows.length,
          alerts_sent: alertsSent,
          log,
          errors: scan.errors,
          skipped: scan.errors.map((item) => item.ticker),
        });
      }

      default:
        return NextResponse.json({ error: "Use action=test or action=scan" }, { status: 400 });
    }
  } catch (err) {
    if (preferredDataSource() === "tastytrade" && isSchwabBackupMiss(err)) {
      const skipped = err instanceof BothSourcesFailedError ? [err.label] : [];
      return NextResponse.json({
        success: true,
        scanned: 0,
        matched: 0,
        alerts_sent: 0,
        log: [err instanceof Error ? err.message.slice(0, 180) : "skipped"],
        errors: skipped.map((ticker) => ({ ticker, message: err instanceof Error ? err.message.slice(0, 180) : "skipped" })),
        skipped,
      });
    }
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
