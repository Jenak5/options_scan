import type { OptionContract, PutCall } from "@/app/lib/contract";
import { REFRESH_TOKEN_WARNING_DAYS } from "@/app/lib/risk";
import { SCHWAB_STORAGE_UNCONFIGURED_MESSAGE, type SchwabStoreKind } from "@/app/lib/schwabStorage";

/** Schwab access tokens last about 30 minutes. */
export const ACCESS_TOKEN_FALLBACK_SECONDS = 30 * 60;

/** Schwab refresh tokens last 7 days. She re-authorizes in the browser each week. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
export const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
export const MARKET_DATA_ORIGIN = "https://api.schwabapi.com";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface SchwabPublicStatus {
  configured: boolean;
  storage: SchwabStoreKind;
  /** Set when production has no KV, Upstash, or Blob. The dashboard banner shows this. */
  storageWarning: string | null;
  connected: boolean;
  accessExpired: boolean;
  refreshExpired: boolean;
  refreshDaysLeft: number | null;
  warnRefreshSoon: boolean;
  message: string;
}

const MARKET_DATA_READS = new Set(["chains", "quotes", "pricehistory"]);

export const MARKET_DATA_ONLY_ERROR = "Schwab client only reads option chains, quotes, and price history";

/**
 * Market-data GETs this app uses: chains, quotes, and price history.
 * Trader, account, and order paths are rejected.
 */
export function marketDataGetUrl(path: string, query: URLSearchParams): string {
  if (!MARKET_DATA_READS.has(path) || path.includes("/") || path.includes(".")) {
    throw new Error(MARKET_DATA_ONLY_ERROR);
  }
  const url = `${MARKET_DATA_ORIGIN}/marketdata/v1/${path}?${query.toString()}`;
  const parsed = new URL(url);
  if (parsed.origin !== MARKET_DATA_ORIGIN) {
    throw new Error(MARKET_DATA_ONLY_ERROR);
  }
  if (!parsed.pathname.startsWith("/marketdata/v1/")) {
    throw new Error(MARKET_DATA_ONLY_ERROR);
  }
  return url;
}

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** True when a throttled Telegram alert is allowed to send again. */
export function alertDue(lastSentAt: number | null, now: number, intervalMs: number): boolean {
  if (lastSentAt == null) return true;
  return now - lastSentAt >= intervalMs;
}

export function refreshDaysLeft(refreshExpiresAt: number, now: number): number {
  return (refreshExpiresAt - now) / (24 * 60 * 60 * 1000);
}

/** True when the refresh token is still valid and has under 2 days left. */
export function refreshWarnSoon(
  refreshExpiresAt: number,
  now: number,
  warningDays: number = REFRESH_TOKEN_WARNING_DAYS,
): boolean {
  const days = refreshDaysLeft(refreshExpiresAt, now);
  return days > 0 && days < warningDays;
}

export function formatDaysLeft(days: number): string {
  const rounded = Math.round(days * 10) / 10;
  const label = Math.abs(rounded) === 1 ? "day" : "days";
  return `${rounded} ${label}`;
}

