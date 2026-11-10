import { get, put } from "@vercel/blob";
import {
  parseStoredMarketDataHealth,
  type MarketDataHealth,
} from "@/app/lib/marketDataHealth";

/**
 * In-memory Tastytrade access token for this process, plus the Blob status
 * record the scanner already uses for documents. The access token is not
 * written to Blob and is not reused across invocations. The refresh token
 * is never written. The status record has no secrets. Nothing here places
 * an order.
 */

/** Retired pathname. Access tokens are not stored here. */
export const TASTYTRADE_ACCESS_BLOB = "tastytrade/access.json";
export const MARKET_DATA_STATUS_BLOB = "tastytrade/market-data-status.json";

export interface PersistedAccess {
  access: string;
  mintedAt: number;
  expiresAt: number;
}

const EXPIRY_BUFFER_MS = 60_000;

let memoryAccess: PersistedAccess | null = null;
let statusWarned = false;

export function resetTastytradeStoreForTests(): void {
  memoryAccess = null;
  statusWarned = false;
}

function blobToken(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function statusPersistEnabled(): boolean {
  return process.env.VITEST !== "true" && blobToken() != null;
}

function usable(token: PersistedAccess | null, now: number): token is PersistedAccess {
  return token != null && typeof token.access === "string" && token.access.length > 0 && now < token.expiresAt - EXPIRY_BUFFER_MS;
}

async function readPrivateText(pathname: string): Promise<string | null> {
  const token = blobToken();
  if (!token) return null;
  try {
    const result = await get(pathname, { access: "private", token, useCache: false });
    if (!result || !result.stream) return null;
    return await new Response(result.stream).text();
  } catch {
    return null;
  }
}

async function writePrivateText(pathname: string, body: string): Promise<void> {
  const token = blobToken();
  if (!token) return;
  await put(pathname, body, {
    access: "private",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

/** In-memory hit for this process. Never reads Blob. Null when missing or expired. */
export async function readStoredTastytradeAccess(now = Date.now()): Promise<PersistedAccess | null> {
  if (usable(memoryAccess, now)) return memoryAccess;
  return null;
}

/**
 * Remember the access token for this process only.
 * The refresh token is not part of this record and is never written.
 */
export async function writeStoredTastytradeAccess(token: PersistedAccess): Promise<void> {
  if (!token.access) return;
  memoryAccess = { access: token.access, mintedAt: token.mintedAt, expiresAt: token.expiresAt };
}

/** Forget this process's copy of `access`. */
export function dropMemoryAccessIf(access: string): void {
  if (!memoryAccess || memoryAccess.access === access) memoryAccess = null;
}

/** Drop this access token from memory when it is still the cached one. Blob is not touched. */
export async function clearStoredTastytradeAccess(access: string): Promise<void> {
  if (memoryAccess && memoryAccess.access !== access) return;
  memoryAccess = null;
}

export async function readStoredMarketDataHealth(): Promise<MarketDataHealth | null> {
  const text = await readPrivateText(MARKET_DATA_STATUS_BLOB);
  if (!text) return null;
  try {
    return parseStoredMarketDataHealth(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function writeStoredMarketDataHealth(health: MarketDataHealth): Promise<void> {
  if (!statusPersistEnabled()) return;
  try {
    await writePrivateText(MARKET_DATA_STATUS_BLOB, JSON.stringify(health));
  } catch {
    if (!statusWarned) {
      statusWarned = true;
      console.warn("Market data status was not saved.");
    }
  }
}
