import { CRON_CADENCE_MINUTES, SCAN_SLOT_DEDUPE_MS, SCAN_STALE_AFTER_MS } from "@/app/lib/cronCadence";
import { isChicagoMarketHours, isMarketDay } from "@/app/lib/marketHours";

/**
 * Plain-language Schwab and Tastytrade health.
 * The banner and the skip notification both read these functions.
 * Nothing here places an order or calls a broker.
 */

/** Two missed scans. The banner reads this. */
export const SCAN_STALE_MS = SCAN_STALE_AFTER_MS;
export const SKIP_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
/** A second caller waits this long before treating a started run as abandoned. Longer than one 5-minute slot. */
export const SCAN_IN_PROGRESS_MS = 6 * 60 * 1000;
/**
 * A finished success blocks another Schwab pass inside this window,
 * and also for the rest of the same 5-minute UTC slot.
 */
export const SCAN_RECENT_SUCCESS_MS = SCAN_SLOT_DEDUPE_MS;

/** UTC year-month-day-hour and the minute floored to the scan cadence. */
export function scanSlotKey(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const minute = Math.floor(date.getUTCMinutes() / CRON_CADENCE_MINUTES) * CRON_CADENCE_MINUTES;
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}-${date.getUTCHours()}-${minute}`;
}

export type ScanOutcome = "success" | "partial" | "skipped" | "failed";
export type ScanSlot = "ok" | "busy" | "recent";

export interface ScanHealth {
  lastSuccessAt: number | null;
  lastRunAt: number | null;
  /** Set when a run claims the slot. Compared with lastRunAt to see if that run finished. */
  runStartedAt: number | null;
  /** Last time a shadow was opened, marked, or closed. */
  lastShadowAt: number | null;
  /**
   * Last Flow page load or Alerts scan action that finished.
   * This does not claim the cron slot. A page load must not block the scheduled scan.
   */
  lastBrowserScanAt: number | null;
  /**
   * Outcome of the Flow page or manual alert scan recorded in lastBrowserScanAt.
   * Null on rows saved before this field existed. Those still read as success.
   */
  lastBrowserOutcome: ScanOutcome | null;
  /** Tickers that Flow page or manual scan did not read. */
  lastBrowserSkippedTickers: string[];
  lastOutcome: ScanOutcome | null;
  /** Tickers the scheduled scan did not read. Empty unless lastOutcome is partial. */
  lastSkippedTickers: string[];
  lastReason: string | null;
  skipNotifiedAt: number | null;
  tastytradeOk: boolean | null;
  tastytradeStatus: number | null;
  tastytradeCheckedAt: number | null;
  tastytradeMessage: string | null;
}

export interface ScanRunSummary {
  outcome: "success" | "partial" | "skipped" | "failed" | "unauthorized";
  tickers: number;
  alertsSaved: number;
  shadowsOpened: number;
  shadowsMarked: number;
  shadowsClosed: number;
  reason?: string | null;
}

export interface ScanFreshness {
  lastScanAt: number | null;
  lastScan: string;
  lastShadowAt: number | null;
  lastShadow: string;
}

export interface ConnectionNotice {
  severity: "down" | "warn" | "ok";
  lines: string[];
}

export function emptyScanHealth(): ScanHealth {
  return {
    lastSuccessAt: null,
    lastRunAt: null,
    runStartedAt: null,
    lastShadowAt: null,
    lastBrowserScanAt: null,
    lastBrowserOutcome: null,
    lastBrowserSkippedTickers: [],
    lastOutcome: null,
    lastSkippedTickers: [],
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
  const outcome = knownOutcome(row.lastOutcome);
  return {
    lastSuccessAt: timeOrNull(row.lastSuccessAt),
    lastRunAt: timeOrNull(row.lastRunAt),
    runStartedAt: timeOrNull(row.runStartedAt),
    lastShadowAt: timeOrNull(row.lastShadowAt),
    lastBrowserScanAt: timeOrNull(row.lastBrowserScanAt),
    lastBrowserOutcome: knownOutcome(row.lastBrowserOutcome),
    lastBrowserSkippedTickers: normalizeSkippedTickers(row.lastBrowserSkippedTickers),
    lastOutcome: outcome,
    lastSkippedTickers: normalizeSkippedTickers(row.lastSkippedTickers),
    lastReason: clip(row.lastReason),
    skipNotifiedAt: timeOrNull(row.skipNotifiedAt),
    tastytradeOk: row.tastytradeOk === true ? true : row.tastytradeOk === false ? false : null,
    tastytradeStatus: statusOrNull(row.tastytradeStatus),
    tastytradeCheckedAt: timeOrNull(row.tastytradeCheckedAt),
    tastytradeMessage: clip(row.tastytradeMessage),
  };
}

/**
 * One Schwab pass at a time. A run that started and has not finished holds the slot
 * until SCAN_IN_PROGRESS_MS, which is longer than the 5-minute cadence.
 * A finished success or partial run holds the same UTC 5-minute slot, and also the next
 * SCAN_RECENT_SUCCESS_MS, so a retry cannot double-read the chains.
 * The next scheduled slot is a different key and is outside that window, so it runs.
 */
export function scanSlotDecision(health: ScanHealth, now: number): ScanSlot {
  const started = health.runStartedAt;
  if (started != null && now >= started && now - started < SCAN_IN_PROGRESS_MS) {
    if (health.lastRunAt == null || health.lastRunAt < started) return "busy";
  }
  const success = health.lastSuccessAt;
  if (success != null && now >= success) {
    if (now - success < SCAN_RECENT_SUCCESS_MS) return "recent";
    if (scanSlotKey(success) === scanSlotKey(now)) return "recent";
  }
  return "ok";
}

/** One line for the runtime log. No secrets, no line breaks. */
export function formatScanRunLine(summary: ScanRunSummary): string {
  const reason = oneLine(summary.reason);
  const tail = reason ? ` ${reason}` : "";
  const tickers = count(summary.tickers);
  const saved = count(summary.alertsSaved);
  const opened = count(summary.shadowsOpened);
  const marked = count(summary.shadowsMarked);
  const closed = count(summary.shadowsClosed);
  return `Scan ${summary.outcome}: ${tickers} ticker${tickers === 1 ? "" : "s"}, ${saved} alert${saved === 1 ? "" : "s"} saved, ${opened} shadow${opened === 1 ? "" : "s"} opened, ${marked} marked, ${closed} closed.${tail}`;
}

/** The newer of the scheduled scan and a Flow page load. */
export function latestScan(health: ScanHealth): {
  at: number | null;
  outcome: ScanOutcome | null;
  skippedTickers: string[];
} {
  const browser = health.lastBrowserScanAt;
  const cron = health.lastRunAt;
  if (browser != null && (cron == null || browser > cron)) {
    const skipped = normalizeSkippedTickers(health.lastBrowserSkippedTickers);
    const outcome = health.lastBrowserOutcome ?? (skipped.length > 0 ? "partial" : "success");
    return {
      at: browser,
      outcome,
      skippedTickers: outcome === "partial" ? skipped : [],
    };
  }
  const skipped = normalizeSkippedTickers(health.lastSkippedTickers);
  return {
    at: cron,
    outcome: health.lastOutcome,
    skippedTickers: health.lastOutcome === "partial" ? skipped : [],
  };
}

const SKIPPED_TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const MAX_SKIPPED_TICKERS = 48;

/** Tickers only. Drops duplicates and anything that is not a symbol. */
export function normalizeSkippedTickers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length && out.length < MAX_SKIPPED_TICKERS; i++) {
    if (typeof value[i] !== "string") continue;
    const ticker = value[i].trim().toUpperCase();
    if (!SKIPPED_TICKER.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

function knownOutcome(value: unknown): ScanOutcome | null {
  return value === "success" || value === "partial" || value === "skipped" || value === "failed" ? value : null;
}

export function scanFreshness(health: ScanHealth): ScanFreshness {
  const latest = latestScan(health);
  const outcome = latest.outcome ? ` (${latest.outcome})` : "";
  return {
    lastScanAt: latest.at,
    lastScan: latest.at == null
      ? "Last scan: not recorded yet"
      : `Last scan: ${formatChicagoStamp(latest.at)}${outcome}`,
    lastShadowAt: health.lastShadowAt,
    lastShadow: health.lastShadowAt == null
      ? "Last shadow update: not recorded yet"
      : `Last shadow update: ${formatChicagoStamp(health.lastShadowAt)}`,
  };
}

export function formatChicagoStamp(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
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

/** Shown when Tastytrade is the source and Schwab cannot be used as a backup. */
export const SCHWAB_BACKUP_NOTE = "Schwab backup not connected; scans run on tastytrade.";

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
  /** False while Tastytrade is turned off. A stored HTTP 400 stays hidden. */
  showTastytrade?: boolean;
  /** Tastytrade is preferred, so a dead Schwab login does not stop scans. */
  schwabIsBackup?: boolean;
}): ConnectionNotice {
  const lines: string[] = [];
  let severity: ConnectionNotice["severity"] = "ok";
  const backupDown = input.schwabIsBackup === true && (!input.configured || !input.connected || input.refreshExpired);
  if (backupDown) {
    lines.push(SCHWAB_BACKUP_NOTE);
  } else if (!input.configured) {
    severity = "down";
    lines.push("Schwab market data is not configured, so scans cannot run.");
  } else if (!input.connected || input.refreshExpired) {
    severity = "down";
    lines.push("Schwab is disconnected. Reconnect Schwab. New scans, the scorecard, and Learning mode are not collecting quotes until you do.");
  }
  if (!backupDown && (input.refreshExpired || input.warnRefreshSoon)) {
    const countdown = refreshCountdown(input.refreshDaysLeft, input.refreshExpired || !input.connected);
    if (countdown) {
      if (severity === "ok") severity = "warn";
      lines.push(countdown);
    }
  }
  const asOf = new Date(input.now);
  const marketHours = isChicagoMarketHours(asOf) && isMarketDay(asOf);
  if (scanIsStale(input.now, input.health.lastSuccessAt, marketHours)) {
    if (severity === "ok") severity = "warn";
    const when = input.health.lastSuccessAt == null
      ? "No successful scan has been recorded."
      : `The last successful scan was ${minutesAgo(input.now, input.health.lastSuccessAt)} minutes ago.`;
    const staleMinutes = Math.round(SCAN_STALE_MS / 60_000);
    lines.push(`${when} During market hours a gap over ${staleMinutes} minutes means the scorecard and Learning mode are not getting new quotes.`);
  }
  if (input.showTastytrade && input.health.tastytradeOk === false && input.health.tastytradeMessage) {
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

function count(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function oneLine(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 180);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
