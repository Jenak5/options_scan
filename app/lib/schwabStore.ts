import { PRINT_RULES } from "@/app/lib/alertConfig";
import {
  BlobAccessError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  del,
  get,
  head as blobHead,
  put,
} from "@vercel/blob";
import type { StoredTokens } from "@/app/lib/schwabParse";
import {
  SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
  SCHWAB_BLOB_ALERT_BOOK_PATH,
  SCHWAB_BLOB_FLOW_PATH,
  SCHWAB_BLOB_STORE_STATUS_PATH,
  SCHWAB_BLOB_TRADE_LOG_PATH,
  SCHWAB_BLOB_TOKEN_ENV,
  SCHWAB_BLOB_TOKEN_PATH,
  SCHWAB_KV_TOKEN_ENV,
  SCHWAB_KV_URL_ENV,
  SCHWAB_UPSTASH_TOKEN_ENV,
  SCHWAB_UPSTASH_URL_ENV,
  type SchwabStoreKind,
} from "@/app/lib/schwabStorage";
import type { AlertBookNotice } from "@/app/lib/storeStatus";

/**
 * Server-side Schwab token store.
 *
 * Production, in order: a complete Vercel KV pair, a complete Upstash Redis
 * pair (same REST API), then a private Vercel Blob store
 * (BLOB_READ_WRITE_TOKEN). The token JSON is encrypted with a key derived
 * from SESSION_SECRET before it is written. Values are never logged.
 *
 * Blob reads pass useCache: false so a refresh does not follow a stale CDN
 * copy. That flag only adds ?cache=0. It does not change the ETag.
 * get() returns the download response's ETag header, which is a weak
 * validator once the body is compressed, and that value is not the strong
 * ETag put() compares. head() and put() return the strong ETag from the
 * Blob API. Conditional writes use head(). A 412 is retried with a fresh
 * head. Alert book, flow snapshots, and the trade log then write once
 * without ifMatch. Token envelopes never do that. An unreadable token blob
 * is deleted with ifMatch before a new envelope is written.
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
const FLOW_SNAPSHOT_KEY = "oes:flow:snapshots";
const ALERT_BOOK_KEY = "oes:alert:records";
const TRADE_LOG_KEY = "oes:trade:log";
const BLOB_WRITE_ATTEMPTS = 4;
const JSON_CONDITIONAL_ATTEMPTS = 3;
const STORE_STATUS_KEY = "oes:store:status";
const FLOW_SNAPSHOT_MAX_TICKERS = 40;
const FLOW_SNAPSHOT_MAX_CONTRACTS = 500;

export interface FlowVolumeSnapshot {
  scannedAt: number;
  volumes: Record<string, number>;
  /** Recent chain quotes per contract. Absent on snapshots saved before print detection. */
  quotes?: Record<string, StoredQuotePoint[]>;
}

interface StoredQuotePoint {
  at: number;
  volume: number;
  last: number | null;
  lastSize: number | null;
  bid: number | null;
  ask: number | null;
  tradeTime: number | null;
}

/** Prior option volume by ticker. Separate from the token envelope. */
export type FlowSnapshotBook = Record<string, FlowVolumeSnapshot>;

interface MemoryBag {
  tokens: StoredTokens | null;
  alerts: AlertMeta;
  flowSnapshots: FlowSnapshotBook;
  alertBook: string | null;
  tradeLog: string | null;
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

export interface SchwabBlobHeadOptions {
  token: string;
}

export interface SchwabBlobHeadResult {
  etag: string;
}

export interface SchwabBlobClient {
  put(pathname: string, body: string, options: SchwabBlobPutOptions): Promise<unknown>;
  get(pathname: string, options: SchwabBlobGetOptions): Promise<SchwabBlobGetResult | null>;
  del(pathname: string, options: SchwabBlobDelOptions): Promise<void>;
  /**
   * Blob API metadata. Its etag is the strong value ifMatch accepts.
   * Optional so older test doubles still work when get() already returns a strong etag.
   */
  head?(pathname: string, options: SchwabBlobHeadOptions): Promise<SchwabBlobHeadResult | null>;
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
    async head(pathname, options) {
      try {
        const result = await blobHead(pathname, { token: options.token });
        return { etag: result.etag };
      } catch (err) {
        if (err instanceof BlobNotFoundError) return null;
        throw err;
      }
    },
  };
}

