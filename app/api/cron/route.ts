import { NextRequest, NextResponse } from "next/server";
import { hasValidBearer } from "@/app/lib/auth";
import { selectAlertRows, watchlistFromEnv, type FlowRow } from "@/app/lib/flow";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { isChicagoMarketHours } from "@/app/lib/marketHours";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";

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
//   TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN  — OAuth, read-only
//   XAI_API_KEY               — Grok for screening
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   CRON_SECRET
//   Schwab market data + token store (already used by the Gate)
// ═══════════════════════════════════════════════════════════════════════════

const XAI_API = "https://api.x.ai/v1/chat/completions";
const TG_API  = (token: string) => `https://api.telegram.org/bot${token}`;

// Best-effort in-memory dedup. A cold start can repeat an alert.
const alertedIds = new Set<string>();

const INDEX_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "XSP", "SPXW", "SPX", "VIX", "NDX", "RUT"]);

// ── Tastytrade token (fetched once per cron run) ──────────────────────────
async function getTTToken(): Promise<{ token: string | null; error: string }> {
  try {
    const ttBase = process.env.TASTYTRADE_ENV === "production"
      ? "https://api.tastyworks.com"
      : "https://api.cert.tastyworks.com";
    const res = await fetch(`${ttBase}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: process.env.TASTYTRADE_REFRESH_TOKEN ?? "",
        client_id:     "tastytrade-web",
        client_secret: process.env.TASTYTRADE_CLIENT_SECRET ?? "",
      }),
    });
    if (!res.ok) {
      return { token: null, error: `TT token HTTP ${res.status}` };
    }
    const data = await res.json();
    const token = data["access-token"] ?? data.access_token ?? null;
    if (!token) return { token: null, error: "TT token response missing access-token field" };
    return { token, error: "" };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "TT token exception";
    return { token: null, error: `TT token exception: ${message}` };
  }
}

// ── Tastytrade vol arb helper ─────────────────────────────────────────────
async function getVolSignal(ticker: string, token: string): Promise<string> {
  try {
    const ttBase = process.env.TASTYTRADE_ENV === "production"
      ? "https://api.tastyworks.com"
      : "https://api.cert.tastyworks.com";
    const metricsRes = await fetch(`${ttBase}/market-metrics?symbols=${encodeURIComponent(ticker)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "options-edge-scanner/1.0",
      },
    });
    if (!metricsRes.ok) return "UNKNOWN";
    const metricsData = await metricsRes.json();
    const d = metricsData?.data?.items?.[0] ?? metricsData?.data?.[0];
    if (!d) return "UNKNOWN";

    const iv      = parseFloat(d["implied-volatility-30-day"] ?? "0");
    const hv      = parseFloat(d["historical-volatility-30-day"] ?? "0");
    const rankRaw = parseFloat(d["implied-volatility-index-rank"] ?? "0.5");
    const ivRank  = rankRaw <= 1 ? rankRaw * 100 : rankRaw;
    const spread  = parseFloat(d["iv-hv-30-day-difference"] ?? String(iv - hv));

    if (ivRank < 25 && spread < 10)  return "BUY FRIENDLY";
    if (ivRank < 25 && spread >= 10) return "CAUTION";
    if (spread < 0)                  return "BUY VOL";
    if (spread > 20)                 return "EXPENSIVE";
    return "NEUTRAL";
  } catch {
    return "UNKNOWN";
  }
}

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

function formatAlert(row: FlowRow, volSignal: string, grokNote: string): string {
  const premium = row.notionalPremium ?? 0;
  const premStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;
  const typeEmoji = row.putCall === "call" ? "🟢" : "🔴";
  const isIndexETF = INDEX_ETFS.has(row.ticker);

  const conviction =
    isIndexETF                   ? { emoji: "⚠️", tier: "POSSIBLE HEDGE",  note: "Index ETF — could be a portfolio hedge, not directional. Verify before trading." } :
    volSignal === "BUY FRIENDLY" ? { emoji: "✅", tier: "HIGH CONVICTION", note: "Estimated flow + cheap vol" } :
    volSignal === "BUY VOL"      ? { emoji: "⚡", tier: "HIGH CONVICTION", note: "Estimated flow + underpriced vol" } :
    volSignal === "CAUTION"      ? { emoji: "⚠️", tier: "MEDIUM",          note: "Flow estimate is active but vol is not cheap" } :
    volSignal === "NEUTRAL"      ? { emoji: "🔵", tier: "MEDIUM",          note: "Neutral vol — the volume estimate is the signal" } :
    volSignal === "EXPENSIVE"    ? { emoji: "🔴", tier: "LOW — SKIP",      note: "Options look expensive versus realized vol" } :
                                   { emoji: "❓", tier: "UNSCORED",         note: "Vol data unavailable" };

  const iv = row.iv != null ? `${(row.iv * 100).toFixed(0)}%` : "—";
  const oi = Number.isFinite(row.openInterest) ? row.openInterest.toLocaleString() : "—";
  const ratio = row.volOiRatio != null ? `${row.volOiRatio.toFixed(2)}x vol/OI` : "vol/OI n/a";

  return `${typeEmoji} <b>${row.ticker} ${row.putCall.toUpperCase()}</b>
${conviction.emoji} <b>${conviction.tier}</b>
Estimated flow from Schwab volume/open interest, not a sweep.

💰 <b>${premStr}</b> notional
🎯 Strike <b>$${row.strike}</b> · Exp <b>${row.expiration}</b>
📊 ${escapeHtml(row.side)} · ${ratio} · IV ${iv} · OI ${oi}
📈 Vol Arb: <b>${escapeHtml(volSignal)}</b> — ${conviction.note}

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
  if (!isChicagoMarketHours() && !isManual) {
    return NextResponse.json({
      skipped: true,
      reason: "Outside Central market hours (8:30–15:00 America/Chicago)",
    });
  }

  const log: string[] = [];
  let alertsSent = 0;

  try {
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

    const { token: ttToken, error: ttError } = await getTTToken();
    if (!ttToken) log.push(`Warning: Tastytrade token failed — ${ttError}`);
    else log.push("Tastytrade token OK");

    const alertedThisRun = new Set<string>();

    for (const row of candidates.slice(0, 8)) {
      if (alertedThisRun.has(row.ticker)) {
        log.push(`${row.ticker}: skipped — already alerted this run`);
        continue;
      }

      const isIdx = INDEX_ETFS.has(row.ticker);
      const volSignal = isIdx ? "INDEX ETF" : ttToken ? await getVolSignal(row.ticker, ttToken) : "UNKNOWN";
      log.push(`${row.ticker}: vol signal ${volSignal}`);

      const { clean, reason } = await screenWithGrok(row, volSignal);
      alertedIds.add(row.id);

      if (!clean) {
        log.push(`${row.ticker}: Grok flagged — ${reason}`);
        continue;
      }
      log.push(`${row.ticker}: Grok clean — ${reason}`);

      const sent = await sendTelegram(formatAlert(row, volSignal, reason));
      if (sent) {
        alertsSent++;
        alertedThisRun.add(row.ticker);
        log.push(`${row.ticker}: Telegram alert sent`);
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
