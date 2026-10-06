import { NextRequest, NextResponse } from "next/server";
import { OUTCOME_RULES, alertScanMinPremium, alertsPerDayLimit, formatContractPriceLine, formatFlowPremium, isAlertGrade } from "@/app/lib/alertConfig";
import { runAlertFollowUps } from "@/app/lib/alertFollowUp";
import {
  alertSetupKey,
  chooseAlerts,
  gradeAlertCandidates,
  indexSentAlerts,
  screenQueueLimit,
} from "@/app/lib/alertPolicy";
import { currentDailyLoss, loadAlertBook, recordOpeningChecks, rememberSentAlert } from "@/app/lib/alertStore";
import { lastAlertBookWriteError, noteAlertSentUnsaved } from "@/app/lib/schwabStore";
import { hasValidBearer } from "@/app/lib/auth";
import { flowCronSliceNote, planCronScan, selectAlertRows, watchlistFromEnv, type FlowRow } from "@/app/lib/flow";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { openMissingShadows, openScanTickers, recordExperimentalShadows, runShadowPass } from "@/app/lib/shadowStore";
import { chicagoDate, isChicagoMarketHours, isChicagoMinuteWindow } from "@/app/lib/marketHours";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { readScanHealth, writeScanHealth } from "@/app/lib/schwabStore";
import { emptyScanHealth, formatScanRunLine, scanSlotDecision, skipNotifyDue, skipTelegramText, skipWarning, type ScanHealth, type ScanRunSummary } from "@/app/lib/scanHealth";
import { sendTelegramAlert } from "@/app/lib/telegram";
import { probeTastytrade, tastytradeEnabled } from "@/app/lib/tastytrade";
import { planExitsForAsk } from "@/app/lib/exits";
import { formatVerdictHtml, paperTradeLinkHtml } from "@/app/lib/telegram";
import type { AlertVerdict } from "@/app/lib/verdict";
import { formatVolArbSummary, type VolArbReading, type VolSignal } from "@/app/lib/volArb";
import { scanVolArb } from "@/app/lib/volScan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMATED ALERT CRON  — /api/cron
// Vercel cron hits this every 15 minutes from 13:30 through 21:00 UTC on
// weekdays (see vercel.json). That window covers Central market hours in
// both daylight and standard time. This handler then keeps only
// 8:30am–3:00pm America/Chicago, Monday–Friday.
// Each run scans the original 15 names, any open shadow or paper ticker,
// and one group of the added names. maxDuration is 300 seconds.
//
// Auth is Authorization: Bearer <CRON_SECRET> only. A query secret is ignored.
// Telegram and the alert book get letter A and B only, capped per Chicago day.
//
// Required Vercel environment variables (store secrets as Sensitive):
//   XAI_API_KEY               — Grok for screening
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   CRON_SECRET
//   Schwab market data + token store (chains, quotes, and price history)
// ═══════════════════════════════════════════════════════════════════════════

const XAI_API = "https://api.x.ai/v1/chat/completions";
const TG_API  = (token: string) => `https://api.telegram.org/bot${token}`;

// Best-effort dedupe for this process. The alert book is the record that survives a cold start.
// A contract is marked handled only after it is saved, or after Grok flags it.
// A failed save stays unmarked so this process can try again.
// Keys are `${Chicago date}|${contract id}` and `${Chicago date}|${setup key}`.
const handledContractIds = new Set<string>();
const handledSetupKeys = new Set<string>();

const INDEX_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "XSP", "SPXW", "SPX", "VIX", "NDX", "RUT"]);

