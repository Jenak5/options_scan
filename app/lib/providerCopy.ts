/**
 * User-facing source names. Tastytrade is the primary when it is configured.
 * Schwab is named only when it is the source that was asked, or as a backup.
 *
 * This file stays free of server-only imports. Gate, grade, and the Flow tab
 * bundle it in the browser. The rules match preferredDataSource in dataSourcePref.
 */

function clean(value: string | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, "").trim();
}

function requested(env: Record<string, string | undefined>): "tastytrade" | "schwab" {
  const primary = clean(env.MARKET_DATA_PRIMARY).toLowerCase();
  if (primary === "schwab" || primary === "tastytrade") return primary;
  const legacy = clean(env.DATA_SOURCE).toLowerCase();
  if (legacy === "schwab" || legacy === "tastytrade") return legacy;
  return "tastytrade";
}

function tastytradeConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(clean(env.TASTYTRADE_CLIENT_ID) && clean(env.TASTYTRADE_CLIENT_SECRET) && clean(env.TASTYTRADE_REFRESH_TOKEN));
}

export function namedSource(env: Record<string, string | undefined> = process.env): "Tastytrade" | "Schwab" {
  if (requested(env) === "schwab") return "Schwab";
  if (!tastytradeConfigured(env)) return "Schwab";
  return "Tastytrade";
}

function isBothSourcesFailure(err: unknown): err is Error {
  return err instanceof Error && err.name === "BothSourcesFailedError";
}

function timeoutText(text: string): boolean {
  return /timeout|timed out|exceeded \d+\s*s/i.test(text);
}

export function isProviderTimeout(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && (err.name === "AbortError" || timeoutText(err.message))) return true;
  return false;
}

/**
 * One sentence for a failed read.
 * A Tastytrade miss names Tastytrade. A Schwab backup failure stays inside
 * BothSourcesFailedError, which already labels that backup.
 */
export function providerFailureText(err: unknown, fallback?: string): string {
  if (isBothSourcesFailure(err)) return err.message.replace(/\s+/g, " ").slice(0, 180);
  const tasty = namedSource() === "Tastytrade";
  if (tasty && isProviderTimeout(err)) return "Tastytrade timed out.";
  if (err instanceof Error && err.message.trim()) {
    const text = err.message.replace(/\s+/g, " ").trim();
    if (tasty && /tastytrade/i.test(text)) return text.slice(0, 180);
    if (!tasty && text.startsWith("Schwab ")) return text.slice(0, 180);
  }
  if (fallback) return fallback;
  return tasty ? "Tastytrade market data request failed." : "Schwab market data request failed.";
}

/**
 * Keep a specific scan error. Rewrite it only when it would blame Schwab
 * while Tastytrade is the source, or when a timeout does not name Tastytrade.
 */
export function describeScanError(err: unknown): string {
  if (isBothSourcesFailure(err)) return err.message.replace(/\s+/g, " ").slice(0, 180);
  const raw = err instanceof Error ? err.message : "";
  const text = raw.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/\s+/g, " ").trim();
  if (!text) return providerFailureText(err);
  if (namedSource() === "Tastytrade") {
    if (timeoutText(text) && !/tastytrade/i.test(text)) return "Tastytrade timed out.";
    if (/^Schwab\b/.test(text) && !/backup/i.test(text)) return "Tastytrade market data request failed.";
  }
  return text.slice(0, 180);
}

export function delayedChainDetail(env: Record<string, string | undefined> = process.env): string {
  return `${namedSource(env)} marked this chain delayed. Real-time data is required.`;
}

export function delayedChainBlocked(env: Record<string, string | undefined> = process.env): string {
  return `${namedSource(env)} marked this chain delayed, so this was not counted as a pass.`;
}

export function missingQuoteTimeDetail(env: Record<string, string | undefined> = process.env): string {
  return `${namedSource(env)} did not send a quote time, so this quote cannot be checked for staleness.`;
}