let blobClient: SchwabBlobClient = defaultBlobClient();
let memoryStoreStatus: PersistedStoreStatus | null = null;

/** Tests inject a fake put/get/del client. Pass null to restore the SDK. */
export function setSchwabBlobClientForTests(next: SchwabBlobClient | null): void {
  blobClient = next ?? defaultBlobClient();
}

function memoryBag(): MemoryBag {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  if (!g.__oesSchwabMemory) {
    g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS }, flowSnapshots: {}, alertBook: null, tradeLog: null };
  } else if (!g.__oesSchwabMemory.flowSnapshots) {
    g.__oesSchwabMemory.flowSnapshots = {};
  }
  if (g.__oesSchwabMemory.alertBook === undefined) g.__oesSchwabMemory.alertBook = null;
  if (g.__oesSchwabMemory.tradeLog === undefined) g.__oesSchwabMemory.tradeLog = null;
  return g.__oesSchwabMemory;
}

export function clearMemoryStoreForTests(): void {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS }, flowSnapshots: {}, alertBook: null, tradeLog: null };
  memoryStoreStatus = null;
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
  } catch (err) {
    logStoreFailure("Schwab token store could not be read", err);
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
      if (!read.etag) throw new Error("Schwab token store etag could not be confirmed");
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
    if (read.state === "ok" && !etag) throw new Error("Schwab token store etag could not be confirmed");
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

export async function readFlowSnapshots(): Promise<FlowSnapshotBook> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return {};
  if (kind === "memory") return cloneFlowBook(memoryBag().flowSnapshots);
  if (kind === "blob") return readBlobFlowSnapshots();
  try {
    const raw = await kvCommand(["GET", FLOW_SNAPSHOT_KEY]);
    if (typeof raw !== "string" || raw.length === 0) return {};
    return parseFlowBook(raw);
  } catch (err) {
    logStoreFailure("Flow snapshot store could not be read", err);
    return {};
  }
}

/**
 * Merge volume snapshots for the tickers in `patch`.
 * Other tickers already stored are left in place. A failed write does not throw:
 * the scan can still return, and the next poll treats the jump as unknown.
 */
export async function writeFlowSnapshots(patch: FlowSnapshotBook): Promise<void> {
  const clean = sanitizeFlowBook(patch);
  if (Object.keys(clean).length === 0) return;
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return;
  if (kind === "memory") {
    memoryBag().flowSnapshots = trimFlowBook({ ...memoryBag().flowSnapshots, ...clean });
    return;
  }
  if (kind === "blob") {
    await writeBlobFlowSnapshots(clean);
    return;
  }
  try {
    const current = await readFlowSnapshots();
    await kvCommand(["SET", FLOW_SNAPSHOT_KEY, JSON.stringify(trimFlowBook({ ...current, ...clean }))]);
  } catch (err) {
    await recordStoreFailure("flow-snapshots", "write", err);
  }
}

/**
 * Sent-alert book. Same store order as tokens: KV, then Upstash, then private Blob.
 * The JSON is alert records. It is not a token. The daily stop reads the trade log.
 * A failed read does not overwrite the book.
 */
export async function readAlertBookText(): Promise<string | null> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return null;
  if (kind === "memory") return memoryBag().alertBook;
  if (kind === "blob") {
    const token = blobToken();
    if (!token) return null;
    const read = await readBlobJson(SCHWAB_BLOB_ALERT_BOOK_PATH, token);
    if (read.state === "error") {
      await recordStoreFailure("alert-book", "read", read.error);
      return null;
    }
    if (read.state !== "ok") return null;
    return read.text;
  }
  try {
    const raw = await kvCommand(["GET", ALERT_BOOK_KEY]);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch (err) {
    await recordStoreFailure("alert-book", "read", err);
    return null;
  }
}