export function publicTokenStatus(input: {
  configured: boolean;
  storage: SchwabStoreKind;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  now: number;
}): SchwabPublicStatus {
  const base = {
    configured: input.configured,
    storage: input.storage,
    storageWarning: input.storage === "unconfigured" ? SCHWAB_STORAGE_UNCONFIGURED_MESSAGE : null,
  };
  if (input.storage === "unconfigured") {
    return {
      ...base,
      connected: false,
      accessExpired: false,
      refreshExpired: false,
      refreshDaysLeft: null,
      warnRefreshSoon: false,
      message: SCHWAB_STORAGE_UNCONFIGURED_MESSAGE,
    };
  }
  if (!input.configured) {
    return {
      ...base,
      connected: false,
      accessExpired: false,
      refreshExpired: false,
      refreshDaysLeft: null,
      warnRefreshSoon: false,
      message: "Schwab market data is not configured.",
    };
  }
  if (input.refreshExpiresAt == null) {
    const memoryNote = input.storage === "memory"
      ? " Token storage is in-memory until Vercel KV, Upstash, or Vercel Blob is set."
      : "";
    return {
      ...base,
      connected: false,
      accessExpired: false,
      refreshExpired: false,
      refreshDaysLeft: null,
      warnRefreshSoon: false,
      message: `Schwab is not connected.${memoryNote}`,
    };
  }

  const days = refreshDaysLeft(input.refreshExpiresAt, input.now);
  const refreshExpired = days <= 0;
  const accessExpired = input.accessExpiresAt == null || input.accessExpiresAt <= input.now;
  const warnRefreshSoonFlag = refreshWarnSoon(input.refreshExpiresAt, input.now);
  let message: string;
  if (refreshExpired) {
    message = "Schwab refresh token has expired. Reconnect in the browser.";
  } else if (warnRefreshSoonFlag) {
    message = `Schwab refresh token has under 2 days left (${formatDaysLeft(days)}). Reconnect this week.`;
  } else {
    message = `Schwab connected. Refresh token has ${formatDaysLeft(days)} left.`;
    if (input.storage === "memory") {
      message += " In-memory storage drops the token when the server restarts.";
    }
  }

  return {
    ...base,
    connected: !refreshExpired,
    accessExpired: refreshExpired ? true : accessExpired,
    refreshExpired,
    refreshDaysLeft: Math.round(days * 10) / 10,
    warnRefreshSoon: warnRefreshSoonFlag,
    message,
  };
}

interface PreviousRefresh {
  refreshToken: string;
  refreshExpiresAt: number;
}

/**
 * Turn a token-endpoint JSON body into stored expiries.
 * A new refresh token starts a fresh 7-day clock. The same token does not.
 */
export function parseTokenResponse(body: unknown, now: number, previous?: PreviousRefresh): StoredTokens {
  const record = asRecord(body);
  if (!record) throw new Error("Schwab token response was empty");

  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  if (!accessToken) throw new Error("Schwab token response did not include an access token");

  const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in) && record.expires_in > 0
    ? record.expires_in
    : ACCESS_TOKEN_FALLBACK_SECONDS;

  const incomingRefresh = typeof record.refresh_token === "string" ? record.refresh_token : "";
  let refreshToken = previous?.refreshToken ?? "";
  let refreshExpiresAt = previous?.refreshExpiresAt ?? now + REFRESH_TOKEN_TTL_MS;
  if (incomingRefresh && incomingRefresh !== previous?.refreshToken) {
    refreshToken = incomingRefresh;
    refreshExpiresAt = now + REFRESH_TOKEN_TTL_MS;
  }
  if (!refreshToken) throw new Error("Schwab token response did not include a refresh token");

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: now + expiresIn * 1000,
    refreshExpiresAt,
  };
}

export interface ChainParseResult {
  contracts: OptionContract[];
  delayed: boolean;
  underlyingPrice: number | null;
}

/** Schwab chain volatility is a percent. The internal contract stores a decimal. */
export function schwabVolatilityToDecimal(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return value / 100;
}

export function parseOptionChain(payload: unknown): ChainParseResult {
  const root = asRecord(payload);
  const contracts: OptionContract[] = [];
  collectSide(root?.callExpDateMap, "call", contracts);
  collectSide(root?.putExpDateMap, "put", contracts);
  const underlying = asRecord(root?.underlying);
  const underlyingPrice = num(underlying?.last) ?? num(underlying?.mark) ?? num(root?.underlyingPrice);
  return {
    contracts,
    delayed: root?.isDelayed === true,
    underlyingPrice,
  };
}

export interface PriceCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Epoch milliseconds. */
  datetime: number;
}

/** Candles from the price-history endpoint. Invalid rows are dropped. */
export function parsePriceHistory(payload: unknown): PriceCandle[] {
  const root = asRecord(payload);
  const rows = root?.candles;
  if (!Array.isArray(rows)) return [];
  const out: PriceCandle[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = asRecord(rows[i]);
    if (!row) continue;
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    const volume = num(row.volume);
    const datetime = num(row.datetime);
    if (open == null || high == null || low == null || close == null || volume == null || datetime == null) continue;
    if (low <= 0 || high < low || close <= 0 || datetime <= 0) continue;
    out.push({
      open,
      high,
      low,
      close,
      volume: Math.max(0, volume),
      datetime,
    });
  }
  out.sort((a, b) => a.datetime - b.datetime);
  return out;
}

