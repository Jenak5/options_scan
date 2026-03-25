import { NextRequest, NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMATED ALERT CRON  — /api/cron
// Runs every 15 minutes via Vercel cron (see vercel.json)
// Only processes during market hours: 9:30am–4:00pm ET, Mon–Fri
//
// Required Vercel environment variables:
//   UNUSUAL_WHALES_API_TOKEN  — UW API key
//   TASTYTRADE_*              — already configured
//   XAI_API_KEY               — Grok for screening
//   TELEGRAM_BOT_TOKEN        — from @BotFather
//   TELEGRAM_CHAT_ID          — your chat ID with @PeachClawbot
//   CRON_SECRET               — any random string, protects the endpoint
// ═══════════════════════════════════════════════════════════════════════════

const UW_BASE = "https://api.unusualwhales.com/api";
const XAI_API = "https://api.x.ai/v1/chat/completions";
const TG_API  = (token: string) => `https://api.telegram.org/bot${token}`;

// ── Deduplication ─────────────────────────────────────────────────────────
// Best-effort in-memory dedup. Vercel cold starts reset this, so we use
// a combo of ID tracking + Grok screening to avoid repeat alerts.
const alertedIds = new Set<string>();

// ── Market hours check (ET) ───────────────────────────────────────────────
function isMarketHours(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const month  = now.getUTCMonth() + 1;
  const offset = (month >= 3 && month <= 11) ? 4 : 5;
  const etTime = (now.getUTCHours() - offset) * 60 + now.getUTCMinutes();
  return etTime >= 570 && etTime < 960; // 9:30–4:00
}

// ── UW API helper ─────────────────────────────────────────────────────────
async function uwFetch(path: string, params?: Record<string, string>) {
  const url = new URL(`${UW_BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${process.env.UNUSUAL_WHALES_API_TOKEN}`,
      "UW-CLIENT-API-ID": "100001",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`UW API (${res.status})`);
  return res.json();
}

// ── Tastytrade token (fetched once per cron run) ──────────────────────────
async function getTTToken(): Promise<string | null> {
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
    if (!res.ok) return null;
    const data = await res.json();
    return data["access-token"] ?? data.access_token ?? null;
  } catch {
    return null;
  }
}

