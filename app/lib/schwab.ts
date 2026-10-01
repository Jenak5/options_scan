import type { OptionContract } from "@/app/lib/contract";
import {
  buildAuthorizeUrl,
  marketDataGetUrl,
  alertDue,
  parseOptionChain,
  parseQuotes,
  parseTokenResponse,
  publicTokenStatus,
  refreshWarnSoon,
  TOKEN_URL,
  type ChainParseResult,
  type SchwabPublicStatus,
  type StoredTokens,
} from "@/app/lib/schwabParse";
import { readAlertMeta, readTokens, resolveStoreKind, writeAlertMeta, writeTokens } from "@/app/lib/schwabStore";
import { sendTelegramAlert, telegramConfigured } from "@/app/lib/telegram";

/**
 * Read-only Schwab Market Data client.
 *
 * Network calls this module is allowed to make:
 * - POST https://api.schwabapi.com/v1/oauth/token
 * - GET  https://api.schwabapi.com/marketdata/v1/chains
 * - GET  https://api.schwabapi.com/marketdata/v1/quotes
 *
 * It never calls the trader API and never places an order.
 * Tokens stay in the server store. Do not put them in a response or a log.
 */

export const SCHWAB_STATE_COOKIE = "oes_schwab_oauth_state";

const EXPIRY_ALERT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const REFRESH_FAIL_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const ACCESS_REFRESH_SKEW_MS = 60 * 1000;

export class SchwabNotConnectedError extends Error {
  constructor() {
    super("Schwab is not connected. Use Reconnect Schwab.");
    this.name = "SchwabNotConnectedError";
  }
}

export class SchwabConfigError extends Error {
  constructor() {
    super("Schwab market data is not configured.");
    this.name = "SchwabConfigError";
  }
}

export function schwabConfigured(): boolean {
  return schwabAppConfig() !== null;
}

export function schwabAuthorizeUrl(state: string): string {
  const cfg = schwabAppConfig();
  if (!cfg) throw new SchwabConfigError();
  return buildAuthorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state: state });
}

export async function exchangeAuthorizationCode(code: string): Promise<StoredTokens> {
  if (!code || code.length > 2048) throw new Error("Schwab authorization code was rejected");
  const cfg = schwabAppConfig();
  if (!cfg) throw new SchwabConfigError();
  const body = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });
  return parseTokenResponse(body, Date.now());
}

export async function getSchwabStatus(now: number = Date.now()): Promise<SchwabPublicStatus> {
  const stored = await readTokens();
  return publicTokenStatus({
    configured: schwabConfigured(),
    storage: resolveStoreKind(),
    accessExpiresAt: stored?.accessExpiresAt ?? null,
    refreshExpiresAt: stored?.refreshExpiresAt ?? null,
    now,
  });
}

/** Telegram warning when the refresh token is inside the 2-day window or already expired. */
export async function noteRefreshWindow(status: SchwabPublicStatus): Promise<void> {
  if (!status.configured) return;
  if (!status.warnRefreshSoon && !status.refreshExpired) return;
  await notifyExpiry();
}

export async function getAccessToken(): Promise<string> {
  const stored = await readTokens();
  if (!stored) throw new SchwabNotConnectedError();
  const now = Date.now();
  if (stored.refreshExpiresAt <= now) {
    await notifyExpiry();
    throw new SchwabNotConnectedError();
  }
  if (refreshWarnSoon(stored.refreshExpiresAt, now)) {
    await notifyExpiry();
  }
  if (stored.accessExpiresAt - ACCESS_REFRESH_SKEW_MS > now) return stored.accessToken;
  const next = await refreshStored(stored, now);
  return next.accessToken;
}