// ── Grok screening ────────────────────────────────────────────────────────
async function screenWithGrok(row: FlowRow, volSignal: string): Promise<{ clean: boolean; reason: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { clean: true, reason: "No XAI key — skipping screen" };

  const premStr = formatFlowPremium(row.notionalPremium);

  const prompt = `Estimated options flow (not a sweep) on ${row.ticker} ${(row.putCall).toUpperCase()}:
- Strike: $${row.strike}, Expiry: ${row.expiration}
- Flow premium (volume × mid × 100): ${premStr}
- ${formatContractPriceLine(row.ask)}
- Estimated side: ${row.side}
- Vol/OI: ${row.volOiRatio != null ? row.volOiRatio.toFixed(2) : "n/a"}
- Vol Arb signal: ${volSignal}

In 1-2 sentences: are there any obvious red flags RIGHT NOW? (earnings tomorrow, FDA decision, halted, major news, stock in freefall) If no red flags, say "No red flags."`;

  try {
    const res = await fetch(XAI_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "grok-3-fast",
        max_tokens: 150,
        messages: [
          { role: "system", content: "You are a risk screener for options trades. Be brief. Only flag genuine near-term risks." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) return { clean: true, reason: "Grok unavailable" };
    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? "";
    const hasRedFlag = !text.toLowerCase().includes("no red flag") &&
      (text.toLowerCase().includes("earnings") || text.toLowerCase().includes("fda") ||
       text.toLowerCase().includes("halted") || text.toLowerCase().includes("danger") ||
       text.toLowerCase().includes("warning") || text.toLowerCase().includes("avoid") ||
       text.toLowerCase().includes("freefall") || text.toLowerCase().includes("bankruptcy"));
    return { clean: !hasRedFlag, reason: text.trim() };
  } catch {
    return { clean: true, reason: "Screen error — proceeding" };
  }
}

function convictionFor(ticker: string, signal: VolSignal | null): { emoji: string; tier: string; note: string } {
  if (INDEX_ETFS.has(ticker)) {
    return { emoji: "⚠️", tier: "POSSIBLE HEDGE", note: "Index ETF — could be a portfolio hedge, not directional. Verify before trading." };
  }
  if (signal === "CHEAP") return { emoji: "✅", tier: "HIGH CONVICTION", note: "Estimated flow + cheap vol versus realized" };
  if (signal === "RICH") return { emoji: "🔴", tier: "LOW — SKIP", note: "Options look expensive versus realized vol" };
  if (signal === "NEUTRAL") return { emoji: "🔵", tier: "MEDIUM", note: "Neutral vol — the volume estimate is the signal" };
  return { emoji: "❓", tier: "UNSCORED", note: "Schwab did not return ATM IV versus realized vol" };
}

function formatAlert(
  row: FlowRow,
  volSummary: string,
  signal: VolSignal | null,
  grokNote: string,
  verdict: AlertVerdict,
  alertId: string,
  saved: boolean,
): string {
  const premStr = formatFlowPremium(row.notionalPremium);
  const typeEmoji = row.putCall === "call" ? "🟢" : "🔴";
  const conviction = convictionFor(row.ticker, signal);

  const iv = row.iv != null ? `${(row.iv * 100).toFixed(0)}%` : "—";
  const oi = Number.isFinite(row.openInterest) ? row.openInterest.toLocaleString() : "—";
  const ratio = row.volOiRatio != null ? `${row.volOiRatio.toFixed(2)}x vol/OI` : "vol/OI n/a";

  return `${typeEmoji} <b>${row.ticker} ${row.putCall.toUpperCase()}</b>
${formatVerdictHtml(verdict)}

${conviction.emoji} <b>${conviction.tier}</b>
Estimated flow from Schwab volume/open interest, not a sweep.

💰 <b>${premStr}</b> flow premium (volume × mid × 100)
💵 ${escapeHtml(formatContractPriceLine(row.ask))}
🎯 Strike <b>$${row.strike}</b> · Exp <b>${row.expiration}</b>
📊 ${escapeHtml(row.side)} · ${ratio} · IV ${iv} · OI ${oi}
${row.prints?.summary ? `🖨 ${escapeHtml(row.prints.summary)}\n` : ""}${exitText(row.ask, verdict.maxContracts)}📈 Vol Arb: <b>${escapeHtml(volSummary)}</b> — ${conviction.note}

🤖 <i>${escapeHtml(grokNote)}</i>

${saved ? paperTradeLinkHtml(alertId) : "Not saved in the app. No paper-trade link."}

<b>Options Edge Scanner</b>`;
}

function exitText(ask: number, maxContracts: number | null): string {
  const plan = planExitsForAsk(ask, maxContracts);
  if (!plan) return "";
  return `${plan.lines.concat(plan.note).map((line) => escapeHtml(line)).join("\n")}\n`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function saveDetail(failure: { status: number | null; message: string } | null): string {
  if (!failure) return "";
  const http = failure.status == null ? "no HTTP status" : `HTTP ${failure.status}`;
  return ` (${http}: ${failure.message})`;
}

function dayKey(tradingDay: string, key: string): string {
  return `${tradingDay}|${key}`;
}

function mergeDayKeys(tradingDay: string, fromBook: ReadonlySet<string>, memory: ReadonlySet<string>): Set<string> {
  const merged = new Set(fromBook);
  const prefix = `${tradingDay}|`;
  memory.forEach((value) => {
    if (value.startsWith(prefix)) merged.add(value.slice(prefix.length));
  });
  return merged;
}

async function sendTelegram(message: string): Promise<boolean> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${TG_API(token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  // Step 1 auth: Bearer only. Do not read ?secret= or x-cron-secret.
  if (!(await hasValidBearer(request))) {
    console.info(formatScanRunLine(emptySummary("unauthorized", "Bearer token rejected.")));
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isManual = request.nextUrl.searchParams.get("manual") === "true";
  const now = new Date();
  const inSession = isChicagoMarketHours(now);
  const closeWindow = isChicagoMinuteWindow(
    now,
    OUTCOME_RULES.closeCheckpointMinutes,
    OUTCOME_RULES.closeCheckpointMinutes + OUTCOME_RULES.closeWindowMinutes,
  );
  const summary = emptySummary("skipped");
  if (!inSession && !closeWindow && !isManual) {
    summary.reason = "Outside Central market hours (8:30–15:00 America/Chicago)";
    console.info(formatScanRunLine(summary));
    return NextResponse.json({
      skipped: true,
      reason: summary.reason,
    });
  }

  const slot = await claimScanSlot(now.getTime(), isManual);
  if (slot !== "ok") {
    summary.reason = slot === "busy"
      ? "Another scan is already running."
      : "A scan already finished in the last 10 minutes.";
    console.info(formatScanRunLine(summary));
    return NextResponse.json({ skipped: true, reason: summary.reason });
  }

  const log: string[] = [];
  let alertsSent = 0;
  let shadowAt: number | null = null;

  try {
    let followUps = { updated: 0, quoted: 0 };
    try {
      followUps = await runAlertFollowUps(now);
      log.push(`Follow-up quotes: ${followUps.quoted} requested, ${followUps.updated} records updated`);
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      log.push("Alert follow-up failed");
    }

    try {
      const openedEarly = await openMissingShadows();
      noteShadows(summary, openedEarly.opened, 0, 0, openedEarly.saved);
      if (openedEarly.opened > 0 && openedEarly.saved) shadowAt = now.getTime();
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      log.push("Shadow alert open failed");
    }

    if (!inSession && !isManual) {
      const shadow = await markShadows(now, log);
      noteShadows(summary, shadow.opened, shadow.quoted, shadow.closed, shadow.saved);
      if (shadowTouched(shadow)) shadowAt = now.getTime();
      summary.outcome = "success";
      await rememberScan("success", now, null, shadowAt);
      console.info(formatScanRunLine(summary));
      return NextResponse.json({ alertsSent: 0, followUpOnly: true, followUps, log });
    }

    const losses = await currentDailyLoss(now);
    const watchlist = watchlistFromEnv(process.env.FLOW_WATCHLIST);
    const plan = planCronScan(watchlist, now, await openScanTickers());
    summary.tickers = plan.tickers.length;
    log.push(flowCronSliceNote(plan, watchlist.length, process.env.FLOW_WATCHLIST));
    const scan = await scanEstimatedFlow({
      tickers: plan.tickers,
    });
    if (scan.errors.length > 0) {
      log.push(`Chain errors: ${scan.errors.map((item) => item.ticker).join(", ")}`);
    }
    log.push(`Scored ${scan.rows.length} contracts across ${scan.watchlist.length} tickers${scan.cached ? " (cached)" : ""}`);
    try {
      const checked = await recordOpeningChecks(scan.chainInterest, now);
      log.push(`Opening check: ${checked} alert${checked === 1 ? "" : "s"} updated from this chain`);
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      log.push("Opening check was not saved");
    }

    try {
      const experiment = await recordExperimentalShadows(scan.rows, losses, now);
      log.push(`Test 43-60 DTE: ${experiment.opened} new shadow${experiment.opened === 1 ? "" : "s"} (not alerted)`);
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      log.push("Test 43-60 DTE update failed");
    }

    const minPremium = alertScanMinPremium(process.env.ALERT_MIN_PREMIUM);
    const otmOnly = process.env.ALERT_OTM_ONLY === "true";
    const maxPerDay = alertsPerDayLimit(process.env.ALERT_MAX_PER_DAY);
    const tradingDay = chicagoDate(now);
    const candidates = selectAlertRows(scan.rows, {
      minPremium,
      otmOnly,
      limit: 80,
    });
    const graded = gradeAlertCandidates(candidates, losses, now);
    const sent = indexSentAlerts((await loadAlertBook()).records, tradingDay);
    const room = Math.max(0, maxPerDay - sent.count);
    const queued = chooseAlerts({
      candidates: graded,
      alreadySentContractKeys: mergeDayKeys(tradingDay, sent.contracts, handledContractIds),
      alreadySentSetupKeys: mergeDayKeys(tradingDay, sent.setups, handledSetupKeys),
      limit: screenQueueLimit(room),
    });

    const alertable = graded.filter((item) => item.verdict.verdict === "TAKE" && isAlertGrade(item.verdict.grade)).length;
    log.push(`Liquidity + premium filter passed ${candidates.length}`);
    log.push(`Graded ${graded.length}; ${alertable} are A or B; ${queued.length} new one${queued.length === 1 ? "" : "s"} to screen`);
    log.push(`Daily cap ${maxPerDay}, ${sent.count} already saved today, room for ${room}`);

    const volByTicker = new Map<string, VolArbReading>();
    const volMiss = new Map<string, string>();
    const symbols: string[] = [];
    const seenTickers = new Set<string>();
    for (let i = 0; i < queued.length; i++) {
      const ticker = queued[i].row.ticker;
      if (seenTickers.has(ticker)) continue;
      seenTickers.add(ticker);
      symbols.push(ticker);
    }
    if (symbols.length > 0) {
      try {
        const vol = await scanVolArb({ symbols });
        for (const reading of vol.rows) volByTicker.set(reading.symbol, reading);
        for (const item of vol.errors) volMiss.set(item.symbol, item.message);
      } catch (err) {
        if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
        log.push("Vol Arb scan failed");
      }
    }

    for (const item of queued) {
      if (alertsSent >= room) {
        log.push("Daily alert cap reached");
        break;
      }
      const row = item.row;
      const verdict = item.verdict;
      const setup = alertSetupKey(row);
      const latest = indexSentAlerts((await loadAlertBook()).records, tradingDay);
      const sentContracts = mergeDayKeys(tradingDay, latest.contracts, handledContractIds);
      const sentSetups = mergeDayKeys(tradingDay, latest.setups, handledSetupKeys);
      if (latest.count >= maxPerDay) {
        log.push("Daily alert cap reached");
        break;
      }
      if (sentContracts.has(row.id) || sentSetups.has(setup)) {
        log.push(`${row.ticker}: skipped — this ${row.putCall} expiring ${row.expiration} was already alerted today`);
        continue;
      }

      const reading = volByTicker.get(row.ticker) ?? null;
      const volSummary = reading
        ? formatVolArbSummary(reading)
        : (volMiss.get(row.ticker) ?? "Schwab did not return a vol reading for this symbol.");
      const signal = reading && reading.signal !== "NO_READ" ? reading.signal : null;
      log.push(`${row.ticker}: vol ${volSummary}`);

      const { clean, reason } = await screenWithGrok(row, volSummary);

      if (!clean) {
        handledContractIds.add(dayKey(tradingDay, row.id));
        log.push(`${row.ticker}: Grok flagged — ${reason}`);
        continue;
      }
      log.push(`${row.ticker}: Grok clean — ${reason}`);

      const alertId = `${now.getTime()}-${row.id}`;
      const saved = await rememberSentAlert(row, verdict, now);
      if (saved) summary.alertsSaved += 1;
      if (saved) {
        handledContractIds.add(dayKey(tradingDay, row.id));
        handledSetupKeys.add(dayKey(tradingDay, setup));
      }
      const delivered = await sendTelegram(formatAlert(row, volSummary, signal, reason, verdict, alertId, saved));
      if (delivered) alertsSent++;
      if (saved && delivered) {
        log.push(`${row.ticker}: Telegram alert sent and saved (${verdict.verdictLabel} ${verdict.grade})`);
      } else if (saved) {
        log.push(`${row.ticker}: saved in the alert book, but Telegram send failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID`);
      } else {
        const failure = await lastAlertBookWriteError();
        if (delivered) await noteAlertSentUnsaved(now);
        log.push(`${row.ticker}: Telegram alert ${delivered ? "sent" : "not sent"}, but the alert book was not saved${saveDetail(failure)}`);
      }
    }
    try {
      const openedLate = await openMissingShadows();
      noteShadows(summary, openedLate.opened, 0, 0, openedLate.saved);
      if (openedLate.opened > 0 && openedLate.saved) shadowAt = now.getTime();
      const shadow = await markShadows(now, log);
      noteShadows(summary, shadow.opened, shadow.quoted, shadow.closed, shadow.saved);
      if (shadowTouched(shadow) || (openedLate.opened > 0 && openedLate.saved)) shadowAt = now.getTime();
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      log.push("Shadow alert update failed");
    }
    summary.outcome = "success";
    await rememberScan("success", now, null, shadowAt);
  } catch (err) {
    if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) {
      console.warn(skipWarning(err.message));
      log.push(err.message);
      summary.outcome = "skipped";
      summary.reason = err.message;
      await rememberScan("skipped", now, err.message, shadowAt);
      console.info(formatScanRunLine(summary));
      return NextResponse.json({ alertsSent: 0, skipped: true, reason: err.message, log });
    }
    const message = err instanceof Error && err.message.startsWith("Schwab ")
      ? err.message.slice(0, 180)
      : "Estimated flow scan failed";
    console.warn(skipWarning(message));
    log.push(message);
    summary.outcome = "failed";
    summary.reason = message;
    try {
      const shadow = await markShadows(now, log);
      noteShadows(summary, shadow.opened, shadow.quoted, shadow.closed, shadow.saved);
      if (shadowTouched(shadow)) shadowAt = now.getTime();
    } catch {
      log.push("Shadow alert update failed");
    }
    await rememberScan("failed", now, message, shadowAt);
    console.info(formatScanRunLine(summary));
    return NextResponse.json({ error: message, log }, { status: 500 });
  }

  console.info(formatScanRunLine(summary));
  return NextResponse.json({ alertsSent, alertsSaved: summary.alertsSaved, log });
}

function emptySummary(outcome: ScanRunSummary["outcome"], reason: string | null = null): ScanRunSummary {
  return {
    outcome,
    tickers: 0,
    alertsSaved: 0,
    shadowsOpened: 0,
    shadowsMarked: 0,
    shadowsClosed: 0,
    reason,
  };
}

function noteShadows(
  summary: ScanRunSummary,
  opened: number,
  marked: number,
  closed: number,
  saved: boolean,
): void {
  if (!saved) return;
  summary.shadowsOpened += opened;
  summary.shadowsMarked += marked;
  summary.shadowsClosed += closed;
}

function shadowTouched(shadow: { opened: number; quoted: number; closed: number; saved: boolean }): boolean {
  return shadow.saved && (shadow.opened > 0 || shadow.quoted > 0 || shadow.closed > 0);
}

async function markShadows(now: Date, log: string[]): Promise<{ opened: number; quoted: number; closed: number; saved: boolean }> {
  const shadow = await runShadowPass(now);
  const saved = shadow.saved ? "saved" : "not saved";
  log.push(`Shadow alerts: ${shadow.opened} opened, ${shadow.quoted} quoted, ${shadow.closed} closed (${saved})`);
  return shadow;
}

/**
 * Hold the slot so Vercel cron and the GitHub Actions backup do not both call Schwab.
 * A manual run still waits if another pass is in progress, and it does not wait on a recent success.
 */
async function claimScanSlot(now: number, manual: boolean): Promise<"ok" | "busy" | "recent"> {
  const current = await readScanHealth().catch(() => emptyScanHealth());
  const decision = scanSlotDecision(current, now);
  if (decision === "busy") return "busy";
  if (decision === "recent" && !manual) return "recent";
  try {
    const wrote = await writeScanHealth({ ...current, runStartedAt: now });
    if (!wrote) return "ok";
    const confirmed = await readScanHealth();
    if (confirmed.runStartedAt !== now) return "busy";
  } catch {
    return "ok";
  }
  return "ok";
}

async function rememberScan(
  outcome: "success" | "skipped" | "failed",
  now: Date,
  reason: string | null,
  shadowAt: number | null,
): Promise<void> {
  try {
    const current = await readScanHealth().catch(() => emptyScanHealth());
    let tasty: { ok: boolean; status: number | null; message: string } | null = null;
    if (tastytradeEnabled()) {
      try {
        tasty = await probeTastytrade();
      } catch {
        tasty = null;
      }
    }
    const next: ScanHealth = {
      ...current,
      lastRunAt: now.getTime(),
      lastOutcome: outcome,
      lastReason: reason,
      lastSuccessAt: outcome === "success" ? now.getTime() : current.lastSuccessAt,
      lastShadowAt: shadowAt ?? current.lastShadowAt,
      tastytradeOk: tastytradeEnabled() ? (tasty ? tasty.ok : current.tastytradeOk) : null,
      tastytradeStatus: tastytradeEnabled() ? (tasty ? tasty.status : current.tastytradeStatus) : null,
      tastytradeCheckedAt: tastytradeEnabled() ? (tasty ? now.getTime() : current.tastytradeCheckedAt) : null,
      tastytradeMessage: !tastytradeEnabled()
        ? null
        : tasty && !tasty.ok
          ? tasty.message
          : tasty
            ? null
            : current.tastytradeMessage,
    };
    if (outcome === "skipped" && skipNotifyDue(current.skipNotifiedAt, now.getTime())) {
      const sent = await sendTelegramAlert(skipTelegramText(reason ?? "Schwab is not connected."));
      if (sent) next.skipNotifiedAt = now.getTime();
    }
    await writeScanHealth(next);
  } catch (err) {
    console.warn(skipWarning(err instanceof Error ? err.message : "Could not record the scan outcome"));
  }
}
