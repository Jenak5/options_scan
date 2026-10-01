const TG_API = "https://api.telegram.org/bot";

export function telegramConfigured(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  return token.length > 0 && chatId.length > 0;
}

export async function sendTelegramAlert(message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!telegramConfigured() || !token || !chatId) {
    console.warn("Telegram not configured — skipping alert");
    return false;
  }

  try {
    const res = await fetch(`${TG_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram send failed (${res.status}): ${err}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Telegram send error:", err);
    return false;
  }
}

export function formatFlowAlert(flow: {
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  notionalPremium: number | null;
  volume: number;
  openInterest: number;
  iv: number | null;
  side: string;
  otm: boolean | null;
  volumeExceedsOi: boolean;
  volOiRatio: number | null;
}): string {
  const emoji = flow.putCall === "call" ? "🟢" : "🔴";
  const type = flow.putCall === "call" ? "CALL" : "PUT";
  const premium = flow.notionalPremium ?? 0;
  const premiumStr = premium >= 1_000_000
    ? `$${(premium / 1_000_000).toFixed(1)}M`
    : `$${(premium / 1_000).toFixed(0)}K`;
  const flags = [
    flow.otm ? "OTM" : "",
    flow.volumeExceedsOi ? "VOL&gt;OI" : "",
  ].filter(Boolean).join(" · ");
  const ivPct = flow.iv != null && Number.isFinite(flow.iv)
    ? `${(flow.iv * 100).toFixed(1)}%`
    : "N/A";
  const ratio = flow.volOiRatio != null && Number.isFinite(flow.volOiRatio)
    ? `${flow.volOiRatio.toFixed(2)}x vol/OI`
    : "vol/OI n/a";

  return [
    `${emoji} <b>${escapeHtml(flow.ticker)}</b> ${type}`,
    `<b>Estimated flow</b> from Schwab volume/open interest, not a sweep.`,
    ``,
    `💰 <b>${premiumStr}</b> notional (volume × mid × 100)`,
    `📍 $${flow.strike} strike · ${escapeHtml(flow.expiration)}`,
    `📊 Vol: ${flow.volume.toLocaleString()} · OI: ${flow.openInterest.toLocaleString()} · IV: ${ivPct}`,
    `🧭 ${escapeHtml(flow.side)} · ${ratio}`,
    flags ? `🏷 ${flags}` : "",
    ``,
    `⏰ ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`,
  ].filter(Boolean).join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
