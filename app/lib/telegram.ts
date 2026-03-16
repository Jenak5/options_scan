const TG_API = "https://api.telegram.org/bot";

export async function sendTelegramAlert(message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
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
  option_type: string;
  strike_price: number;
  expiration_date: string;
  premium: number;
  volume: number;
  open_interest: number;
  implied_volatility: number;
  is_sweep: boolean;
  is_otm: boolean;
  sentiment?: string;
}): string {
  const emoji = flow.option_type === "C" ? "🟢" : "🔴";
  const type = flow.option_type === "C" ? "CALL" : "PUT";
  const premiumK = (flow.premium / 1000).toFixed(0);
  const flags = [
    flow.is_sweep ? "⚡ SWEEP" : "",
    flow.is_otm ? "🎯 OTM" : "",
    flow.volume > flow.open_interest ? "🆕 NEW POSITION" : "",
  ].filter(Boolean).join(" · ");

  const ivPct = flow.implied_volatility
    ? `${(flow.implied_volatility * 100).toFixed(1)}%`
    : "N/A";

  return [
    `${emoji} <b>${flow.ticker}</b> ${type}`,
    ``,
    `💰 <b>$${premiumK}K</b> premium`,
    `📍 $${flow.strike_price} strike · ${flow.expiration_date}`,
    `📊 Vol: ${flow.volume?.toLocaleString()} · OI: ${flow.open_interest?.toLocaleString()} · IV: ${ivPct}`,
    flags ? `🏷 ${flags}` : "",
    ``,
    `⏰ ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`,
  ].filter(Boolean).join("\n");
}

export function formatDarkPoolAlert(print: {
  ticker: string;
  price: number;
  size: number;
  executed_at: string;
}): string {
  const notional = print.price * print.size;
  const notionalStr = notional >= 1_000_000
    ? `$${(notional / 1_000_000).toFixed(1)}M`
    : `$${(notional / 1000).toFixed(0)}K`;

  return [
    `🌊 <b>DARK POOL</b> — ${print.ticker}`,
    ``,
    `💰 <b>${notionalStr}</b> notional`,
    `📍 ${print.size.toLocaleString()} shares @ $${print.price.toFixed(2)}`,
    `⏰ ${new Date(print.executed_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
  ].join("\n");
}

export function shouldAlert(flow: {
  premium: number;
  is_sweep: boolean;
  is_otm: boolean;
  volume: number;
  open_interest: number;
}): boolean {
  const minPremium = parseInt(process.env.ALERT_MIN_PREMIUM || "100000");
  const sweepsOnly = process.env.ALERT_SWEEPS_ONLY === "true";
  const otmOnly = process.env.ALERT_OTM_ONLY === "true";

  if (flow.premium < minPremium) return false;
  if (sweepsOnly && !flow.is_sweep) return false;
  if (otmOnly && !flow.is_otm) return false;

  let score = 0;
  if (flow.premium >= 1_000_000) score += 30;
  else if (flow.premium >= 500_000) score += 25;
  else if (flow.premium >= 100_000) score += 15;
  if (flow.is_sweep) score += 20;
  if (flow.is_otm) score += 10;
  if (flow.open_interest > 0 && flow.volume > flow.open_interest) score += 15;

  return score >= 25;
}
