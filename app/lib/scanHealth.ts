import { isChicagoMarketHours } from "@/app/lib/marketHours";

/**
 * Plain-language Schwab and Tastytrade health.
 * The banner and the skip notification both read these functions.
 * Nothing here places an order or calls a broker.
 */

export const SCAN_STALE_MS = 30 * 60 * 1000;
export const SKIP_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

export type ScanOutcome = "success" | "skipped" | "failed";

export interface ScanHealth {
  lastSuccessAt: number | null;
  lastRunAt: number | null;
  lastOutcome: ScanOutcome | null;
  lastReason: string | null;
  skipNotifiedAt: number | null;
  tastytradeOk: boolean | null;
  tastytradeStatus: number | null;
  tastytradeCheckedAt: number | null;
  tastytradeMessage: string | null;
}

export interface ConnectionNotice {
  severity: "down" | "warn" | "ok";
  lines: string[];
}

export function emptyScanHealth(): ScanHealth {
  return {
    lastSuccessAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastReason: null,
    skipNotifiedAt: null,
    tastytradeOk: null,
    tastytradeStatus: null,
    tastytradeCheckedAt: null,
    tastytradeMessage: null,
  };
}

export function parseScanHealth(value: unknown): ScanHealth {
  const empty = emptyScanHealth();
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const row = value as Partial<ScanHealth>;
  const outcome = row.lastOutcome === "success" || row.lastOutcome === "skipped" || row.lastOutcome === "failed"
    ? row.lastOutcome
    : null;
  return {
    lastSuccessAt: timeOrNull(row.lastSuccessAt),
    lastRunAt: timeOrNull(row.lastRunAt),
    lastOutcome: outcome,
    lastReason: clip(row.lastReason),
    skipNotifiedAt: timeOrNull(row.skipNotifiedAt),
    tastytradeOk: row.tastytradeOk === true ? true : row.tastytradeOk === false ? false : null,
    tastytradeStatus: statusOrNull(row.tastytradeStatus),
    tastytradeCheckedAt: timeOrNull(row.tastytradeCheckedAt),
    tastytradeMessage: clip(row.tastytradeMessage),
  };
}

export function scanIsStale(now: number, lastSuccessAt: number | null, marketHours: boolean): boolean {
  if (!marketHours) return false;
  if (lastSuccessAt == null || !Number.isFinite(lastSuccessAt)) return true;
  return now - lastSuccessAt > SCAN_STALE_MS;
}

export function skipNotifyDue(lastNotifiedAt: number | null, now: number): boolean {
  if (lastNotifiedAt == null || !Number.isFinite(lastNotifiedAt)) return true;
  return now - lastNotifiedAt >= SKIP_NOTIFY_COOLDOWN_MS;
}

export function refreshCountdown(daysLeft: number | null, expired: boolean): string | null {
  if (expired) return "The Schwab refresh token is expired. Reconnect Schwab. Scans cannot run until then.";
  if (daysLeft == null || !Number.isFinite(daysLeft) || daysLeft < 0) return null;
  const hours = Math.max(1, Math.round(daysLeft * 24));
  if (hours < 48) {
    return `Schwab refresh token expires in about ${hours} hour${hours === 1 ? "" : "s"}. Reconnect before the weekly login lapses.`;
  }
  const days = Math.max(1, Math.round(daysLeft));
  return `Schwab refresh token expires in about ${days} day${days === 1 ? "" : "s"}.`;
}

export function connectionNotice(input: {
  configured: boolean;
  connected: boolean;
  refreshExpired: boolean;
  warnRefreshSoon: boolean;
  refreshDaysLeft: number | null;
  now: number;
  health: ScanHealth;
}): ConnectionNotice {
  const lines: string[] = [];
  let severity: ConnectionNotice["severity"] = "ok";
  if (!input.configured) {
    severity = "down";
    lines.push("Schwab market data is not configured, so scans cannot run.");
  } else if (!input.connected || input.refreshExpired) {
    severity = "down";
    lines.push("Schwab is disconnected. Reconnect Schwab. New scans, the scorecard, and Learning mode are not collecting quotes until you do.");
  }
  if (input.refreshExpired || input.warnRefreshSoon) {
    const countdown = refreshCountdown(input.refreshDaysLeft, input.refreshExpired || !input.connected);
    if (countdown) {
      if (severity === "ok") severity = "warn";
      lines.push(countdown);
    }
  }
  const marketHours = isChicagoMarketHours(new Date(input.now));
  if (scanIsStale(input.now, input.health.lastSuccessAt, marketHours)) {
    if (severity === "ok") severity = "warn";
    const when = input.health.lastSuccessAt == null
      ? "No successful scan has been recorded."
      : `The last successful scan was ${minutesAgo(input.now, input.health.lastSuccessAt)} minutes ago.`;
    lines.push(`${when} During market hours a gap over 30 minutes means the scorecard and Learning mode are not getting new quotes.`);
  }
  if (input.health.tastytradeOk === false && input.health.tastytradeMessage) {
    if (severity === "ok") severity = "warn";
    lines.push(input.health.tastytradeMessage);
  }
  return { severity, lines };
}

export function skipWarning(reason: string): string {
  return `Schwab scan skipped: ${reason}`;
}

export function skipTelegramText(reason: string): string {
  return [
    "⚠️ <b>Schwab scan skipped</b>",
    "",
    escapeHtml(reason),
    "",
    "No new alerts were sent and no new scorecard quotes were saved on this run. Open the scanner and use Reconnect Schwab.",
    "",
    "The app is read-only and did not place an order.",
  ].join("\n");
}

function minutesAgo(now: number, then: number): number {
  return Math.max(0, Math.floor((now - then) / 60_000));
}

function timeOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function statusOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return null;
  return value;
}

function clip(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\r\n]+/g, " ").trim().slice(0, 240);
  return text.length > 0 ? text : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
