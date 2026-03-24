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

const UW_BASE  = "https://api.unusualwhales.com/api";
const XAI_API  = "https://api.x.ai/v1/chat/completions";
const TG_API   = (token: string) => `https://api.telegram.org/bot${token}`;

// ── Deduplication — track alerted flow IDs in memory ─────────────────────
// Vercel functions can be cold-started, so this is a best-effort dedupe.
// We also use a 20-min timestamp window as a second layer.
const alertedIds = new Set<string>();

// ── Market hours check (ET) ───────────────────────────────────────────────
function isMarketHours(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;

  // Convert UTC to ET (UTC-5 standard, UTC-4 daylight)
  // Simple approximation: use UTC-4 (EDT) for March–Nov, UTC-5 (EST) otherwise
  const month = now.getUTCMonth() + 1;
  const offset = (month >= 3 && month <= 11) ? 4 : 5;
  const etHour   = now.getUTCHours() - offset;
  const etMinute = now.getUTCMinutes();
  const etTime   = etHour * 60 + etMinute;

  const open  = 9 * 60 + 30;  // 9:30 AM
  const close = 16 * 60;      // 4:00 PM

  return etTime >= open && etTime < close;
}

// ── UW API helper ─────────────────────────────────────────────────────────
async function uwFetch(path: string, params?: Record<string, string>) {
  const url = new URL(`${UW_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  }
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

// ── Tastytrade vol arb helper ─────────────────────────────────────────────
async function getVolSignal(ticker: string): Promise<"BUY FRIENDLY" | "CAUTION" | "BUY VOL" | "EXPENSIVE" | "NEUTRAL" | null> {
  try {
    const ttBase = process.env.TASTYTRADE_ENV === "production"
      ? "https://api.tastyworks.com"
      : "https://api.cert.tastyworks.com";

    // Get cached token from env or refresh — reuse the existing tastytrade lib pattern
    // For cron we just call the metrics endpoint directly with a fresh token
    const tokenRes = await fetch(`${ttBase}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: process.env.TASTYTRADE_REFRESH_TOKEN ?? "",
        client_id:     "tastytrade-web",
        client_secret: process.env.TASTYTRADE_CLIENT_SECRET ?? "",
      }),
    });
    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json();
    const token = tokenData["access-token"] ?? tokenData.access_token;
    if (!token) return null;

    const metricsRes = await fetch(`${ttBase}/market-metrics?symbols=${ticker}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "options-edge-scanner/1.0",
      },
    });
    if (!metricsRes.ok) return null;
    const metricsData = await metricsRes.json();
    const d = metricsData?.data?.items?.[0] ?? metricsData?.data?.[0];
    if (!d) return null;

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
    return null;
  }
}

// ── Grok screening — check for red flags ─────────────────────────────────
async function screenWithGrok(alert: any, volSignal: string): Promise<{ clean: boolean; reason: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { clean: true, reason: "No XAI key — skipping screen" };

  const premium = parseFloat(alert.total_premium ?? "0");
  const premStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;

  const prompt = `A ${(alert.type ?? "").toUpperCase()} sweep just hit on ${alert.ticker}:
- Strike: $${alert.strike}, Expiry: ${alert.expiry}
- Premium: ${premStr}, Ask-side ratio: ${alert.total_ask_side_prem && alert.total_bid_side_prem
    ? ((parseFloat(alert.total_ask_side_prem) / (parseFloat(alert.total_ask_side_prem) + parseFloat(alert.total_bid_side_prem))) * 100).toFixed(0) + "%"
    : "unknown"}
- Vol Arb signal: ${volSignal}

In 1-2 sentences: are there any obvious red flags that would make this setup dangerous RIGHT NOW? (earnings tomorrow, FDA decision, major news event, stock in freefall, etc.) If no red flags, just say "No red flags."`;

  try {
    const res = await fetch(XAI_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-3-fast",
        max_tokens: 150,
        messages: [
          { role: "system", content: "You are a risk screener for options trades. Be brief and direct. Only flag genuine near-term risks." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) return { clean: true, reason: "Grok unavailable" };
    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? "";
    const hasRedFlag = !text.toLowerCase().includes("no red flag") &&
                       (text.toLowerCase().includes("earnings") ||
                        text.toLowerCase().includes("fda") ||
                        text.toLowerCase().includes("danger") ||
                        text.toLowerCase().includes("warning") ||
                        text.toLowerCase().includes("avoid") ||
                        text.toLowerCase().includes("risky") ||
                        text.toLowerCase().includes("caution"));
    return { clean: !hasRedFlag, reason: text.trim() };
  } catch {
    return { clean: true, reason: "Screen error — proceeding" };
  }
}

// ── Telegram alert ────────────────────────────────────────────────────────
async function sendTelegram(message: string): Promise<boolean> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    const res = await fetch(`${TG_API(token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       message,
        parse_mode: "HTML",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function formatAlert(alert: any, volSignal: string, grokNote: string): string {
  const premium = parseFloat(alert.total_premium ?? "0");
  const premStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;

  const askPrem = parseFloat(alert.total_ask_side_prem ?? "0");
  const bidPrem = parseFloat(alert.total_bid_side_prem ?? "0");
  const ratio   = (askPrem + bidPrem) > 0
    ? ((askPrem / (askPrem + bidPrem)) * 100).toFixed(0) + "% ask-side"
    : "";

  const typeEmoji = (alert.type ?? "").toLowerCase() === "call" ? "🟢" : "🔴";

  // Conviction tier based on vol arb signal
  const conviction =
    volSignal === "BUY FRIENDLY" ? { emoji: "✅", tier: "HIGH CONVICTION",  note: "Sweep + cheap vol — best setup" } :
    volSignal === "BUY VOL"      ? { emoji: "⚡", tier: "HIGH CONVICTION",  note: "Sweep + underpriced vol — rare edge" } :
    volSignal === "CAUTION"      ? { emoji: "⚠️", tier: "MEDIUM",           note: "Good sweep but vol not cheap — size smaller" } :
    volSignal === "NEUTRAL"      ? { emoji: "🔵", tier: "MEDIUM",           note: "Good sweep, neutral vol — use flow as primary signal" } :
    volSignal === "EXPENSIVE"    ? { emoji: "🔴", tier: "LOW — SKIP",       note: "Overpaying for vol — flow looks good but options are pricey" } :
                                   { emoji: "❓", tier: "UNSCORED",          note: "Vol data unavailable" };

  return `${typeEmoji} <b>${alert.ticker} ${(alert.type ?? "").toUpperCase()} SWEEP</b>
${conviction.emoji} <b>${conviction.tier}</b>

💰 <b>${premStr}</b> premium
🎯 Strike <b>$${alert.strike}</b> · Exp <b>${alert.expiry ?? "?"}</b>
📊 ${ratio}
📈 Vol Arb: <b>${volSignal}</b> — ${conviction.note}

🤖 <i>${grokNote}</i>

<b>Options Edge Scanner</b>`;
}

// ── Main handler ──────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  // Verify cron secret to prevent unauthorized calls
  const secret = request.headers.get("x-cron-secret") ??
                 request.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Skip outside market hours — unless this is a manual test
  const isManual = request.nextUrl.searchParams.get("manual") === "true";
  if (!isMarketHours() && !isManual) {
    return NextResponse.json({ skipped: true, reason: "Outside market hours" });
  }

  const log: string[] = [];
  let alertsSent = 0;

  try {
    // ── 1. Fetch recent flow alerts ───────────────────────────────────────
    const flowData = await uwFetch("/option-trades/flow-alerts", {
      limit: "50",
      min_premium: "50000",
    });
    const allAlerts: any[] = flowData.data ?? [];
    log.push(`Fetched ${allAlerts.length} flow alerts`);

    // ── 2. Filter: sweep + opening + ask-side ─────────────────────────────
    // Also filter to alerts from the last 20 minutes (fresh only)
    const cutoff = Date.now() - 20 * 60 * 1000;
    const candidates = allAlerts.filter((f) => {
      // Dedup
      const id = f.id ?? `${f.ticker}-${f.strike}-${f.expiry}-${f.total_premium}`;
      if (alertedIds.has(id)) return false;

      // Freshness — use created_at or updated_at if available
      if (f.created_at) {
        const ts = new Date(f.created_at).getTime();
        if (ts < cutoff) return false;
      }

      // Must be a sweep
      const isSweep = f.has_sweep || f.is_sweep ||
                      (f.alert_rule ?? "").toLowerCase().includes("sweep");
      if (!isSweep) return false;

      // Must be opening
      if (f.all_opening_trades === false) return false;

      // Must be ask-side (ratio ≥ 0.65)
      const askP = parseFloat(f.total_ask_side_prem ?? "0");
      const bidP = parseFloat(f.total_bid_side_prem ?? "0");
      const sum  = askP + bidP;
      if (sum > 0 && (askP / sum) < 0.65) return false;

      return true;
    });

    log.push(`${candidates.length} candidates after sweep/opening/ask-side filter`);

    // ── 3. For each candidate, check vol arb then screen with Grok ────────
    for (const alert of candidates.slice(0, 5)) { // cap at 5 per run
      const id = alert.id ?? `${alert.ticker}-${alert.strike}-${alert.expiry}-${alert.total_premium}`;

      // Vol arb — fetch for context but never block the alert
      const volSignal = await getVolSignal(alert.ticker) ?? "UNKNOWN";
      log.push(`${alert.ticker}: vol signal ${volSignal}`);

      // Grok red flag screen
      const { clean, reason } = await screenWithGrok(alert, volSignal);
      if (!clean) {
        log.push(`${alert.ticker}: Grok flagged — ${reason}`);
        alertedIds.add(id); // still mark as seen so we don't re-screen
        continue;
      }
      log.push(`${alert.ticker}: Grok clean — ${reason}`);

      // Send Telegram alert
      const message = formatAlert(alert, volSignal, reason);
      const sent    = await sendTelegram(message);
      alertedIds.add(id);

      if (sent) {
        alertsSent++;
        log.push(`${alert.ticker}: ✅ Telegram alert sent`);
      } else {
        log.push(`${alert.ticker}: ❌ Telegram send failed`);
      }
    }

  } catch (err: any) {
    log.push(`Error: ${err.message}`);
    return NextResponse.json({ error: err.message, log }, { status: 500 });
  }

  return NextResponse.json({ alertsSent, log });
}