export async function updateAlertBook(change: (current: string | null) => string | null): Promise<boolean> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") {
    await recordStoreFailure("alert-book", "write", new Error("Alert book storage is not configured"));
    return false;
  }
  const guarded = (current: string | null): string | null => {
    if (!hasJsonArray(current, "records")) return null;
    return change(current);
  };
  if (kind === "memory") {
    const bag = memoryBag();
    const next = guarded(bag.alertBook);
    if (next == null) {
      await recordStoreFailure("alert-book", "write", new Error("Refusing to overwrite an unreadable alert book"));
      return false;
    }
    bag.alertBook = next;
    await clearStoreFailure("alert-book");
    return true;
  }
  if (kind === "blob") return updateBlobAlertBook(guarded);
  let current: string | null;
  try {
    const raw = await kvCommand(["GET", ALERT_BOOK_KEY]);
    current = typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch (err) {
    await recordStoreFailure("alert-book", "read", err);
    return false;
  }
  const next = guarded(current);
  if (next == null) {
    await recordStoreFailure("alert-book", "write", new Error("Refusing to overwrite an unreadable alert book"));
    return false;
  }
  try {
    await kvCommand(["SET", ALERT_BOOK_KEY, next]);
    await clearStoreFailure("alert-book");
    return true;
  } catch (err) {
    await recordStoreFailure("alert-book", "write", err);
    return false;
  }
}

/**
 * Manual trade log. Same store order as the alert book. Not a token.
 * A failed read does not overwrite the log.
 */
export async function readTradeLogText(): Promise<string | null> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return null;
  if (kind === "memory") return memoryBag().tradeLog;
  if (kind === "blob") {
    const token = blobToken();
    if (!token) return null;
    const read = await readBlobJson(SCHWAB_BLOB_TRADE_LOG_PATH, token);
    if (read.state === "error") {
      await recordStoreFailure("trade-log", "read", read.error);
      return null;
    }
    if (read.state !== "ok") return null;
    return read.text;
  }
  try {
    const raw = await kvCommand(["GET", TRADE_LOG_KEY]);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch (err) {
    await recordStoreFailure("trade-log", "read", err);
    return null;
  }
}

export async function updateTradeLog(change: (current: string | null) => string): Promise<boolean> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") {
    await recordStoreFailure("trade-log", "write", new Error("Trade log storage is not configured"));
    return false;
  }
  const guarded = (current: string | null): string | null => {
    if (!hasJsonArray(current, "trades")) return null;
    return change(current);
  };
  if (kind === "memory") {
    const bag = memoryBag();
    const next = guarded(bag.tradeLog);
    if (next == null) {
      await recordStoreFailure("trade-log", "write", new Error("Refusing to overwrite an unreadable trade log"));
      return false;
    }
    bag.tradeLog = next;
    await clearStoreFailure("trade-log");
    return true;
  }
  if (kind === "blob") return writeBlobJson(SCHWAB_BLOB_TRADE_LOG_PATH, "trade-log", "Trade log", guarded);
  let current: string | null;
  try {
    const raw = await kvCommand(["GET", TRADE_LOG_KEY]);
    current = typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch (err) {
    await recordStoreFailure("trade-log", "read", err);
    return false;
  }
  const next = guarded(current);
  if (next == null) {
    await recordStoreFailure("trade-log", "write", new Error("Refusing to overwrite an unreadable trade log"));
    return false;
  }
  try {
    await kvCommand(["SET", TRADE_LOG_KEY, next]);
    await clearStoreFailure("trade-log");
    return true;
  } catch (err) {
    await recordStoreFailure("trade-log", "write", err);
    return false;
  }
}

async function updateBlobAlertBook(change: (current: string | null) => string | null): Promise<boolean> {
  return writeBlobJson(SCHWAB_BLOB_ALERT_BOOK_PATH, "alert-book", "Alert book", change);
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
  } catch (err) {
    logStoreFailure("Schwab token store could not be read", err);
    return null;
  }
}

async function updateBlobEnvelope(change: (envelope: TokenEnvelope) => TokenEnvelope): Promise<void> {
  const token = requireBlobToken();
  for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt++) {
    const read = await readBlobRecord(token);
    if (read.state === "error") throw new Error("Schwab token store could not be read");
    if (read.state === "corrupt") {
      if (!read.etag) throw new Error("Schwab token store etag could not be confirmed");
      const removed = await deleteBlobIfMatch(token, read.etag);
      if (!removed) continue;
      const again = await readBlobRecord(token);
      if (again.state !== "missing") continue;
      await putEnvelope(token, change({ cipher: null, alerts: { ...EMPTY_ALERTS } }));
      return;
    }
    const envelope = read.state === "ok" ? read.envelope : { cipher: null, alerts: { ...EMPTY_ALERTS } };
    const etag = read.state === "ok" ? read.etag : undefined;
    if (read.state === "ok" && !etag) throw new Error("Schwab token store etag could not be confirmed");
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
  } catch (err) {
    logStoreFailure("Schwab token store could not be read", err);
    return { state: "error" };
  }
  if (!result) return { state: "missing" };
  if (result.statusCode !== 200 || !result.stream) {
    logStoreFailure("Schwab token store could not be read", new Error(`Blob read failed (status ${result.statusCode})`));
    return { state: "error" };
  }
  let text: string;
  try {
    text = await new Response(result.stream).text();
  } catch (err) {
    logStoreFailure("Schwab token store could not be read", err);
    return { state: "error" };
  }
  const etag = (await strongMatchToken(SCHWAB_BLOB_TOKEN_PATH, token, result.blob.etag)) ?? "";
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

