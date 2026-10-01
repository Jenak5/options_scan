import { NextRequest, NextResponse } from "next/server";
import { OUTCOME_RULES } from "@/app/lib/alertConfig";
import { runAlertFollowUps } from "@/app/lib/alertFollowUp";
import { currentDailyLoss, rememberSentAlert, wasSentToday } from "@/app/lib/alertStore";
import { hasValidBearer } from "@/app/lib/auth";
import { selectAlertRows, watchlistFromEnv, type FlowRow } from "@/app/lib/flow";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { isChicagoMarketHours, isChicagoMinuteWindow } from "@/app/lib/marketHours";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { formatVerdictHtml } from "@/app/lib/telegram";
import { gradeFlowRow, type AlertVerdict } from "@/app/lib/verdict";
import { formatVolArbSummary, type VolArbReading, type VolSignal } from "@/app/lib/volArb";
import { scanVolArb } from "@/app/lib/volScan";

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMATED ALERT CRON  — /api/cron
// Vercel cron hits this every 15 minutes from 13:30 through 21:00 UTC on
// weekdays (see vercel.json). That window covers Central market hours in
// both daylight and standard time. This handler then keeps only
// 8:30am–3:00pm America/Chicago, Monday–Friday.
//
// Auth is Authorization: Bearer <CRON_SECRET> only. A query secret is ignored.
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

// Best-effort in-memory dedup. A cold start can repeat an alert.
const alertedIds = new Set<string>();

const INDEX_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "XSP", "SPXW", "SPX", "VIX", "NDX", "RUT"]);

// ── Grok screening ────────────────────────────────────────────────────────
async function screenWithGrok(row: FlowRow, volSignal: string): Promise<{ clean: boolean; reason: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { clean: true, reason: "No XAI key — skipping screen" };

  const premium = row.notionalPremium ?? 0;
  const premStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;

  const prompt = `Estimated options flow (not a sweep) on ${row.ticker} ${(row.putCall).toUpperCase()}:
- Strike: $${row.strike}, Expiry: ${row.expiration}
- Notional (volume × mid × 100): ${premStr}
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

function formatAlert(row: FlowRow, volSummary: string, signal: VolSignal | null, grokNote: string, verdict: AlertVerdict): string {
  const premium = row.notionalPremium ?? 0;
  const premStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;
  const typeEmoji = row.putCall === "call" ? "🟢" : "🔴";
  const conviction = convictionFor(row.ticker, signal);

  const iv = row.iv != null ? `${(row.iv * 100).toFixed(0)}%` : "—";
  const oi = Number.isFinite(row.openInterest) ? row.openInterest.toLocaleString() : "—";
  const ratio = row.volOiRatio != null ? `${row.volOiRatio.toFixed(2)}x vol/OI` : "vol/OI n/a";

  return `${typeEmoji} <b>${row.ticker} ${row.putCall.toUpperCase()}</b>
${formatVerdictHtml(verdict)}

${conviction.emoji} <b>${conviction.tier}</b>
Estimated flow from Schwab volume/open interest, not a sweep.

💰 <b>${premStr}</b> notional
🎯 Strike <b>$${row.strike}</b> · Exp <b>${row.expiration}</b>
📊 ${escapeHtml(row.side)} · ${ratio} · IV ${iv} · OI ${oi}
📈 Vol Arb: <b>${escapeHtml(volSummary)}</b> — ${conviction.note}

🤖 <i>${escapeHtml(grokNote)}</i>

<b>Options Edge Scanner</b>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  if (!inSession && !closeWindow && !isManual) {
    return NextResponse.json({
      skipped: true,
      reason: "Outside Central market hours (8:30–15:00 America/Chicago)",
    });
  }

  const log: string[] = [];
  let alertsSent = 0;

  try {
    let followUps = { updated: 0, quoted: 0 };
    try {
      followUps = await runAlertFollowUps(now);
      log.push(`Follow-up quotes: ${followUps.quoted} requested, ${followUps.updated} records updated`);
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      log.push("Alert follow-up failed");
    }

    if (!inSession && !isManual) {
      return NextResponse.json({ alertsSent: 0, followUpOnly: true, followUps, log });
    }

    const losses = await currentDailyLoss(now);
    const scan = await scanEstimatedFlow({
      tickers: watchlistFromEnv(process.env.FLOW_WATCHLIST),
    });
    if (scan.errors.length > 0) {
      log.push(`Chain errors: ${scan.errors.map((item) => item.ticker).join(", ")}`);
    }
    log.push(`Scored ${scan.rows.length} contracts across ${scan.watchlist.length} tickers${scan.cached ? " (cached)" : ""}`);

    const minPremium = Number(process.env.ALERT_MIN_PREMIUM || "100000");
    const otmOnly = process.env.ALERT_OTM_ONLY === "true";
    const candidates = selectAlertRows(scan.rows, {
      minPremium: Number.isFinite(minPremium) ? minPremium : 100_000,
      otmOnly,
      limit: 40,
    }).filter((row) => !alertedIds.has(row.id));

    log.push(`Liquidity + premium filter passed ${candidates.length}`);

    const alertedThisRun = new Set<string>();
    const queued = candidates.slice(0, 8);
    const volByTicker = new Map<string, VolArbReading>();
    const volMiss = new Map<string, string>();
    const symbols: string[] = [];
    const seenTickers = new Set<string>();
    for (let i = 0; i < queued.length; i++) {
      const ticker = queued[i].ticker;
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

    for (const row of queued) {
      if (alertedThisRun.has(row.ticker)) {
        log.push(`${row.ticker}: skipped — already alerted this run`);
        continue;
      }
      if (await wasSentToday(row.id, now)) {
        alertedIds.add(row.id);
        log.push(`${row.ticker}: skipped — this contract was already saved today`);
        continue;
      }

      const reading = volByTicker.get(row.ticker) ?? null;
      const volSummary = reading
        ? formatVolArbSummary(reading)
        : (volMiss.get(row.ticker) ?? "Schwab did not return a vol reading for this symbol.");
      const signal = reading && reading.signal !== "NO_READ" ? reading.signal : null;
      log.push(`${row.ticker}: vol ${volSummary}`);

      const { clean, reason } = await screenWithGrok(row, volSummary);
      alertedIds.add(row.id);

      if (!clean) {
        log.push(`${row.ticker}: Grok flagged — ${reason}`);
        continue;
      }
      log.push(`${row.ticker}: Grok clean — ${reason}`);

      const verdict = gradeFlowRow(row, losses);
      const sent = await sendTelegram(formatAlert(row, volSummary, signal, reason, verdict));
      if (sent) {
        alertsSent++;
        alertedThisRun.add(row.ticker);
        const saved = await rememberSentAlert(row, verdict, now);
        log.push(saved
          ? `${row.ticker}: Telegram alert sent and saved (${verdict.verdictLabel} ${verdict.grade})`
          : `${row.ticker}: Telegram alert sent, but the alert book was not saved`);
      } else {
        log.push(`${row.ticker}: Telegram send failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID`);
      }
    }
  } catch (err) {
    if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) {
      log.push(err.message);
      return NextResponse.json({ alertsSent: 0, skipped: true, reason: err.message, log });
    }
    const message = err instanceof Error && err.message.startsWith("Schwab ")
      ? err.message.slice(0, 180)
      : "Estimated flow scan failed";
    log.push(message);
    return NextResponse.json({ error: message, log }, { status: 500 });
  }

  return NextResponse.json({ alertsSent, log });
}
