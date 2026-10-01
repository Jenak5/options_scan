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
 * Shortest cache lifetime the Blob SDK accepts (60 seconds).
 * Token reads still bypass the CDN with useCache: false.
 */
export const SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE = 60;

export type SchwabStoreKind = "kv" | "blob" | "memory" | "unconfigured";

export const SCHWAB_STORAGE_UNCONFIGURED_MESSAGE =
  "Schwab token storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV), or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Upstash Redis), or BLOB_READ_WRITE_TOKEN (Vercel Blob). In-memory storage is not used in production, so the connection was not saved.";
