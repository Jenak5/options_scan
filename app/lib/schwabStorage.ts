/**
 * Exact env var names for the Schwab token store.
 * Selection order is a complete KV pair, then a complete Upstash pair,
 * then BLOB_READ_WRITE_TOKEN. See resolveStoreKind.
 */
export const SCHWAB_KV_URL_ENV = "KV_REST_API_URL";
export const SCHWAB_KV_TOKEN_ENV = "KV_REST_API_TOKEN";
export const SCHWAB_UPSTASH_URL_ENV = "UPSTASH_REDIS_REST_URL";
export const SCHWAB_UPSTASH_TOKEN_ENV = "UPSTASH_REDIS_REST_TOKEN";
export const SCHWAB_BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";

/** Fixed private-blob pathname for the encrypted token envelope. */
export const SCHWAB_BLOB_TOKEN_PATH = "schwab/tokens.json";

/**
 * Separate private-blob pathname for estimated-flow volume snapshots.
 * Small JSON of prior contract volume. Not a token and not encrypted.
 */
export const SCHWAB_BLOB_FLOW_PATH = "schwab/flow-snapshots.json";

/**
 * Private blob for sent alerts, checkpoint quotes, and the loss count
 * last typed into the Gate. Not a token and not encrypted.
 * The daily stop no longer reads that typed count. It reads the trade log.
 */
export const SCHWAB_BLOB_ALERT_BOOK_PATH = "schwab/alert-book.json";

/**
 * Private blob for the manual trade log. Not a token and not encrypted.
 * Same store as the alert book. No broker fills.
 */
export const SCHWAB_BLOB_TRADE_LOG_PATH = "schwab/trade-log.json";

/**
 * Small private blob for the last alert-book, flow, or trade-log failure.
 * Written without ifMatch so a status line can be saved even when a
 * conditional overwrite of the alert book is rejected.
 */
export const SCHWAB_BLOB_STORE_STATUS_PATH = "schwab/store-status.json";

/**
 * Shortest cache lifetime the Blob SDK accepts (60 seconds).
 * Token reads still bypass the CDN with useCache: false.
 */
export const SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE = 60;

export type SchwabStoreKind = "kv" | "blob" | "memory" | "unconfigured";

export const SCHWAB_STORAGE_UNCONFIGURED_MESSAGE =
  "Schwab token storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV), or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Upstash Redis), or BLOB_READ_WRITE_TOKEN (Vercel Blob). In-memory storage is not used in production, so the connection was not saved.";
