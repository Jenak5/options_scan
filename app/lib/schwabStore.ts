import { BlobPreconditionFailedError, del, get, put } from "@vercel/blob";
import type { StoredTokens } from "@/app/lib/schwabParse";
import {
  SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
  SCHWAB_BLOB_TOKEN_ENV,
  SCHWAB_BLOB_TOKEN_PATH,
  SCHWAB_KV_TOKEN_ENV,
  SCHWAB_KV_URL_ENV,
  SCHWAB_UPSTASH_TOKEN_ENV,
  SCHWAB_UPSTASH_URL_ENV,
  type SchwabStoreKind,
} from "@/app/lib/schwabStorage";

/**
 * Server-side Schwab token store.
 *
 * Production, in order: a complete Vercel KV pair, a complete Upstash Redis
 * pair (same REST API), then a private Vercel Blob store
 * (BLOB_READ_WRITE_TOKEN). The token JSON is encrypted with a key derived
 * from SESSION_SECRET before it is written. Values are never logged.
 *
 * Blob reads pass useCache: false so a refresh does not follow a stale CDN
 * copy. A refresh re-reads and uses ifMatch so a concurrent request cannot
 * overwrite a newer refresh token. An unreadable blob is deleted with
 * ifMatch before a new envelope is written.
 *
 * Fallback: process memory, and only outside production. A serverless
 * instance does not share that memory, so production without KV, Upstash,
 * or Blob reports storage as not configured and refuses to pretend a token
 * was saved.
 */

export interface AlertMeta {
  expiryAlertAt: number | null;
  refreshFailAlertAt: number | null;
}

export type StoreKind = SchwabStoreKind;

const TOKEN_KEY = "oes:schwab:tokens";
const ALERT_KEY = "oes:schwab:alerts";
const BLOB_WRITE_ATTEMPTS = 4;

interface MemoryBag {
  tokens: StoredTokens | null;
  alerts: AlertMeta;
}

interface TokenEnvelope {
  cipher: string | null;
  alerts: AlertMeta;
}

export interface SchwabBlobPutOptions {
  access: "private";
  allowOverwrite: true;
  addRandomSuffix: false;
  cacheControlMaxAge: number;
  contentType: "application/json";
  token: string;
  ifMatch?: string;
}

export interface SchwabBlobGetOptions {
  access: "private";
  useCache: false;
  token: string;
}

interface SchwabBlobDelOptions {
  token: string;
  ifMatch?: string;
}

export interface SchwabBlobGetResult {
  statusCode: number;
  stream: ReadableStream<Uint8Array> | null;
  blob: { etag: string; pathname: string };
}

export interface SchwabBlobClient {
  put(pathname: string, body: string, options: SchwabBlobPutOptions): Promise<unknown>;
  get(pathname: string, options: SchwabBlobGetOptions): Promise<SchwabBlobGetResult | null>;
  del(pathname: string, options: SchwabBlobDelOptions): Promise<void>;
}

type BlobRead =
  | { state: "missing" }
  | { state: "error" }
  | { state: "corrupt"; etag: string }
  | { state: "ok"; etag: string; envelope: TokenEnvelope };

const EMPTY_ALERTS: AlertMeta = { expiryAlertAt: null, refreshFailAlertAt: null };

function defaultBlobClient(): SchwabBlobClient {
  return {
    put(pathname, body, options) {
      return put(pathname, body, options);
    },
    get(pathname, options) {
      return get(pathname, options);
    },
    del(pathname, options) {
      return del(pathname, options);
    },
  };
}

let blobClient: SchwabBlobClient = defaultBlobClient();

/** Tests inject a fake put/get/del client. Pass null to restore the SDK. */
export function setSchwabBlobClientForTests(next: SchwabBlobClient | null): void {
  blobClient = next ?? defaultBlobClient();
}

function memoryBag(): MemoryBag {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  if (!g.__oesSchwabMemory) {
    g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS } };
  }
  return g.__oesSchwabMemory;
}

export function clearMemoryStoreForTests(): void {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS } };
}

function envPair(urlName: string, tokenName: string): { url: string; token: string } | null {
  const url = process.env[urlName]?.trim() ?? "";
  const token = process.env[tokenName]?.trim() ?? "";
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

export function kvRestConfig(): { url: string; token: string } | null {
  return envPair(SCHWAB_KV_URL_ENV, SCHWAB_KV_TOKEN_ENV)
    ?? envPair(SCHWAB_UPSTASH_URL_ENV, SCHWAB_UPSTASH_TOKEN_ENV);
}

function blobConfigured(): boolean {
  return (process.env[SCHWAB_BLOB_TOKEN_ENV]?.trim() ?? "").length > 0;
}

/** Production and Vercel do not keep a durable process, so memory is not a store. */
export function durableStoreRequired(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

export function resolveStoreKind(): StoreKind {
  if (kvRestConfig()) return "kv";
  if (blobConfigured()) return "blob";
  if (durableStoreRequired()) return "unconfigured";
  return "memory";
}

export async function readTokens(): Promise<StoredTokens | null> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return null;
  if (kind === "memory") return memoryBag().tokens;
  if (kind === "blob") return readBlobTokens();
  try {
    const raw = await kvCommand(["GET", TOKEN_KEY]);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const json = await decryptTokenPayload(raw);
    return parseStored(json);
  } catch {
    console.error("Schwab token store could not be read");
    return null;
  }
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new Error("Refusing to store an empty Schwab token");
  }
  const kind = resolveStoreKind();
  if (kind === "unconfigured") {
    throw new Error("Schwab token storage is not configured");
  }
  if (kind === "memory") {
    memoryBag().tokens = tokens;
    return;
  }
  const cipher = await encryptTokenPayload(JSON.stringify(tokens));
  if (kind === "blob") {
    await updateBlobEnvelope((envelope) => ({ ...envelope, cipher }));
    return;
  }
  await kvCommand(["SET", TOKEN_KEY, cipher]);
}

