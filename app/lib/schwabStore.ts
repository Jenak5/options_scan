import { PRINT_RULES } from "@/app/lib/alertConfig";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { emptyScanHealth, parseScanHealth, type ScanHealth } from "@/app/lib/scanHealth";
import {
  SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
  SCHWAB_BLOB_ALERT_BOOK_PATH,
  SCHWAB_BLOB_FLOW_PATH,
  SCHWAB_BLOB_STORE_STATUS_PATH,
  SCHWAB_BLOB_SHADOW_BOOK_PATH,
  SCHWAB_BLOB_TRADE_LOG_PATH,
  SCHWAB_BLOB_TOKEN_ENV,
  SCHWAB_BLOB_TOKEN_PATH,
  SCHWAB_EDGE_CONFIG_ENV,
  SCHWAB_EDGE_TOKEN_KEY,
  SCHWAB_GLOBAL_CONFIG_ENV,
  SCHWAB_KV_TOKEN_ENV,
  SCHWAB_KV_URL_ENV,
  SCHWAB_UPSTASH_TOKEN_ENV,
  SCHWAB_UPSTASH_URL_ENV,
  SCHWAB_VERCEL_API_TOKEN_ENV,
  SCHWAB_VERCEL_TEAM_ID_ENV,
  type SchwabStoreKind,
} from "@/app/lib/schwabStorage";
import type { AlertBookNotice } from "@/app/lib/storeStatus";

/**
 * Server-side Schwab token store.
 *
 * The Schwab token prefers Vercel Edge Config (GLOBAL_CONFIG or EDGE_CONFIG
 * for reads, VERCEL_API_TOKEN for writes). Otherwise a complete Vercel KV
 * pair, a complete Upstash Redis pair, then a private Vercel Blob store.
 * The token JSON is encrypted with a key derived from SESSION_SECRET before
 * it is written. Values are never logged. A warm instance keeps the token
 * in memory until the access token is near expiry. Blob remains a read
 * fallback for a token that has not been copied yet. A Blob 429 does not
 * throw and does not discard a token this instance already holds.
 *
 * Alert books, the trade log, shadows, and flow snapshots stay on the
 * document store (KV, then Blob). Those reads are cached for the current
 * request. Scan health is not: the cron confirms its own slot write, and a
 * later read in the same request must see another instance's overwrite.
 * A put is skipped when the JSON did not change.
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
const SHADOW_BOOK_KEY = "oes:alert:shadows";
const BLOB_WRITE_ATTEMPTS = 4;
const JSON_CONDITIONAL_ATTEMPTS = 3;
/** Re-read the token store only inside this window before access-token expiry. */
const TOKEN_CACHE_SKEW_MS = 90_000;
/** After a Blob 429, skip further token Blob reads on this instance for a short time. */
const TOKEN_BLOB_BACKOFF_MS = 20_000;
const STORE_STATUS_KEY = "oes:store:status";
/** Holds the full flow watchlist so a rotated scan still has the prior volume. */
const FLOW_SNAPSHOT_MAX_TICKERS = 48;
const FLOW_SNAPSHOT_MAX_CONTRACTS = 500;

export interface FlowSessionMemory {
  scannedAt: number;
  volumes: Record<string, number>;
  ivs?: Record<string, number>;
}

export interface FlowVolumeSnapshot {
  scannedAt: number;
  volumes: Record<string, number>;
  /** Recent chain quotes per contract. Absent on snapshots saved before print detection. */
  quotes?: Record<string, StoredQuotePoint[]>;
  /** Implied vol by contract key. Absent on older snapshots. */
  ivs?: Record<string, number>;
  /** Previous session, kept so a new day does not erase the repeat-flow comparison. */
  priorSession?: FlowSessionMemory;
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
  shadowBook: string | null;
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
  | { state: "rate-limited" }
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

interface TokenCache {
  tokens: StoredTokens | null;
  alerts: AlertMeta;
}

let tokenCache: TokenCache | null = null;
let tokenBlobBlockedUntil = 0;
let blobMigrationAttempted = false;
let rateLimitLogged = false;

interface BlobTextCacheEntry {
  text: string | null;
}

const blobReadCache = new AsyncLocalStorage<Map<string, BlobTextCacheEntry>>();

/**
 * Share Blob document reads for one request. A warm instance must not reuse
 * the map on the next request, so callers enter it at the start of the handler.
 */
export function withBlobReadCache<T>(run: () => Promise<T>): Promise<T> {
  if (blobReadCache.getStore()) return run();
  return blobReadCache.run(new Map(), run);
}

/** Tests inject a fake put/get/del client. Pass null to restore the SDK. */
export function setSchwabBlobClientForTests(next: SchwabBlobClient | null): void {
  blobClient = next ?? defaultBlobClient();
}

function memoryBag(): MemoryBag {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  if (!g.__oesSchwabMemory) {
    g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS }, flowSnapshots: {}, alertBook: null, tradeLog: null, shadowBook: null };
  } else if (!g.__oesSchwabMemory.flowSnapshots) {
    g.__oesSchwabMemory.flowSnapshots = {};
  }
  if (g.__oesSchwabMemory.alertBook === undefined) g.__oesSchwabMemory.alertBook = null;
  if (g.__oesSchwabMemory.tradeLog === undefined) g.__oesSchwabMemory.tradeLog = null;
  if (g.__oesSchwabMemory.shadowBook === undefined) g.__oesSchwabMemory.shadowBook = null;
  return g.__oesSchwabMemory;
}