export async function getOptionChain(input: {
  symbol: string;
  contractType?: "CALL" | "PUT" | "ALL";
  strike?: number;
  fromDate?: string;
  toDate?: string;
}): Promise<ChainParseResult> {
  const query = new URLSearchParams();
  query.set("symbol", input.symbol);
  query.set("contractType", input.contractType ?? "ALL");
  query.set("strategy", "SINGLE");
  query.set("includeUnderlyingQuote", "true");
  if (input.strike != null) query.set("strike", String(input.strike));
  if (input.fromDate) query.set("fromDate", input.fromDate);
  if (input.toDate) query.set("toDate", input.toDate);
  const payload = await marketDataGet("chains", query);
  return parseOptionChain(payload);
}

export async function getQuotes(symbols: string[]): Promise<OptionContract[]> {
  const cleaned = symbols.map((symbol) => symbol.trim()).filter((symbol) => symbol.length > 0);
  if (cleaned.length === 0) return [];
  const query = new URLSearchParams();
  query.set("symbols", cleaned.join(","));
  query.set("indicative", "false");
  const payload = await marketDataGet("quotes", query);
  return parseQuotes(payload);
}

async function refreshStored(stored: StoredTokens, now: number): Promise<StoredTokens> {
  try {
    const body = await postToken({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    const next = parseTokenResponse(body, now, {
      refreshToken: stored.refreshToken,
      refreshExpiresAt: stored.refreshExpiresAt,
    });
    await writeTokens(next);
    return next;
  } catch (err) {
    await notifyRefreshFailure();
    if (err instanceof SchwabConfigError) throw err;
    throw new Error("Schwab token refresh failed. Reconnect Schwab.");
  }
}

async function marketDataGet(path: "chains" | "quotes", query: URLSearchParams): Promise<unknown> {
  const url = marketDataGetUrl(path, query);
  const token = await getAccessToken();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (res.status === 401) return retryMarketDataOnce(url);
  if (!res.ok) throw new Error(`Schwab market data request failed (${res.status})`);
  return res.json();
}

async function retryMarketDataOnce(url: string): Promise<unknown> {
  const stored = await readTokens();
  if (!stored) throw new SchwabNotConnectedError();
  const next = await refreshStored(stored, Date.now());
  const retry = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${next.accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!retry.ok) throw new Error(`Schwab market data request failed (${retry.status})`);
  return retry.json();
}

async function postToken(fields: Record<string, string>): Promise<unknown> {
  const cfg = schwabAppConfig();
  if (!cfg) throw new SchwabConfigError();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${utf8Base64(`${cfg.clientId}:${cfg.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Schwab token request failed (${res.status})`);
  return res.json();
}

function schwabAppConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.SCHWAB_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.SCHWAB_REDIRECT_URI?.trim() ?? "";
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

async function notifyExpiry(): Promise<void> {
  if (!telegramConfigured()) return;
  try {
    const meta = await readAlertMeta();
    const now = Date.now();
    if (!alertDue(meta.expiryAlertAt, now, EXPIRY_ALERT_INTERVAL_MS)) return;
    const sent = await sendTelegramAlert(
      "⚠️ <b>Schwab reconnect</b>\n\nThe refresh token has under 2 days left, or it has already expired. Open the scanner and use Reconnect Schwab.\n\nThe app is read-only and did not place an order.",
    );
    if (sent) await writeAlertMeta({ ...meta, expiryAlertAt: now });
  } catch {
    // A failed alert must not break a status check or a quote.
  }
}

async function notifyRefreshFailure(): Promise<void> {
  if (!telegramConfigured()) return;
  try {
    const meta = await readAlertMeta();
    const now = Date.now();
    if (!alertDue(meta.refreshFailAlertAt, now, REFRESH_FAIL_ALERT_INTERVAL_MS)) return;
    const sent = await sendTelegramAlert(
      "⚠️ <b>Schwab refresh failed</b>\n\nThe market-data token could not be refreshed. Open the scanner and use Reconnect Schwab.\n\nThe app is read-only and did not place an order.",
    );
    if (sent) await writeAlertMeta({ ...meta, refreshFailAlertAt: now });
  } catch {
    // A failed alert must not hide the original refresh error.
  }
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