/**
 * Persist a refresh without clobbering a newer refresh token.
 * Re-reads first. Blob writes also send the etag from that read (ifMatch).
 * When the stored refresh token already changed, the stored record is kept.
 */
export async function commitRefreshedTokens(basis: StoredTokens, next: StoredTokens): Promise<StoredTokens> {
  if (!next.accessToken || !next.refreshToken) {
    throw new Error("Refusing to store an empty Schwab token");
  }
  const kind = resolveStoreKind();
  if (kind === "unconfigured") {
    throw new Error("Schwab token storage is not configured");
  }
  if (kind !== "blob") {
    const latest = await readTokens();
    if (latest && keepStoredTokens(latest, basis, next)) return latest;
    await writeTokens(next);
    return next;
  }
  const token = requireBlobToken();
  for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt++) {
    const read = await readBlobRecord(token);
    if (read.state === "error") throw new Error("Schwab token store could not be read");
    if (read.state === "corrupt") {
      const removed = await deleteBlobIfMatch(token, read.etag);
      if (!removed) continue;
      const again = await readBlobRecord(token);
      if (again.state !== "missing") continue;
      await putEnvelope(token, { cipher: await encryptTokenPayload(JSON.stringify(next)), alerts: { ...EMPTY_ALERTS } });
      return next;
    }
    const latest = read.state === "ok" ? await tokensFromCipher(read.envelope.cipher) : null;
    if (latest && keepStoredTokens(latest, basis, next)) return latest;
    const envelope = read.state === "ok" ? read.envelope : { cipher: null, alerts: { ...EMPTY_ALERTS } };
    const etag = read.state === "ok" ? read.etag : undefined;
    try {
      await putEnvelope(token, {
        cipher: await encryptTokenPayload(JSON.stringify(next)),
        alerts: envelope.alerts,
      }, etag);
      return next;
    } catch (err) {
      if (!isPreconditionFailed(err) || attempt === BLOB_WRITE_ATTEMPTS - 1) throw err;
    }
  }
  throw new Error("Schwab token store could not be updated");
}

function keepStoredTokens(latest: StoredTokens, basis: StoredTokens, next: StoredTokens): boolean {
  if (latest.refreshToken !== basis.refreshToken) return true;
  return latest.accessExpiresAt > next.accessExpiresAt;
}

export async function readAlertMeta(): Promise<AlertMeta> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return { ...EMPTY_ALERTS };
  if (kind === "memory") return memoryBag().alerts;
  if (kind === "blob") {
    const token = blobToken();
    if (!token) return { ...EMPTY_ALERTS };
    const read = await readBlobRecord(token);
    if (read.state !== "ok") return { ...EMPTY_ALERTS };
    return read.envelope.alerts;
  }
  try {
    const raw = await kvCommand(["GET", ALERT_KEY]);
    if (typeof raw !== "string" || raw.length === 0) return { ...EMPTY_ALERTS };
    return parseAlerts(raw);
  } catch {
    return { ...EMPTY_ALERTS };
  }
}

export async function writeAlertMeta(meta: AlertMeta): Promise<void> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return;
  if (kind === "memory") {
    memoryBag().alerts = meta;
    return;
  }
  if (kind === "blob") {
    await updateBlobEnvelope((envelope) => ({ ...envelope, alerts: meta }));
    return;
  }
  await kvCommand(["SET", ALERT_KEY, JSON.stringify(meta)]);
}

export async function encryptTokenPayload(json: string): Promise<string> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json)),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToBase64(packed);
}