/**
 * get() in @vercel/blob 2.8.0 copies the download response's ETag header.
 * useCache: false only appends ?cache=0. Once the body is compressed that
 * header is a weak validator (W/"..."), and the quoted value is the
 * representation validator, not the blob's strong ETag. Stripping W/ does
 * not produce the string put() accepts as x-if-match.
 * head() and put() return response.etag from the Blob API JSON. That is the
 * strong ETag. A weak value is ignored here on purpose.
 */
function strongApiEtag(etag: string | null | undefined): string | undefined {
  if (!etag) return undefined;
  const value = etag.trim();
  if (!value || value.startsWith("W/") || value.startsWith("w/")) return undefined;
  return value;
}

async function strongMatchToken(pathname: string, token: string, downloadEtag: string | undefined): Promise<string | undefined> {
  if (blobClient.head) {
    try {
      const meta = await blobClient.head(pathname, { token });
      const fromHead = strongApiEtag(meta?.etag);
      if (fromHead) return fromHead;
    } catch (err) {
      if (!(err instanceof BlobNotFoundError)) {
        logStoreFailure("Blob metadata could not be read", err);
      }
    }
  }
  return strongApiEtag(downloadEtag);
}

function storeErrorStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const record = err as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === "number") return record.status;
    if (typeof record.statusCode === "number") return record.statusCode;
  }
  if (err instanceof BlobPreconditionFailedError) return 412;
  if (err instanceof BlobAccessError || err instanceof BlobStoreSuspendedError) return 403;
  if (err instanceof BlobNotFoundError || err instanceof BlobStoreNotFoundError) return 404;
  return null;
}

function redactSecrets(text: string): string {
  let out = text
    .replace(/vercel_blob_[A-Za-z0-9_]+/g, "[token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [token]");
  const blobTokenValue = process.env[SCHWAB_BLOB_TOKEN_ENV]?.trim() ?? "";
  if (blobTokenValue.length > 8) out = out.split(blobTokenValue).join("[token]");
  return out;
}

function logStoreFailure(sentence: string, err: unknown): void {
  const message = redactSecrets(err instanceof Error ? err.message : "Unknown error");
  const status = storeErrorStatus(err);
  console.error(status == null ? `${sentence}: ${message}` : `${sentence}: ${message} (status ${status})`);
}

async function readBlobFlowSnapshots(): Promise<FlowSnapshotBook> {
  const token = blobToken();
  if (!token) return {};
  const read = await readBlobJson(SCHWAB_BLOB_FLOW_PATH, token);
  if (read.state === "error") {
    await recordStoreFailure("flow-snapshots", "read", read.error);
    return {};
  }
  if (read.state !== "ok") return {};
  return parseFlowBook(read.text);
}

async function writeBlobFlowSnapshots(patch: FlowSnapshotBook): Promise<void> {
  await writeBlobJson(SCHWAB_BLOB_FLOW_PATH, "flow-snapshots", "Flow snapshot store", (current) => {
    if (current != null && current.trim() !== "" && !isJsonObject(current)) return null;
    const book = current ? parseFlowBook(current) : {};
    return JSON.stringify(trimFlowBook({ ...book, ...patch }));
  });
}

async function readBlobJson(pathname: string, token: string): Promise<
  | { state: "missing" }
  | { state: "error"; error: unknown }
  | { state: "ok"; downloadEtag: string; text: string }
