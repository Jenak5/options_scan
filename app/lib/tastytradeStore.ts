import { del, get, put } from "@vercel/blob";
import { decryptTokenPayload, encryptTokenPayload } from "@/app/lib/schwabStore";
import {
  parseStoredMarketDataHealth,
  type MarketDataHealth,
} from "@/app/lib/marketDataHealth";

/**
 * Private Blob cache for the Tastytrade access token and the market-data
 * status record. Same store the scanner already uses for documents.
 * The access token is encrypted with SESSION_SECRET. The status record has
 * no secrets. Nothing here places an order.
 */

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

function persistEnabled(): boolean {
  return process.env.VITEST !== "true" && blobToken() != null && (process.env.SESSION_SECRET?.trim() ?? "").length > 0;
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

/** In-memory hit, then the encrypted blob. Null when missing or expired. */
export async function readStoredTastytradeAccess(now = Date.now()): Promise<PersistedAccess | null> {
  if (usable(memoryAccess, now)) return memoryAccess;
  if (!persistEnabled()) return null;
  const text = await readPrivateText(TASTYTRADE_ACCESS_BLOB);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { cipher?: unknown };
    if (typeof parsed.cipher !== "string") return null;
    const plain = JSON.parse(await decryptTokenPayload(parsed.cipher)) as Partial<PersistedAccess>;
    const token: PersistedAccess = {
      access: typeof plain.access === "string" ? plain.access : "",
      mintedAt: typeof plain.mintedAt === "number" ? plain.mintedAt : 0,
      expiresAt: typeof plain.expiresAt === "number" ? plain.expiresAt : 0,
    };
    if (!usable(token, now)) return null;
    memoryAccess = token;
    return token;
  } catch {
    return null;
  }
}

/**
 * Remember the access token for this instance and, when Blob and
 * SESSION_SECRET are set, encrypt it into the existing store.
 * The refresh token is not written. Failures are not logged with the token.
 */
export async function writeStoredTastytradeAccess(token: PersistedAccess): Promise<void> {
  if (!token.access) return;
  memoryAccess = { access: token.access, mintedAt: token.mintedAt, expiresAt: token.expiresAt };
  if (!persistEnabled()) return;
  try {
    const cipher = await encryptTokenPayload(JSON.stringify(memoryAccess));
    await writePrivateText(TASTYTRADE_ACCESS_BLOB, JSON.stringify({ cipher }));
  } catch {
    console.warn("Tastytrade access token cache was not written.");
  }
}

/** Forget this instance's copy of `access` without touching the blob. */
export function dropMemoryAccessIf(access: string): void {
  if (!memoryAccess || memoryAccess.access === access) memoryAccess = null;
}

/** Drop this access token from memory and from the blob, when it is still the cached one. */
export async function clearStoredTastytradeAccess(access: string): Promise<void> {
  if (memoryAccess && memoryAccess.access !== access) return;
  memoryAccess = null;
  const token = blobToken();
  if (!token || process.env.VITEST === "true") return;
  try {
    await del(TASTYTRADE_ACCESS_BLOB, { token });
  } catch {
    // A missing blob is fine. Do not log the client error; it can echo the store token.
  }
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