// ── Tastytrade vol arb helper ─────────────────────────────────────────────
async function getVolSignal(ticker: string, token: string): Promise<string> {
  try {
    const ttBase = process.env.TASTYTRADE_ENV === "production"
      ? "https://api.tastyworks.com"
      : "https://api.cert.tastyworks.com";
    const metricsRes = await fetch(`${ttBase}/market-metrics?symbols=${ticker}`, {
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
async function screenWithGrok(alert: any, volSignal: string): Promise<{ clean: boolean; reason: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { clean: true, reason: "No XAI key — skipping screen" };

  const premium = parseFloat(alert.total_premium ?? "0");
  const premStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;

  const askPrem = parseFloat(alert.total_ask_side_prem ?? "0");
  const bidPrem = parseFloat(alert.total_bid_side_prem ?? "0");
  const ratioStr = (askPrem + bidPrem) > 0
    ? `${((askPrem / (askPrem + bidPrem)) * 100).toFixed(0)}%`
    : "unknown";

  const prompt = `A ${(alert.type ?? "").toUpperCase()} sweep just hit on ${alert.ticker}:
- Strike: $${alert.strike}, Expiry: ${alert.expiry}
- Premium: ${premStr}, Ask-side ratio: ${ratioStr}
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

// ── Format Telegram message ───────────────────────────────────────────────
function formatAlert(alert: any, volSignal: string, grokNote: string): string {
  const premium = parseFloat(alert.total_premium ?? "0");
  const premStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;

  const askPrem = parseFloat(alert.total_ask_side_prem ?? "0");
  const bidPrem = parseFloat(alert.total_bid_side_prem ?? "0");
  const ratio   = (askPrem + bidPrem) > 0
    ? `${((askPrem / (askPrem + bidPrem)) * 100).toFixed(0)}% ask-side`
    : "side unknown";

  const typeEmoji = (alert.type ?? "").toLowerCase() === "call" ? "🟢" : "🔴";

  // Index ETFs (SPY, QQQ, IWM) may be hedges — flag them
  const isIndexETF = ["SPY","QQQ","IWM","DIA","XSP"].includes((alert.ticker ?? "").toUpperCase());

  const conviction =
    isIndexETF               ? { emoji: "⚠️",  tier: "POSSIBLE HEDGE",   note: "Index ETF — could be portfolio hedge, not directional. Verify before trading." } :
    volSignal === "BUY FRIENDLY" ? { emoji: "✅", tier: "HIGH CONVICTION",  note: "Sweep + cheap vol — best setup" } :
    volSignal === "BUY VOL"      ? { emoji: "⚡", tier: "HIGH CONVICTION",  note: "Sweep + underpriced vol — rare edge" } :
    volSignal === "CAUTION"      ? { emoji: "⚠️",  tier: "MEDIUM",           note: "Good sweep but vol not cheap — size smaller" } :
    volSignal === "NEUTRAL"      ? { emoji: "🔵", tier: "MEDIUM",           note: "Good sweep, neutral vol — use flow as primary signal" } :
    volSignal === "EXPENSIVE"    ? { emoji: "🔴", tier: "LOW — SKIP",       note: "Overpaying for vol — flow looks good but options are pricey" } :
                                   { emoji: "❓", tier: "UNSCORED",          note: "Vol data unavailable" };

  const iv = alert.iv_start ? `${(parseFloat(alert.iv_start) * 100).toFixed(0)}%` : "—";
  const oi  = alert.open_interest ? Number(alert.open_interest).toLocaleString() : "—";

  return `${typeEmoji} <b>${alert.ticker} ${(alert.type ?? "").toUpperCase()} SWEEP</b>
${conviction.emoji} <b>${conviction.tier}</b>

💰 <b>${premStr}</b> premium
🎯 Strike <b>$${alert.strike}</b> · Exp <b>${alert.expiry ?? "?"}</b>
📊 ${ratio} · IV ${iv} · OI ${oi}
📈 Vol Arb: <b>${volSignal}</b> — ${conviction.note}

🤖 <i>${grokNote}</i>

<b>Options Edge Scanner</b>`;
}

// ── Telegram sender ───────────────────────────────────────────────────────
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
  const secret = request.headers.get("x-cron-secret") ??
                 request.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isManual = request.nextUrl.searchParams.get("manual") === "true";
  if (!isMarketHours() && !isManual) {
    return NextResponse.json({ skipped: true, reason: "Outside market hours" });
  }

  const log: string[] = [];
  let alertsSent = 0;

  try {
    // ── 1. Fetch flow ─────────────────────────────────────────────────────
    const flowData  = await uwFetch("/option-trades/flow-alerts", {
      limit:       "50",
      min_premium: "50000",
    });
    const allAlerts: any[] = flowData.data ?? [];
    log.push(`Fetched ${allAlerts.length} flow alerts`);

    // ── 2. Filter: sweep + opening + ask-side ─────────────────────────────
    // Debug mode: pass ?debug=true to see why each alert was filtered
    const isDebug = request.nextUrl.searchParams.get("debug") === "true";
    let notSweep = 0, isClosing = 0, bidSide = 0, duped = 0;

    const candidates = allAlerts.filter((f) => {
      const id = f.id ?? `${f.ticker}-${f.strike}-${f.expiry}-${f.total_premium}`;
      if (alertedIds.has(id)) { duped++; return false; }

      // Filter pure index hedge products — SPXW is almost exclusively institutional hedging
      const ticker = (f.ticker ?? "").toUpperCase();
      if (ticker === "SPXW" || ticker === "SPX" || ticker === "VIX") { notSweep++; return false; }

      // Accept sweeps AND repeated hits (equal conviction — repeated fills at same strike)
      const rule = (f.alert_rule ?? "").toLowerCase();
      const isSweep = f.has_sweep || f.is_sweep ||
                      rule.includes("sweep") ||
                      rule.includes("repeatedhits") ||
                      rule.includes("repeated_hits");
      if (!isSweep) { notSweep++; return false; }

      // Only block if explicitly closing AND vol/OI confirms it (ratio < 0.5)
      // null opening = unknown = let it through
      const volOi = parseFloat(f.volume_oi_ratio ?? "1");
      if (f.all_opening_trades === false && volOi < 0.5) { isClosing++; return false; }

      const askP = parseFloat(f.total_ask_side_prem ?? "0");
      const bidP = parseFloat(f.total_bid_side_prem ?? "0");
      const sum  = askP + bidP;
      if (sum > 0 && (askP / sum) < 0.65) { bidSide++; return false; }

      return true;
    });

    log.push(`Filter breakdown — not a sweep: ${notSweep} | closing: ${isClosing} | bid-side: ${bidSide} | duped: ${duped} | passed: ${candidates.length}`);

    if (isDebug && candidates.length === 0) {
      // Show sample of raw alerts so we can see actual field values
      const sample = allAlerts.slice(0, 3).map(f => {
        const askP = parseFloat(f.total_ask_side_prem ?? "0");
        const bidP = parseFloat(f.total_bid_side_prem ?? "0");
        const sum  = askP + bidP;
        const ratio = sum > 0 ? ((askP/sum)*100).toFixed(0)+"%" : "no split data";
        const isSweep = f.has_sweep || f.is_sweep || (f.alert_rule ?? "").toLowerCase().includes("sweep");
        return `${f.ticker} ${(f.type??"")} $${f.strike} | sweep:${isSweep} opening:${f.all_opening_trades} ask-side:${ratio} rule:${f.alert_rule??"-"}`;
      });
      log.push("Sample alerts: " + sample.join(" || "));
    }

    // ── 3. Vol arb + Grok screen + alert ─────────────────────────────────
    // Fetch Tastytrade token once — reuse for all candidates this run
    const ttToken = await getTTToken();
    if (!ttToken) log.push("Warning: Tastytrade token unavailable — vol signals will show UNKNOWN");

    for (const alert of candidates.slice(0, 5)) {
      const id = alert.id ?? `${alert.ticker}-${alert.strike}-${alert.expiry}-${alert.total_premium}`;

      // Vol arb — skip for index ETFs, use shared token for individual stocks
      const isIdx = ["SPY","QQQ","IWM","DIA","XSP"].includes((alert.ticker ?? "").toUpperCase());
      const volSignal = isIdx ? "INDEX ETF" : ttToken ? await getVolSignal(alert.ticker, ttToken) : "UNKNOWN";
      log.push(`${alert.ticker}: vol signal ${volSignal}`);

      // Grok red flag screen
      const { clean, reason } = await screenWithGrok(alert, volSignal);
      alertedIds.add(id);

      if (!clean) {
        log.push(`${alert.ticker}: Grok flagged — ${reason}`);
        continue;
      }
      log.push(`${alert.ticker}: Grok clean — ${reason}`);

      // Send
      const message = formatAlert(alert, volSignal, reason);
      const sent    = await sendTelegram(message);

      if (sent) {
        alertsSent++;
        log.push(`${alert.ticker}: ✅ Telegram alert sent`);
      } else {
        log.push(`${alert.ticker}: ❌ Telegram send failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID`);
      }
    }

  } catch (err: any) {
    log.push(`Error: ${err.message}`);
    return NextResponse.json({ error: err.message, log }, { status: 500 });
  }

  return NextResponse.json({ alertsSent, log });
}