> {
  let result: SchwabBlobGetResult | null;
  try {
    result = await blobClient.get(pathname, {
      access: "private",
      useCache: false,
      token,
    });
  } catch (err) {
    return { state: "error", error: err };
  }
  if (!result || result.statusCode === 404) return { state: "missing" };
  if (result.statusCode !== 200 || !result.stream) {
    return { state: "error", error: new Error(`Blob read failed (status ${result.statusCode})`) };
  }
  try {
    const text = await new Response(result.stream).text();
    return { state: "ok", downloadEtag: result.blob.etag, text };
  } catch (err) {
    return { state: "error", error: err };
  }
}

type JsonStoreTarget = "alert-book" | "flow-snapshots" | "trade-log";

interface StoreFailureRecord {
  target: JsonStoreTarget;
  operation: "read" | "write";
  at: number;
  status: number | null;
  message: string;
}

interface PersistedStoreStatus {
  failures: Partial<Record<JsonStoreTarget, StoreFailureRecord>>;
  alertsSentUnsavedAt: number | null;
}

const JSON_STORE_TARGETS: JsonStoreTarget[] = ["alert-book", "flow-snapshots", "trade-log"];

/**
 * Conditional put using the strong etag from head(). On 412, re-read and retry.
 * The last attempt writes with no ifMatch. A lost race is acceptable. A save
 * that never lands is not. A null body refuses the write so unreadable JSON
 * is not replaced with an empty book.
 */
async function writeBlobJson(
  pathname: string,
  target: JsonStoreTarget,
  label: string,
  change: (current: string | null) => string | null,
): Promise<boolean> {
  const token = blobToken();
  if (!token) {
    await recordStoreFailure(target, "write", new Error(`${label} storage is not configured`));
    return false;
  }
  for (let attempt = 0; attempt < JSON_CONDITIONAL_ATTEMPTS; attempt++) {
    const wrote = await attemptJsonPut(pathname, token, target, label, change, true);
    if (wrote === "ok") {
      await clearStoreFailure(target);
      return true;
    }
    if (wrote === "stop") return false;
  }
  const wrote = await attemptJsonPut(pathname, token, target, label, change, false);
  if (wrote === "ok") {
    await clearStoreFailure(target);
    return true;
  }
  return false;
}

async function attemptJsonPut(
  pathname: string,
  token: string,
  target: JsonStoreTarget,
  label: string,
  change: (current: string | null) => string | null,
  conditional: boolean,
): Promise<"ok" | "retry" | "stop"> {
  const read = await readBlobJson(pathname, token);
  if (read.state === "error") {
    await recordStoreFailure(target, "read", read.error);
    return "stop";
  }
  const current = read.state === "ok" ? read.text : null;
  const next = change(current);
  if (next == null) {
    await recordStoreFailure(target, "write", new Error(`Refusing to overwrite an unreadable ${label.toLowerCase()}`));
    return "stop";
  }
  const etag = conditional
    ? await strongMatchToken(pathname, token, read.state === "ok" ? read.downloadEtag : undefined)
    : undefined;
  try {
    await blobClient.put(pathname, next, {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
      contentType: "application/json",
      token,
      ...(etag ? { ifMatch: etag } : {}),
    });
    return "ok";
  } catch (err) {
    if (conditional && isPreconditionFailed(err)) return "retry";
    await recordStoreFailure(target, "write", err);
    return "stop";
  }
}

function hasJsonArray(text: string | null, key: string): boolean {
  if (text == null || text.trim() === "") return true;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed[key]));
  } catch {
    return false;
  }
}

function isJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function emptyStoreStatus(): PersistedStoreStatus {
  return { failures: {}, alertsSentUnsavedAt: null };
}

function cloneStoreStatus(status: PersistedStoreStatus): PersistedStoreStatus {
  return {
    failures: { ...status.failures },
    alertsSentUnsavedAt: status.alertsSentUnsavedAt,
  };
}

export async function noteAlertSentUnsaved(now: Date): Promise<void> {
  const status = await loadPersistedStatus();
  status.alertsSentUnsavedAt = now.getTime();
  await persistStoreStatus(status);
}

export async function lastAlertBookWriteError(): Promise<{ status: number | null; message: string } | null> {
  const status = await loadPersistedStatus();
  const failure = status.failures["alert-book"];
  if (!failure) return null;
  return { status: failure.status, message: failure.message };
}

