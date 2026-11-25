import { labelsLine, suggestedExitText } from "@/app/lib/scanLabels";
import { formatContractPriceLine, formatFlowPremium } from "@/app/lib/alertConfig";
import { planExitsForAsk } from "@/app/lib/exits";
import { formatLevelsSummary, type StoredPriceLevels } from "@/app/lib/levels";

const TG_API = "https://api.telegram.org/bot";
/** Telegram's retry_after is in seconds. Never wait longer than this on one 429. */
export const TELEGRAM_RETRY_CAP_MS = 15_000;

export function telegramConfigured(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  return token.length > 0 && chatId.length > 0;
}

/**
 * Milliseconds to wait after a Telegram 429.
 * Uses parameters.retry_after, then the Retry-After header, and caps the wait.
 */
export function telegramRetryWaitMs(body: string, retryAfterHeader: string | null): number {
  const seconds = retryAfterSeconds(body) ?? headerRetrySeconds(retryAfterHeader);
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(TELEGRAM_RETRY_CAP_MS, Math.round(seconds * 1000));
}

export type TelegramCategory = "avwap" | "system" | "other";

export interface TelegramSendResult {
  ok: boolean;
  messageId: number | null;
}

/**
 * Same send as sendTelegramAlert, plus one inline Got it button.
 * Returns the Telegram message id when the send is accepted.
 * Does not change sendTelegramAlert.
 */
export async function sendTelegramAlertWithButton(message: string, callbackData: string): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!telegramConfigured() || !token || !chatId) {
    console.warn("Telegram not configured, skipping alert");
    return { ok: false, messageId: null };
  }
  if (!/^ack:[A-Za-z0-9]{4,40}$/.test(callbackData)) return { ok: false, messageId: null };
  const body = JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "Got it", callback_data: callbackData }]] },
  });
  return postTelegramJson(token, "sendMessage", body);
}

export async function editTelegramMessage(messageId: number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!telegramConfigured() || !token || !chatId || !Number.isInteger(messageId)) return false;
  const body = JSON.stringify({
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  });
  const sent = await postTelegramJson(token, "editMessageText", body);
  return sent.ok;
}

export async function answerTelegramCallback(callbackId: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || callbackId.trim() === "") return false;
  const body = JSON.stringify({ callback_query_id: callbackId });
  const sent = await postTelegramJson(token, "answerCallbackQuery", body);
  return sent.ok;
}

