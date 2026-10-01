/**
 * Exact env var names for the Schwab token store.
 * Vercel KV uses the KV_ pair. Upstash Redis uses the UPSTASH_ pair.
 * When both pairs are set, KV_ wins (see kvRestConfig).
 */
export const SCHWAB_KV_URL_ENV = "KV_REST_API_URL";
export const SCHWAB_KV_TOKEN_ENV = "KV_REST_API_TOKEN";
export const SCHWAB_UPSTASH_URL_ENV = "UPSTASH_REDIS_REST_URL";
export const SCHWAB_UPSTASH_TOKEN_ENV = "UPSTASH_REDIS_REST_TOKEN";

export const SCHWAB_STORAGE_UNCONFIGURED_MESSAGE =
  "Schwab token storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV), or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Upstash Redis). In-memory storage is not used in production, so the connection was not saved.";