export async function readAlertBookNotice(): Promise<AlertBookNotice> {
  const status = await loadPersistedStatus();
  const failure = status.failures["alert-book"] ?? null;
  const records = await alertBookRecordCount();
  return {
    problem: failure ? failure.operation : null,
    empty: records === 0,
    alertsSentUnsaved: status.alertsSentUnsavedAt != null,
    failedAt: failure?.at ?? null,
    status: failure?.status ?? null,
    message: failure?.message ?? null,
  };
}

async function alertBookRecordCount(): Promise<number | null> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return null;
  if (kind === "memory") return countAlertRecords(memoryBag().alertBook);
  if (kind === "blob") {
    const token = blobToken();
    if (!token) return null;
    const read = await readBlobJson(SCHWAB_BLOB_ALERT_BOOK_PATH, token);
    if (read.state === "missing") return 0;
    if (read.state !== "ok") return null;
    return countAlertRecords(read.text);
  }
  try {
    const raw = await kvCommand(["GET", ALERT_BOOK_KEY]);
    if (typeof raw !== "string" || raw.length === 0) return 0;
    return countAlertRecords(raw);
  } catch {
    return null;
  }
}

function countAlertRecords(text: string | null): number | null {
  if (text == null || text.trim() === "") return 0;
  try {
    const parsed = JSON.parse(text) as { records?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.records)) return null;
    return parsed.records.length;
  } catch {
    return null;
  }
}

async function loadPersistedStatus(): Promise<PersistedStoreStatus> {
  if (memoryStoreStatus) return cloneStoreStatus(memoryStoreStatus);
  const loaded = await readStatusFromStore();
  memoryStoreStatus = loaded;
  return cloneStoreStatus(loaded);
}

async function readStatusFromStore(): Promise<PersistedStoreStatus> {
  const kind = resolveStoreKind();
  if (kind === "blob") {
    const token = blobToken();
    if (!token) return emptyStoreStatus();
    const read = await readBlobJson(SCHWAB_BLOB_STORE_STATUS_PATH, token);
    if (read.state !== "ok") return emptyStoreStatus();
    return parseStoreStatus(read.text);
  }
  if (kind === "kv") {
    try {
      const raw = await kvCommand(["GET", STORE_STATUS_KEY]);
      if (typeof raw !== "string" || raw.length === 0) return emptyStoreStatus();
      return parseStoreStatus(raw);
    } catch {
      return emptyStoreStatus();
    }
  }
  return emptyStoreStatus();
}

function parseStoreStatus(text: string): PersistedStoreStatus {
  try {
    const parsed = JSON.parse(text) as Partial<PersistedStoreStatus>;
    const failures: PersistedStoreStatus["failures"] = {};
    const source = parsed.failures;
    if (source && typeof source === "object") {
      for (let i = 0; i < JSON_STORE_TARGETS.length; i++) {
        const target = JSON_STORE_TARGETS[i];
        const row = source[target];
        if (!row || (row.operation !== "read" && row.operation !== "write")) continue;
        if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue;
        failures[target] = {
          target,
          operation: row.operation,
          at: row.at,
          status: typeof row.status === "number" ? row.status : null,
          message: redactSecrets(typeof row.message === "string" ? row.message : "Unknown error").slice(0, 240),
        };
      }
    }
    return {
      failures,
      alertsSentUnsavedAt: typeof parsed.alertsSentUnsavedAt === "number" ? parsed.alertsSentUnsavedAt : null,
    };
  } catch {
    return emptyStoreStatus();
  }
}

async function persistStoreStatus(status: PersistedStoreStatus): Promise<void> {
  memoryStoreStatus = cloneStoreStatus(status);
  const kind = resolveStoreKind();
  const body = JSON.stringify(memoryStoreStatus);
  if (kind === "memory" || kind === "unconfigured") return;
  if (kind === "kv") {
    try {
      await kvCommand(["SET", STORE_STATUS_KEY, body]);
    } catch (err) {
      logStoreFailure("Store status could not be written", err);
    }
    return;
  }
  const token = blobToken();
  if (!token) return;
  try {
    await blobClient.put(SCHWAB_BLOB_STORE_STATUS_PATH, body, {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
      contentType: "application/json",
      token,
    });
  } catch (err) {
    logStoreFailure("Store status could not be written", err);
  }
}