export async function setTelegramWebhook(url: string, secret: string): Promise<{ ok: boolean; description: string | null }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !url || !secret) return { ok: false, description: "Telegram webhook is not configured" };
  const body = JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["callback_query", "message"],
  });
  try {
    const res = await fetch(`${TG_API}${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await res.text();
    const safe = redactTelegram(redactTelegram(text, token), secret);
    let description: string | null = null;
    let ok = res.ok;
    try {
      const parsed = JSON.parse(text) as { ok?: boolean; description?: unknown };
      ok = parsed.ok === true && res.ok;
      description = typeof parsed.description === "string" ? redactTelegram(redactTelegram(parsed.description, token), secret) : null;
    } catch {
      description = safe.slice(0, 180);
    }
    return { ok, description };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : "unknown";
    return { ok: false, description: redactTelegram(redactTelegram(messageText, token), secret).slice(0, 180) };
  }
}

export interface TelegramWebhookSummary {
  ok: boolean;
  url: string | null;
  pending_update_count: number | null;
  last_error_date: number | null;
  last_error_message: string | null;
  allowed_updates: string[] | null;
  description: string | null;
}

/** getWebhookInfo with only safe fields. The URL loses its query string. No token in the result. */
export async function getTelegramWebhookSummary(): Promise<TelegramWebhookSummary> {
  const empty: TelegramWebhookSummary = {
    ok: false, url: null, pending_update_count: null, last_error_date: null, last_error_message: null, allowed_updates: null, description: null,
  };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim() === "") return { ...empty, description: "Telegram is not configured" };
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const clean = (text: string) => redactTelegram(secret ? redactTelegram(text, secret) : text, token).slice(0, 300);
  try {
    const res = await fetch(`${TG_API}${token}/getWebhookInfo`, { method: "GET" });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: unknown; result?: Record<string, unknown> } | null;
    const result = body?.result ?? {};
    const rawUrl = typeof result.url === "string" ? result.url : null;
    return {
      ok: res.ok && body?.ok === true,
      url: rawUrl == null ? null : clean(rawUrl.split("?")[0]),
      pending_update_count: typeof result.pending_update_count === "number" ? result.pending_update_count : null,
      last_error_date: typeof result.last_error_date === "number" ? result.last_error_date : null,
      last_error_message: typeof result.last_error_message === "string" ? clean(result.last_error_message) : null,
      allowed_updates: Array.isArray(result.allowed_updates) ? result.allowed_updates.filter((v): v is string => typeof v === "string") : null,
      description: typeof body?.description === "string" ? clean(body.description) : null,
    };
  } catch (err) {
    return { ...empty, description: clean(err instanceof Error ? err.message : "unknown") };
  }
}

export function publicAppOrigin(): string {
  return appOrigin();
}

/**
 * category defaults to other. other is muted while the mute setting is on.
 * avwap and system always use the HTTP send below.
 * A muted other message returns true so callers treat it as handled.
 */
export async function sendTelegramAlert(message: string, category: TelegramCategory = "other"): Promise<boolean> {
  if (category === "other" && process.env.TELEGRAM_MUTE_OTHER !== "0") {
    const { allowOtherTelegram } = await import("@/app/lib/telegramMuteJob");
    const allowed = await allowOtherTelegram(message);
    if (!allowed) return true;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!telegramConfigured() || !token || !chatId) {
    console.warn("Telegram not configured — skipping alert");
    return false;
  }

  const body = JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  try {
    let res = await postTelegram(token, body);
    if (res.status === 429) {
      const text = await res.text();
      const waitMs = telegramRetryWaitMs(text, res.headers.get("retry-after"));
      console.info(`Telegram rate limited, retrying once after ${waitMs}ms`);
      await sleep(waitMs);
      res = await postTelegram(token, body);
    }
    if (!res.ok) {
      const err = redactTelegram(await res.text(), token);
      console.error(`Telegram send failed (${res.status}): ${err}`);
      return false;
    }
    return true;
  } catch (err) {
    const messageText = err instanceof Error ? err.message : "unknown";
    console.error(`Telegram send error: ${redactTelegram(messageText, token)}`);
    return false;
  }
}

function postTelegram(token: string, body: string): Promise<Response> {
  return fetch(`${TG_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function postTelegramJson(token: string, method: string, body: string): Promise<TelegramSendResult> {
  try {
    let res = await fetch(`${TG_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status === 429) {
      const text = await res.text();
      const waitMs = telegramRetryWaitMs(text, res.headers.get("retry-after"));
      console.info(`Telegram rate limited, retrying once after ${waitMs}ms`);
      await sleep(waitMs);
      res = await fetch(`${TG_API}${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    }
    const text = await res.text();
    if (!res.ok) {
      console.error(`Telegram send failed (${res.status}): ${redactTelegram(text, token)}`);
      return { ok: false, messageId: null };
    }
    let messageId: number | null = null;
    try {
      const parsed = JSON.parse(text) as { ok?: boolean; result?: { message_id?: unknown } };
      if (parsed.ok === false) return { ok: false, messageId: null };
      const id = parsed.result?.message_id;
      if (typeof id === "number" && Number.isInteger(id)) messageId = id;
    } catch {
      return { ok: true, messageId: null };
    }
    return { ok: true, messageId };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : "unknown";
    console.error(`Telegram send error: ${redactTelegram(messageText, token)}`);
    return { ok: false, messageId: null };
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterSeconds(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { parameters?: { retry_after?: unknown } };
    const value = parsed?.parameters?.retry_after;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsedValue = Number(value);
      if (Number.isFinite(parsedValue)) return parsedValue;
    }
  } catch {
    // A non-JSON body can still name the wait in text.
  }
  const named = /retry after (\d+(?:\.\d+)?)/i.exec(body);
  if (!named) return null;
  const seconds = Number(named[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

function headerRetrySeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

function redactTelegram(text: string, token: string): string {
  const secret = token.trim();
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
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
  /** When false, the message says the alert was not saved and omits the paper-trade link. */
  saved?: boolean;
  /** Display labels such as "$3M+ flow" or "repeat". Labels only; they change nothing else. */
  labels?: readonly string[];
  /** Why this contract was sent again today. Empty on the first alert. */
  realertReasons?: readonly string[];
}): string {
  const emoji = flow.putCall === "call" ? "🟢" : "🔴";
  const type = flow.putCall === "call" ? "CALL" : "PUT";
  const realert = formatRealertHtml(flow.realertReasons ?? []);
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
    realert,
    `<b>Estimated flow</b> from option volume/open interest, not a sweep.`,
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
    flow.labels && flow.labels.length > 0 ? `🔖 ${escapeHtml(labelsLine(flow.labels))}` : "",
    flow.labels ? escapeHtml(suggestedExitText(flow.ask) ?? "") : "",
    flow.saved === false ? "Not saved in the app. No paper-trade link." : (flow.alertId ? paperTradeLinkHtml(flow.alertId) : ""),
    ``,
    `⏰ ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`,
  ].filter(Boolean).join("\n");
}

export function formatRealertHtml(reasons: readonly string[]): string {
  if (reasons.length === 0) return "";
  return reasons.map((reason) => `<b>${escapeHtml(reason)}</b>`).join("\n");
}

function exitBlock(ask: number, maxContracts: number | null | undefined): string {
  const plan = planExitsForAsk(ask, maxContracts);
  if (!plan) return "";
  return plan.lines.concat(plan.note).map((line) => escapeHtml(line)).join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