export async function decryptTokenPayload(payload: string): Promise<string> {
  const key = await aesKey();
  const packed = base64ToBytes(payload);
  if (packed.length < 13) throw new Error("Schwab token payload is unreadable");
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

async function readBlobTokens(): Promise<StoredTokens | null> {
  const token = blobToken();
  if (!token) return null;
  const read = await readBlobRecord(token);
  if (read.state !== "ok") return null;
  return tokensFromCipher(read.envelope.cipher);
}

async function tokensFromCipher(cipher: string | null): Promise<StoredTokens | null> {
  if (!cipher) return null;
  try {
    const json = await decryptTokenPayload(cipher);
    return parseStored(json);
  } catch {
    console.error("Schwab token store could not be read");
    return null;
  }
}

async function updateBlobEnvelope(change: (envelope: TokenEnvelope) => TokenEnvelope): Promise<void> {
  const token = requireBlobToken();
  for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt++) {
    const read = await readBlobRecord(token);
    if (read.state === "error") throw new Error("Schwab token store could not be read");
    if (read.state === "corrupt") {
      const removed = await deleteBlobIfMatch(token, read.etag);
      if (!removed) continue;
      const again = await readBlobRecord(token);
      if (again.state !== "missing") continue;
      await putEnvelope(token, change({ cipher: null, alerts: { ...EMPTY_ALERTS } }));
      return;
    }
    const envelope = read.state === "ok" ? read.envelope : { cipher: null, alerts: { ...EMPTY_ALERTS } };
    const etag = read.state === "ok" ? read.etag : undefined;
    try {
      await putEnvelope(token, change(envelope), etag);
      return;
    } catch (err) {
      if (!isPreconditionFailed(err) || attempt === BLOB_WRITE_ATTEMPTS - 1) throw err;
    }
  }
  throw new Error("Schwab token store could not be updated");
}

async function readBlobRecord(token: string): Promise<BlobRead> {
  let result: SchwabBlobGetResult | null;
  try {
    result = await blobClient.get(SCHWAB_BLOB_TOKEN_PATH, {
      access: "private",
      useCache: false,
      token,
    });
  } catch {
    console.error("Schwab token store could not be read");
    return { state: "error" };
  }
  if (!result) return { state: "missing" };
  if (result.statusCode !== 200 || !result.stream) {
    console.error("Schwab token store could not be read");
    return { state: "error" };
  }
  let text: string;
  try {
    text = await new Response(result.stream).text();
  } catch {
    console.error("Schwab token store could not be read");
    return { state: "error" };
  }
  const etag = result.blob.etag;
  const envelope = parseEnvelope(text);
  if (!envelope) return { state: "corrupt", etag };
  return { state: "ok", etag, envelope };
}

async function putEnvelope(token: string, envelope: TokenEnvelope, etag?: string): Promise<void> {
  await blobClient.put(SCHWAB_BLOB_TOKEN_PATH, JSON.stringify(envelope), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
    contentType: "application/json",
    token,
    ...(etag ? { ifMatch: etag } : {}),
  });
}

async function deleteBlobIfMatch(token: string, etag: string): Promise<boolean> {
  try {
    await blobClient.del(SCHWAB_BLOB_TOKEN_PATH, { token, ...(etag ? { ifMatch: etag } : {}) });
    return true;
  } catch (err) {
    if (isPreconditionFailed(err)) return false;
    throw err;
  }
}

function requireBlobToken(): string {
  const token = blobToken();
  if (!token) throw new Error("Schwab token storage is not configured");
  return token;
}

function blobToken(): string {
  return process.env[SCHWAB_BLOB_TOKEN_ENV]?.trim() ?? "";
}

function isPreconditionFailed(err: unknown): boolean {
  return err instanceof BlobPreconditionFailedError;
}

function parseEnvelope(text: string): TokenEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as { cipher?: unknown; alerts?: unknown };
  if (row.cipher != null && typeof row.cipher !== "string") return null;
  const alerts = row.alerts == null ? { ...EMPTY_ALERTS } : parseAlerts(JSON.stringify(row.alerts));
  return {
    cipher: typeof row.cipher === "string" && row.cipher.length > 0 ? row.cipher : null,
    alerts,
  };
}

async function aesKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET?.trim() ?? "";
  if (!secret) throw new Error("SESSION_SECRET is required to store Schwab tokens");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`oes-schwab-tokens.v1.${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function kvCommand(command: string[]): Promise<unknown> {
  const cfg = kvRestConfig();
  if (!cfg) throw new Error("Token store is not configured");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Token store request failed (${res.status})`);
  const payload: unknown = await res.json();
  if (!payload || typeof payload !== "object") return null;
  return (payload as { result?: unknown }).result ?? null;
}

function parseStored(json: string): StoredTokens | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Partial<StoredTokens>;
  if (typeof row.accessToken !== "string" || typeof row.refreshToken !== "string") return null;
  if (typeof row.accessExpiresAt !== "number" || typeof row.refreshExpiresAt !== "number") return null;
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    accessExpiresAt: row.accessExpiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
  };
}

function parseAlerts(json: string): AlertMeta {
  try {
    const parsed = JSON.parse(json) as Partial<AlertMeta>;
    return {
      expiryAlertAt: typeof parsed.expiryAlertAt === "number" ? parsed.expiryAlertAt : null,
      refreshFailAlertAt: typeof parsed.refreshFailAlertAt === "number" ? parsed.refreshFailAlertAt : null,
    };
  } catch {
    return { ...EMPTY_ALERTS };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