async function recordStoreFailure(target: JsonStoreTarget, operation: "read" | "write", err: unknown): Promise<void> {
  const sentence = operation === "read" ? `${storeLabel(target)} could not be read` : `${storeLabel(target)} could not be written`;
  logStoreFailure(sentence, err);
  const status = await loadPersistedStatus();
  status.failures[target] = {
    target,
    operation,
    at: Date.now(),
    status: storeErrorStatus(err),
    message: failureMessage(err),
  };
  await persistStoreStatus(status);
}

async function clearStoreFailure(target: JsonStoreTarget): Promise<void> {
  const status = await loadPersistedStatus();
  const hadFailure = Boolean(status.failures[target]);
  const hadUnsaved = target === "alert-book" && status.alertsSentUnsavedAt != null;
  if (!hadFailure && !hadUnsaved) return;
  delete status.failures[target];
  if (target === "alert-book") status.alertsSentUnsavedAt = null;
  await persistStoreStatus(status);
}

function storeLabel(target: JsonStoreTarget): string {
  if (target === "alert-book") return "Alert book";
  if (target === "trade-log") return "Trade log";
  return "Flow snapshot store";
}

function failureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : "Unknown error";
  return redactSecrets(raw).slice(0, 240);
}

function cloneFlowBook(book: FlowSnapshotBook): FlowSnapshotBook {
  return parseFlowBook(JSON.stringify(book));
}

function parseFlowBook(text: string): FlowSnapshotBook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return sanitizeFlowBook(parsed as FlowSnapshotBook);
}

function sanitizeFlowBook(patch: FlowSnapshotBook): FlowSnapshotBook {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const out: FlowSnapshotBook = {};
  const tickers = Object.keys(patch);
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i].trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) continue;
    const row = patch[tickers[i]];
    if (!row || typeof row !== "object") continue;
    const scannedAt = row.scannedAt;
    if (typeof scannedAt !== "number" || !Number.isFinite(scannedAt)) continue;
    const volumes: Record<string, number> = {};
    const source = row.volumes;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const keys = Object.keys(source);
      for (let j = 0; j < keys.length && Object.keys(volumes).length < FLOW_SNAPSHOT_MAX_CONTRACTS; j++) {
        const key = keys[j];
        if (key.length === 0 || key.length > 80) continue;
        const volume = source[key];
        if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0) continue;
        volumes[key] = volume;
      }
    }
    out[ticker] = { scannedAt, volumes, quotes: sanitizeQuotes(row.quotes) };
  }
  return trimFlowBook(out);
}

function sanitizeQuotes(value: unknown): Record<string, StoredQuotePoint[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  const out: Record<string, StoredQuotePoint[]> = {};
  for (let i = 0; i < keys.length && Object.keys(out).length < FLOW_SNAPSHOT_MAX_CONTRACTS; i++) {
    const key = keys[i];
    if (key.length === 0 || key.length > 80) continue;
    const points = sanitizePoints(source[key]);
    if (points.length > 0) out[key] = points;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizePoints(value: unknown): StoredQuotePoint[] {
  if (!Array.isArray(value)) return [];
  const list = value.slice(-PRINT_RULES.historyPoints);
  const points: StoredQuotePoint[] = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const point = row as Partial<StoredQuotePoint>;
    if (typeof point.at !== "number" || !Number.isFinite(point.at)) continue;
    if (typeof point.volume !== "number" || !Number.isFinite(point.volume) || point.volume < 0) continue;
    points.push({
      at: point.at,
      volume: point.volume,
      last: optionalNonNegative(point.last),
      lastSize: optionalPositive(point.lastSize),
      bid: optionalNonNegative(point.bid),
      ask: optionalNonNegative(point.ask),
      tradeTime: optionalPositive(point.tradeTime),
    });
  }
  return points;
}

function optionalNonNegative(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function optionalPositive(value: unknown): number | null {
  const parsed = optionalNonNegative(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed;
}

function trimFlowBook(book: FlowSnapshotBook): FlowSnapshotBook {
  const tickers = Object.keys(book);
  if (tickers.length <= FLOW_SNAPSHOT_MAX_TICKERS) return book;
  const ranked = tickers.sort((a, b) => book[b].scannedAt - book[a].scannedAt);
  const kept: FlowSnapshotBook = {};
  for (let i = 0; i < FLOW_SNAPSHOT_MAX_TICKERS; i++) kept[ranked[i]] = book[ranked[i]];
  return kept;
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
