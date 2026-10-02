import { formatContractPriceLine, formatFlowPremium } from "@/app/lib/alertConfig";
import { planExitsForAsk } from "@/app/lib/exits";
import { formatLevelsSummary, type StoredPriceLevels } from "@/app/lib/levels";

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

export function formatVerdictHtml(verdict: {
  grade: string;
  verdictLabel: string;
  note: string;
  reasons: string[];
  levels: StoredPriceLevels | null;
  levelsNote: string | null;
  eventLine?: string | null;
}): string {
  const lines = [
    `<b>${escapeHtml(verdict.grade)} · ${escapeHtml(verdict.verdictLabel)}</b>`,
    escapeHtml(verdict.note),
    ...verdict.reasons.map((reason) => `• ${escapeHtml(reason)}`),
  ];
  if (verdict.levels) lines.push(escapeHtml(formatLevelsSummary(verdict.levels)));
  if (verdict.levelsNote) lines.push(escapeHtml(verdict.levelsNote));
  if (verdict.eventLine) lines.push(escapeHtml(verdict.eventLine));
  return lines.join("\n");
}

/**
 * Absolute link that opens the Trade Log for one saved alert.
 * APP_ORIGIN wins. Otherwise the Vercel production host. Otherwise this app's public alias.
 */
export function paperTradeUrl(alertId: string): string | null {
  const id = alertId.trim();
  if (!/^[A-Za-z0-9_.:|-]{4,120}$/.test(id)) return null;
  return `${appOrigin()}/trades?alert=${encodeURIComponent(id)}`;
}

export function paperTradeLinkHtml(alertId: string): string {
  const url = paperTradeUrl(alertId);
  if (!url) return "";
  return `<a href="${escapeHtml(url)}">Paper trade</a>`;
}

function appOrigin(): string {
  const explicit = (process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (explicit) return stripOrigin(explicit);
  const production = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (production) return stripOrigin(production.includes("://") ? production : `https://${production}`);
  const vercel = (process.env.VERCEL_URL ?? "").trim();
  if (vercel) return stripOrigin(vercel.includes("://") ? vercel : `https://${vercel}`);
  return "https://options-scan.vercel.app";
}

function stripOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

export function formatFlowAlert(flow: {
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  ask: number;
  notionalPremium: number | null;
  volume: number;
  openInterest: number;
  iv: number | null;
  side: string;
  otm: boolean | null;
  volumeExceedsOi: boolean;
  volOiRatio: number | null;
  prints?: { summary: string | null } | null;
  verdict?: {
    grade: string;
    verdictLabel: string;
    note: string;
    reasons: string[];
    levels: StoredPriceLevels | null;
    levelsNote: string | null;
    eventLine?: string | null;
    maxContracts?: number | null;
  } | null;
  alertId?: string | null;
}): string {
  const emoji = flow.putCall === "call" ? "🟢" : "🔴";
  const type = flow.putCall === "call" ? "CALL" : "PUT";
  const premiumStr = formatFlowPremium(flow.notionalPremium);
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
    flow.verdict ? formatVerdictHtml(flow.verdict) : "",
    ``,
    `💰 <b>${premiumStr}</b> flow premium (volume × mid × 100)`,
    `💵 ${escapeHtml(formatContractPriceLine(flow.ask))}`,
    `📍 $${flow.strike} strike · ${escapeHtml(flow.expiration)}`,
    `📊 Vol: ${flow.volume.toLocaleString()} · OI: ${flow.openInterest.toLocaleString()} · IV: ${ivPct}`,
    `🧭 ${escapeHtml(flow.side)} · ${ratio}`,
    flow.prints?.summary ? escapeHtml(flow.prints.summary) : "",
    exitBlock(flow.ask, flow.verdict?.maxContracts),
    flags ? `🏷 ${flags}` : "",
    flow.alertId ? paperTradeLinkHtml(flow.alertId) : "",
    ``,
    `⏰ ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`,
  ].filter(Boolean).join("\n");
}

function exitBlock(ask: number, maxContracts: number | null | undefined): string {
  const plan = planExitsForAsk(ask, maxContracts);
  if (!plan) return "";
  return plan.lines.concat(plan.note).map((line) => escapeHtml(line)).join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