/** Option quotes become contracts. Equity and index quotes are skipped. */
export function parseQuotes(payload: unknown): OptionContract[] {
  const root = asRecord(payload);
  if (!root) return [];
  const contracts: OptionContract[] = [];
  const entries = Object.entries(root);
  for (let i = 0; i < entries.length; i++) {
    const contract = optionFromQuote(entries[i][1]);
    if (contract) contracts.push(contract);
  }
  return contracts;
}

export function parsePutCall(value: unknown): PutCall | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "call" || text === "c") return "call";
  if (text === "put" || text === "p") return "put";
  return null;
}

function optionFromQuote(value: unknown): OptionContract | null {
  const row = asRecord(value);
  if (!row) return null;
  const asset = typeof row.assetMainType === "string" ? row.assetMainType.toUpperCase() : "";
  if (asset && asset !== "OPTION") return null;
  const quote = asRecord(row.quote) ?? {};
  const reference = asRecord(row.reference) ?? {};
  const merged = {
    putCall: quote.putCall ?? reference.contractType ?? row.putCall,
    bid: quote.bidPrice ?? quote.bid ?? row.bid,
    ask: quote.askPrice ?? quote.ask ?? row.ask,
    last: quote.lastPrice ?? quote.last ?? row.last,
    totalVolume: quote.totalVolume ?? row.totalVolume,
    openInterest: quote.openInterest ?? row.openInterest,
    volatility: quote.volatility ?? row.volatility,
    delta: quote.delta ?? row.delta,
    strikePrice: quote.strikePrice ?? reference.strikePrice ?? row.strikePrice,
    expirationDate: reference.expirationDate ?? quote.expirationDate ?? row.expirationDate,
  };
  return normalizeOptionRecord(merged, null);
}

function collectSide(map: unknown, putCall: PutCall, into: OptionContract[]): void {
  const expirations = asRecord(map);
  if (!expirations) return;
  const expEntries = Object.entries(expirations);
  for (let i = 0; i < expEntries.length; i++) {
    const expKey = expEntries[i][0];
    const expiration = /^(\d{4}-\d{2}-\d{2})/.exec(expKey)?.[1] ?? null;
    const strikeMap = asRecord(expEntries[i][1]);
    if (!strikeMap) continue;
    const strikeEntries = Object.entries(strikeMap);
    for (let j = 0; j < strikeEntries.length; j++) {
      const strike = num(strikeEntries[j][0]);
      const rows = strikeEntries[j][1];
      const list = Array.isArray(rows) ? rows : [rows];
      for (let k = 0; k < list.length; k++) {
        const contract = normalizeOptionRecord(list[k], { expiration, putCall, strike });
        if (contract) into.push(contract);
      }
    }
  }
}

function normalizeOptionRecord(raw: unknown, fallback: {
  expiration: string | null;
  putCall: PutCall | null;
  strike: number | null;
} | null): OptionContract | null {
  const row = asRecord(raw);
  if (!row) return null;
  const putCall = parsePutCall(row.putCall) ?? fallback?.putCall ?? null;
  const strike = num(row.strikePrice) ?? fallback?.strike ?? null;
  const expiration = fallback?.expiration ?? expirationToYmd(row.expirationDate);
  if (!putCall || strike == null || !(strike > 0) || !expiration) return null;
  return {
    bid: num(row.bid) ?? Number.NaN,
    ask: num(row.ask) ?? Number.NaN,
    last: num(row.last) ?? Number.NaN,
    volume: num(row.totalVolume) ?? num(row.volume) ?? Number.NaN,
    openInterest: num(row.openInterest) ?? Number.NaN,
    delta: num(row.delta),
    iv: schwabVolatilityToDecimal(num(row.volatility)),
    strike,
    expiration,
    putCall,
  };
}

function expirationToYmd(value: unknown): string | null {
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (match) return match[1];
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return epochToNewYorkDate(asNumber);
    return null;
  }
  if (typeof value === "number") return epochToNewYorkDate(value);
  return null;
}

function epochToNewYorkDate(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