export function clearMemoryStoreForTests(): void {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS }, flowSnapshots: {}, alertBook: null, tradeLog: null, shadowBook: null };
  memoryStoreStatus = null;
  tokenCache = null;
  tokenBlobBlockedUntil = 0;
  blobMigrationAttempted = false;
  rateLimitLogged = false;
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

interface EdgeReadConfig {
  origin: string;
  id: string;
  readToken: string;
}

function edgeReadConfig(): EdgeReadConfig | null {
  const raw = process.env[SCHWAB_GLOBAL_CONFIG_ENV]?.trim()
    || process.env[SCHWAB_EDGE_CONFIG_ENV]?.trim()
    || "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const readToken = url.searchParams.get("token")?.trim() ?? "";
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!readToken || !id.startsWith("ecfg_")) return null;
    return { origin: url.origin, id, readToken };
  } catch {
    return null;
  }
}

function edgeApiToken(): string {
  return process.env[SCHWAB_VERCEL_API_TOKEN_ENV]?.trim()
    || process.env.VERCEL_ACCESS_TOKEN?.trim()
    || "";
}

function edgeWriteReady(): boolean {
  return edgeReadConfig() !== null && edgeApiToken().length > 0;
}

/**
 * Where the Schwab token is read and written.
 * Edge Config wins when both the connection string and the write token exist.
 * Documents (alerts, shadows, flow, trades, scan health) still use resolveStoreKind.
 */
export function resolveTokenBackend(): StoreKind {
  if (edgeWriteReady()) return "edge";
  return resolveStoreKind();
}

export async function readTokens(options?: { bypassCache?: boolean }): Promise<StoredTokens | null> {
  const backend = resolveTokenBackend();
  if (backend === "unconfigured") return null;
  if (backend === "memory") return memoryBag().tokens;
  if (!options?.bypassCache && tokenCacheFresh()) return tokenCache?.tokens ?? null;
  if (backend === "blob" && Date.now() < tokenBlobBlockedUntil) return tokenCache?.tokens ?? null;
  try {
    return await readTokensFromStore();
  } catch (err) {
    if (isRateLimit(err)) return tokenCache?.tokens ?? null;
    logStoreFailure("Schwab token store could not be read", err);
    return tokenCache?.tokens ?? null;
  }
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new Error("Refusing to store an empty Schwab token");
  }
  const backend = resolveTokenBackend();
  if (backend === "unconfigured") {
    throw new Error("Schwab token storage is not configured");
  }
  if (backend === "memory") {
    memoryBag().tokens = tokens;
    rememberTokenCache(tokens, memoryBag().alerts);
    return;
  }
  const cipher = await encryptTokenPayload(JSON.stringify(tokens));
  if (backend === "edge") {
    const alerts = await alertsForEdgeWrite();
    await writeEdgeEnvelope({ cipher, alerts });
    rememberTokenCache(tokens, alerts);
    return;
  }
  if (backend === "blob") {
    const alerts = await updateBlobEnvelope((envelope) => ({ ...envelope, cipher }));
    rememberTokenCache(tokens, alerts);
    return;
  }
  await kvCommand(["SET", TOKEN_KEY, cipher]);
  rememberTokenCache(tokens, tokenCache?.alerts ?? { ...EMPTY_ALERTS });
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
  const backend = resolveTokenBackend();
  if (backend === "unconfigured") {
    throw new Error("Schwab token storage is not configured");
  }
  if (backend !== "blob") {
    let latest: StoredTokens | null = null;
    try {
      latest = await readTokensFromStore();
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      rememberTokenCache(next, tokenCache?.alerts ?? { ...EMPTY_ALERTS });
      return next;
    }
    if (latest && keepStoredTokens(latest, basis, next)) return latest;
    try {
      await writeTokens(next);
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      rememberTokenCache(next, tokenCache?.alerts ?? { ...EMPTY_ALERTS });
      return next;
    }
    return next;
  }
  const token = requireBlobToken();
  for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt++) {
    const read = await readBlobRecord(token, true);
    if (read.state === "rate-limited") {
      rememberTokenCache(next, tokenCache?.alerts ?? { ...EMPTY_ALERTS });
      return next;
    }
    if (read.state === "error") throw new Error("Schwab token store could not be read");
    if (read.state === "corrupt") {
      if (!read.etag) throw new Error("Schwab token store etag could not be confirmed");
      const removed = await deleteBlobIfMatch(token, read.etag);
      if (!removed) continue;
      const again = await readBlobRecord(token);
      if (again.state !== "missing") continue;
      await putEnvelope(token, { cipher: await encryptTokenPayload(JSON.stringify(next)), alerts: { ...EMPTY_ALERTS } });
      rememberTokenCache(next, { ...EMPTY_ALERTS });
      return next;
    }
    const latest = read.state === "ok" ? await tokensFromCipher(read.envelope.cipher) : null;
    if (read.state === "ok" && latest && keepStoredTokens(latest, basis, next)) {
      rememberTokenCache(latest, read.envelope.alerts);
      return latest;
    }
    const envelope = read.state === "ok" ? read.envelope : { cipher: null, alerts: { ...EMPTY_ALERTS } };
    const etag = read.state === "ok" ? read.etag : undefined;
    if (read.state === "ok" && !etag) throw new Error("Schwab token store etag could not be confirmed");
    try {
      await putEnvelope(token, {
        cipher: await encryptTokenPayload(JSON.stringify(next)),
        alerts: envelope.alerts,
      }, etag);
      rememberTokenCache(next, envelope.alerts);
      return next;
    } catch (err) {
      if (isRateLimit(err)) {
        rememberTokenCache(next, envelope.alerts);
        return next;
      }
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
  const backend = resolveTokenBackend();
  if (backend === "unconfigured") return { ...EMPTY_ALERTS };
  if (backend === "memory") return memoryBag().alerts;
  if ((backend === "edge" || backend === "blob") && tokenCacheFresh() && tokenCache) {
    return { ...tokenCache.alerts };
  }
  if (backend === "edge" || backend === "blob") {
    try {
      const loaded = await loadTokenEnvelope(backend);
      if (loaded.kind === "rate-limited") return { ...(tokenCache?.alerts ?? EMPTY_ALERTS) };
      if (loaded.kind === "ok" && loaded.alerts) {
        rememberTokenCache(loaded.tokens, loaded.alerts);
        return { ...loaded.alerts };
      }
    } catch (err) {
      if (isRateLimit(err)) return { ...(tokenCache?.alerts ?? EMPTY_ALERTS) };
    }
    return { ...(tokenCache?.alerts ?? EMPTY_ALERTS) };
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

/**
 * Shadow alert outcomes. Same store order as the trade log. Not a token.
 * A failed read does not overwrite the book. This is not the trade log.
 */
export async function readShadowBookText(): Promise<string | null> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return null;
  if (kind === "memory") return memoryBag().shadowBook;
  if (kind === "blob") {
    const token = blobToken();
    if (!token) return null;
    const read = await readBlobJson(SCHWAB_BLOB_SHADOW_BOOK_PATH, token);
    if (read.state === "error") {
      await recordStoreFailure("shadow-book", "read", read.error);
      return null;
    }
    if (read.state !== "ok") return null;
    return read.text;
  }
  try {
    const raw = await kvCommand(["GET", SHADOW_BOOK_KEY]);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch (err) {
    await recordStoreFailure("shadow-book", "read", err);
    return null;
  }
}

export async function updateShadowBook(change: (current: string | null) => string): Promise<boolean> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") {
    await recordStoreFailure("shadow-book", "write", new Error("Alert scorecard storage is not configured"));
    return false;
  }
  const guarded = (current: string | null): string | null => {
    if (!hasJsonArray(current, "records")) return null;
    return change(current);
  };
  if (kind === "memory") {
    const bag = memoryBag();
    const next = guarded(bag.shadowBook);
    if (next == null) {
      await recordStoreFailure("shadow-book", "write", new Error("Refusing to overwrite an unreadable alert scorecard"));
      return false;
    }
    bag.shadowBook = next;
    await clearStoreFailure("shadow-book");
    return true;
  }
  if (kind === "blob") return writeBlobJson(SCHWAB_BLOB_SHADOW_BOOK_PATH, "shadow-book", "Alert scorecard", guarded);
  let current: string | null;
  try {
    const raw = await kvCommand(["GET", SHADOW_BOOK_KEY]);
    current = typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch (err) {
    await recordStoreFailure("shadow-book", "read", err);
    return false;
  }
  const next = guarded(current);
  if (next == null) {
    await recordStoreFailure("shadow-book", "write", new Error("Refusing to overwrite an unreadable alert scorecard"));
    return false;
  }
  try {
    await kvCommand(["SET", SHADOW_BOOK_KEY, next]);
    await clearStoreFailure("shadow-book");
    return true;
  } catch (err) {
    await recordStoreFailure("shadow-book", "write", err);
    return false;
  }
}

async function updateBlobAlertBook(change: (current: string | null) => string | null): Promise<boolean> {
  return writeBlobJson(SCHWAB_BLOB_ALERT_BOOK_PATH, "alert-book", "Alert book", change);
}

export async function writeAlertMeta(meta: AlertMeta): Promise<void> {
  const backend = resolveTokenBackend();
  if (backend === "unconfigured") return;
  if (backend === "memory") {
    memoryBag().alerts = meta;
    rememberTokenCache(memoryBag().tokens, meta);
    return;
  }
  if (backend === "blob") {
    const alerts = await updateBlobEnvelope((envelope) => ({ ...envelope, alerts: meta }));
    rememberTokenCache(tokenCache?.tokens ?? null, alerts);
    return;
  }
  if (backend === "edge") {
    const current = await readEdgeEnvelope();
    if (current.kind !== "ok") {
      if (tokenCache) tokenCache = { ...tokenCache, alerts: meta };
      return;
    }
    await writeEdgeEnvelope({ ...current.envelope, alerts: meta });
    rememberTokenCache(tokenCache?.tokens ?? null, meta);
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

function tokenCacheFresh(now = Date.now()): boolean {
  if (!tokenCache?.tokens) return false;
  return tokenCache.tokens.accessExpiresAt - TOKEN_CACHE_SKEW_MS > now;
}

function rememberTokenCache(tokens: StoredTokens | null, alerts: AlertMeta): void {
  tokenCache = { tokens, alerts: { ...alerts } };
}

function isRateLimit(err: unknown): boolean {
  if (storeErrorStatus(err) === 429) return true;
  const message = err instanceof Error ? err.message : "";
  return /\b429\b/.test(message) || /too many requests/i.test(message);
}

function noteBlobRateLimit(sentence: string): void {
  tokenBlobBlockedUntil = Date.now() + TOKEN_BLOB_BACKOFF_MS;
  if (rateLimitLogged) return;
  rateLimitLogged = true;
  console.error(`${sentence}: Vercel Blob returned 429 Too Many Requests`);
}

type EnvelopeLoad =
  | { kind: "ok"; tokens: StoredTokens | null; alerts: AlertMeta | null }
  | { kind: "missing" }
  | { kind: "rate-limited" }
  | { kind: "error" };

async function readTokensFromStore(): Promise<StoredTokens | null> {
  const backend = resolveTokenBackend();
  if (backend === "memory") return memoryBag().tokens;
  if (backend === "unconfigured") return null;
  const loaded = await loadTokenEnvelope(backend);
  if (loaded.kind === "rate-limited") {
    noteBlobRateLimit("Schwab token store could not be read");
    throw new Error("Vercel Blob: Failed to fetch blob: 429 Too Many Requests");
  }
  if (loaded.kind === "ok") {
    rememberTokenCache(loaded.tokens, loaded.alerts ?? tokenCache?.alerts ?? { ...EMPTY_ALERTS });
    return loaded.tokens;
  }
  if (loaded.kind === "missing") tokenCache = null;
  return null;
}

async function loadTokenEnvelope(backend: StoreKind): Promise<EnvelopeLoad> {
  if (backend === "edge") {
    const edge = await readEdgeEnvelope();
    if (edge.kind === "rate-limited") return { kind: "rate-limited" };
    if (edge.kind === "ok" && edge.envelope.cipher) {
      return {
        kind: "ok",
        tokens: await tokensFromCipher(edge.envelope.cipher),
        alerts: edge.envelope.alerts,
      };
    }
    if (!blobConfigured()) {
      if (edge.kind === "ok") return { kind: "ok", tokens: null, alerts: edge.envelope.alerts };
      return edge.kind === "error" ? { kind: "error" } : { kind: "missing" };
    }
    const blob = await readBlobEnvelope();
    if (blob.kind === "rate-limited") return { kind: "rate-limited" };
    if (blob.kind === "ok" && blob.envelope.cipher) {
      await migrateBlobEnvelopeToEdge(blob.envelope);
      return {
        kind: "ok",
        tokens: await tokensFromCipher(blob.envelope.cipher),
        alerts: blob.envelope.alerts,
      };
    }
    if (edge.kind === "ok") return { kind: "ok", tokens: null, alerts: edge.envelope.alerts };
    return blob.kind === "error" || edge.kind === "error" ? { kind: "error" } : { kind: "missing" };
  }
  if (backend === "kv") {
    try {
      const raw = await kvCommand(["GET", TOKEN_KEY]);
      if (typeof raw !== "string" || raw.length === 0) return { kind: "missing" };
      return { kind: "ok", tokens: parseStored(await decryptTokenPayload(raw)), alerts: null };
    } catch (err) {
      if (isRateLimit(err)) return { kind: "rate-limited" };
      logStoreFailure("Schwab token store could not be read", err);
      return { kind: "error" };
    }
  }
  if (backend === "blob") {
    const blob = await readBlobEnvelope();
    if (blob.kind === "rate-limited") return { kind: "rate-limited" };
    if (blob.kind === "ok") {
      return {
        kind: "ok",
        tokens: await tokensFromCipher(blob.envelope.cipher),
        alerts: blob.envelope.alerts,
      };
    }
    return blob.kind === "error" ? { kind: "error" } : { kind: "missing" };
  }
  return { kind: "missing" };
}

async function readBlobEnvelope(): Promise<
  | { kind: "ok"; envelope: TokenEnvelope }
  | { kind: "missing" }
  | { kind: "rate-limited" }
  | { kind: "error" }
> {
  const token = blobToken();
  if (!token) return { kind: "missing" };
  const read = await readBlobRecord(token, false);
  if (read.state === "rate-limited") return { kind: "rate-limited" };
  if (read.state === "ok") return { kind: "ok", envelope: read.envelope };
  if (read.state === "missing") return { kind: "missing" };
  return { kind: "error" };
}

async function alertsForEdgeWrite(): Promise<AlertMeta> {
  const edge = await readEdgeEnvelope();
  if (edge.kind === "ok") return edge.envelope.alerts;
  if (tokenCache?.alerts) return tokenCache.alerts;
  if (!blobConfigured()) return { ...EMPTY_ALERTS };
  const blob = await readBlobEnvelope();
  if (blob.kind === "ok") return blob.envelope.alerts;
  return { ...EMPTY_ALERTS };
}

async function readEdgeEnvelope(): Promise<
  | { kind: "ok"; envelope: TokenEnvelope }
  | { kind: "missing" }
  | { kind: "rate-limited" }
  | { kind: "error" }
> {
  const cfg = edgeReadConfig();
  if (!cfg) return { kind: "missing" };
  const url = `${cfg.origin}/${cfg.id}/item/${encodeURIComponent(SCHWAB_EDGE_TOKEN_KEY)}?token=${encodeURIComponent(cfg.readToken)}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    logStoreFailure("Schwab token store could not be read", err);
    return { kind: "error" };
  }
  if (res.status === 404) return { kind: "missing" };
  if (res.status === 429) return { kind: "rate-limited" };
  if (!res.ok) {
    logStoreFailure("Schwab token store could not be read", new Error(`Edge Config read failed (${res.status})`));
    return { kind: "error" };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { kind: "error" };
  }
  const envelope = parseEnvelope(typeof payload === "string" ? payload : JSON.stringify(payload));
  if (!envelope) return { kind: "error" };
  return { kind: "ok", envelope };
}

async function writeEdgeEnvelope(envelope: TokenEnvelope): Promise<void> {
  const cfg = edgeReadConfig();
  const apiToken = edgeApiToken();
  if (!cfg || !apiToken) throw new Error("Schwab token storage is not configured");
  const url = new URL(`https://api.vercel.com/v1/edge-config/${cfg.id}/items`);
  const teamId = process.env[SCHWAB_VERCEL_TEAM_ID_ENV]?.trim() ?? "";
  if (teamId) url.searchParams.set("teamId", teamId);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [{ operation: "upsert", key: SCHWAB_EDGE_TOKEN_KEY, value: envelope }],
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Schwab token store could not be written (${res.status})`);
}

async function migrateBlobEnvelopeToEdge(envelope: TokenEnvelope): Promise<void> {
  if (blobMigrationAttempted || !envelope.cipher || !edgeWriteReady()) return;
  blobMigrationAttempted = true;
  try {
    await writeEdgeEnvelope(envelope);
  } catch (err) {
    logStoreFailure("Schwab token could not be copied off Blob", err);
  }
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

async function updateBlobEnvelope(change: (envelope: TokenEnvelope) => TokenEnvelope): Promise<AlertMeta> {
  const token = requireBlobToken();
  for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt++) {
    const read = await readBlobRecord(token, true);
    if (read.state === "error" || read.state === "rate-limited") {
      throw new Error("Schwab token store could not be read");
    }
    if (read.state === "corrupt") {
      if (!read.etag) throw new Error("Schwab token store etag could not be confirmed");
      const removed = await deleteBlobIfMatch(token, read.etag);
      if (!removed) continue;
      const again = await readBlobRecord(token, false);
      if (again.state !== "missing") continue;
      const created = change({ cipher: null, alerts: { ...EMPTY_ALERTS } });
      await putEnvelope(token, created);
      return created.alerts;
    }
    const envelope = read.state === "ok" ? read.envelope : { cipher: null, alerts: { ...EMPTY_ALERTS } };
    const etag = read.state === "ok" ? read.etag : undefined;
    if (read.state === "ok" && !etag) throw new Error("Schwab token store etag could not be confirmed");
    try {
      const next = change(envelope);
      await putEnvelope(token, next, etag);
      return next.alerts;
    } catch (err) {
      if (!isPreconditionFailed(err) || attempt === BLOB_WRITE_ATTEMPTS - 1) throw err;
    }
  }
  throw new Error("Schwab token store could not be updated");
}

async function readBlobRecord(token: string, needEtag = false): Promise<BlobRead> {
  if (Date.now() < tokenBlobBlockedUntil) return { state: "rate-limited" };
  let result: SchwabBlobGetResult | null;
  try {
    result = await blobClient.get(SCHWAB_BLOB_TOKEN_PATH, {
      access: "private",
      useCache: false,
      token,
    });
  } catch (err) {
    if (isRateLimit(err)) {
      noteBlobRateLimit("Schwab token store could not be read");
      return { state: "rate-limited" };
    }
    logStoreFailure("Schwab token store could not be read", err);
    return { state: "error" };
  }
  if (!result) return { state: "missing" };
  if (result.statusCode !== 200 || !result.stream) {
    const failure = new Error(`Blob read failed (status ${result.statusCode})`);
    if (result.statusCode === 429) {
      noteBlobRateLimit("Schwab token store could not be read");
      return { state: "rate-limited" };
    }
    logStoreFailure("Schwab token store could not be read", failure);
    return { state: "error" };
  }
  let text: string;
  try {
    text = await new Response(result.stream).text();
  } catch (err) {
    if (isRateLimit(err)) {
      noteBlobRateLimit("Schwab token store could not be read");
      return { state: "rate-limited" };
    }
    logStoreFailure("Schwab token store could not be read", err);
    return { state: "error" };
  }
  let etag = "";
  if (needEtag) {
    etag = (await strongMatchToken(SCHWAB_BLOB_TOKEN_PATH, token, result.blob.etag)) ?? "";
    if (!etag && Date.now() < tokenBlobBlockedUntil) return { state: "rate-limited" };
  }
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
      if (isRateLimit(err)) {
        noteBlobRateLimit("Blob metadata could not be read");
        return undefined;
      }
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

/** Scan health must be re-read so a slot claim can see its write and a racing overwrite. */
function requestCachedPath(pathname: string): boolean {
  return pathname !== SCHWAB_BLOB_STORE_STATUS_PATH;
}

function cachedBlobText(pathname: string): { hit: true; text: string | null } | { hit: false } {
  if (!requestCachedPath(pathname)) return { hit: false };
  const store = blobReadCache.getStore();
  if (!store || !store.has(pathname)) return { hit: false };
  return { hit: true, text: store.get(pathname)?.text ?? null };
}

function storeCachedBlob(pathname: string, text: string | null): void {
  if (!requestCachedPath(pathname)) return;
  const store = blobReadCache.getStore();
  if (store) store.set(pathname, { text });
}

async function readBlobJson(pathname: string, token: string, bypassCache = false): Promise<
  | { state: "missing" }
  | { state: "error"; error: unknown }
  | { state: "ok"; downloadEtag: string; text: string }
> {
  if (!bypassCache) {
    const cached = cachedBlobText(pathname);
    if (cached.hit) {
      if (cached.text == null) return { state: "missing" };
      return { state: "ok", downloadEtag: "", text: cached.text };
    }
  }
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
  if (!result || result.statusCode === 404) {
    storeCachedBlob(pathname, null);
    return { state: "missing" };
  }
  if (result.statusCode !== 200 || !result.stream) {
    return { state: "error", error: new Error(`Blob read failed (status ${result.statusCode})`) };
  }
  try {
    const text = await new Response(result.stream).text();
    storeCachedBlob(pathname, text);
    return { state: "ok", downloadEtag: result.blob.etag, text };
  } catch (err) {
    return { state: "error", error: err };
  }
}

type JsonStoreTarget = "alert-book" | "flow-snapshots" | "trade-log" | "shadow-book";

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
  scan: ScanHealth;
}

const JSON_STORE_TARGETS: JsonStoreTarget[] = ["alert-book", "flow-snapshots", "trade-log", "shadow-book"];

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
  const read = await readBlobJson(pathname, token, true);
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
  if (next === current) return "ok";
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
    storeCachedBlob(pathname, next);
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
  return { failures: {}, alertsSentUnsavedAt: null, scan: emptyScanHealth() };
}

function cloneStoreStatus(status: PersistedStoreStatus): PersistedStoreStatus {
  return {
    failures: { ...status.failures },
    alertsSentUnsavedAt: status.alertsSentUnsavedAt,
    scan: { ...status.scan },
  };
}

export async function readScanHealth(): Promise<ScanHealth> {
  // Cron and /api/health run in different instances. The process copy is only
  // for a failure the shared store refused to save. Health must read the store.
  if (resolveStoreKind() === "memory") {
    const status = await loadPersistedStatus();
    return { ...status.scan };
  }
  const status = await readStatusFromStore();
  return { ...status.scan };
}

export async function writeScanHealth(scan: ScanHealth): Promise<boolean> {
  const status = await loadStatusForWrite();
  status.scan = parseScanHealth(scan);
  return persistStoreStatus(status);
}

export async function noteAlertSentUnsaved(now: Date): Promise<void> {
  const status = await loadStatusForWrite();
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
  memoryStoreStatus = cloneStoreStatus(loaded);
  return cloneStoreStatus(loaded);
}

function statusHasSharedData(status: PersistedStoreStatus): boolean {
  if (status.alertsSentUnsavedAt != null) return true;
  if (Object.keys(status.failures).length > 0) return true;
  const scan = status.scan;
  return scan.lastSuccessAt != null
    || scan.lastRunAt != null
    || scan.runStartedAt != null
    || scan.lastShadowAt != null
    || scan.lastBrowserScanAt != null
    || scan.lastOutcome != null
    || scan.lastReason != null
    || scan.skipNotifiedAt != null
    || scan.tastytradeOk != null
    || scan.tastytradeStatus != null
    || scan.tastytradeCheckedAt != null
    || scan.tastytradeMessage != null;
}

/**
 * Start a shared write from the blob or KV record so a warm instance does not
 * put its older process copy over a scan another instance just finished.
 * When that read is empty, keep a failure this process recorded after the
 * store rejected the write.
 */
async function loadStatusForWrite(): Promise<PersistedStoreStatus> {
  const kind = resolveStoreKind();
  if (kind === "blob" || kind === "kv") {
    const shared = await readStatusFromStore();
    if (statusHasSharedData(shared)) return cloneStoreStatus(shared);
    if (memoryStoreStatus) return cloneStoreStatus(memoryStoreStatus);
    return cloneStoreStatus(shared);
  }
  return loadPersistedStatus();
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
      scan: parseScanHealth(parsed.scan),
    };
  } catch {
    return emptyStoreStatus();
  }
}

async function persistStoreStatus(status: PersistedStoreStatus): Promise<boolean> {
  memoryStoreStatus = cloneStoreStatus(status);
  const kind = resolveStoreKind();
  if (kind === "memory") return true;
  if (kind === "unconfigured") {
    warnScanHealthWrite("Scan health storage is not configured");
    return false;
  }
  const body = JSON.stringify(memoryStoreStatus);
  if (kind === "kv") {
    try {
      await kvCommand(["SET", STORE_STATUS_KEY, body]);
      return true;
    } catch (err) {
      warnScanHealthWrite(err);
      return false;
    }
  }
  const token = blobToken();
  if (!token) {
    warnScanHealthWrite("Blob storage is not configured");
    return false;
  }
  try {
    await blobClient.put(SCHWAB_BLOB_STORE_STATUS_PATH, body, {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
      contentType: "application/json",
      token,
    });
    return true;
  } catch (err) {
    warnScanHealthWrite(err);
    return false;
  }
}

function warnScanHealthWrite(err: unknown): void {
  const message = typeof err === "string"
    ? err
    : redactSecrets(err instanceof Error ? err.message : "Unknown error");
  const status = typeof err === "string" ? null : storeErrorStatus(err);
  console.warn(status == null
    ? `Scan health could not be written: ${message}`
    : `Scan health could not be written: ${message} (status ${status})`);
}

async function recordStoreFailure(target: JsonStoreTarget, operation: "read" | "write", err: unknown): Promise<void> {
  const sentence = operation === "read" ? `${storeLabel(target)} could not be read` : `${storeLabel(target)} could not be written`;
  if (isRateLimit(err)) {
    noteBlobRateLimit(sentence);
    return;
  }
  logStoreFailure(sentence, err);
  const status = await loadStatusForWrite();
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
  const status = await loadStatusForWrite();
  const remembered = memoryStoreStatus;
  const hadFailure = Boolean(status.failures[target] || remembered?.failures[target]);
  const hadUnsaved = target === "alert-book" && (status.alertsSentUnsavedAt != null || remembered?.alertsSentUnsavedAt != null);
  if (!hadFailure && !hadUnsaved) return;
  delete status.failures[target];
  if (target === "alert-book") status.alertsSentUnsavedAt = null;
  await persistStoreStatus(status);
}

function storeLabel(target: JsonStoreTarget): string {
  if (target === "alert-book") return "Alert book";
  if (target === "trade-log") return "Trade log";
  if (target === "shadow-book") return "Alert scorecard";
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
    const ivs = sanitizeIvs(row.ivs);
    const priorSession = sanitizePriorSession(row.priorSession);
    out[ticker] = {
      scannedAt,
      volumes,
      quotes: sanitizeQuotes(row.quotes),
      ...(ivs ? { ivs } : {}),
      ...(priorSession ? { priorSession } : {}),
    };
  }
  return trimFlowBook(out);
}

function sanitizeIvs(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  const out: Record<string, number> = {};
  for (let i = 0; i < keys.length && Object.keys(out).length < FLOW_SNAPSHOT_MAX_CONTRACTS; i++) {
    const key = keys[i];
    if (key.length === 0 || key.length > 80) continue;
    const iv = source[key];
    if (typeof iv !== "number" || !Number.isFinite(iv) || iv <= 0 || iv >= 5) continue;
    out[key] = iv;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizePriorSession(value: unknown): FlowSessionMemory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<FlowSessionMemory>;
  if (typeof row.scannedAt !== "number" || !Number.isFinite(row.scannedAt)) return undefined;
  const volumes: Record<string, number> = {};
  const source = row.volumes;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const keys = Object.keys(source);
    for (let i = 0; i < keys.length && Object.keys(volumes).length < FLOW_SNAPSHOT_MAX_CONTRACTS; i++) {
      const key = keys[i];
      if (key.length === 0 || key.length > 80) continue;
      const volume = source[key];
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0) continue;
      volumes[key] = volume;
    }
  }
  const ivs = sanitizeIvs(row.ivs);
  return { scannedAt: row.scannedAt, volumes, ...(ivs ? { ivs } : {}) };
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
