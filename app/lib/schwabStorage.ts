/**
 * Exact env var names for the Schwab token store.
 * Token reads and writes prefer Edge Config when GLOBAL_CONFIG or EDGE_CONFIG
 * is set together with VERCEL_API_TOKEN. Otherwise a complete KV pair, then a
 * complete Upstash pair, then BLOB_READ_WRITE_TOKEN. Alert books and the other
 * JSON documents stay on that document store. See resolveTokenBackend.
 */
export const SCHWAB_KV_URL_ENV = "KV_REST_API_URL";
export const SCHWAB_KV_TOKEN_ENV = "KV_REST_API_TOKEN";
export const SCHWAB_UPSTASH_URL_ENV = "UPSTASH_REDIS_REST_URL";
export const SCHWAB_UPSTASH_TOKEN_ENV = "UPSTASH_REDIS_REST_TOKEN";
export const SCHWAB_BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";

/** Connection string Vercel injects when a Global Config (Edge Config) store is connected. */
export const SCHWAB_EDGE_CONFIG_ENV = "EDGE_CONFIG";
/** Newer name for the same connection string. Checked before EDGE_CONFIG. */
export const SCHWAB_GLOBAL_CONFIG_ENV = "GLOBAL_CONFIG";
/** Bearer token for PATCH /v1/edge-config/{id}/items. Not the Edge Config read token. */
export const SCHWAB_VERCEL_API_TOKEN_ENV = "VERCEL_API_TOKEN";
/** Team that owns the Edge Config. Required on the write URL for a team store. */
export const SCHWAB_VERCEL_TEAM_ID_ENV = "VERCEL_TEAM_ID";
/** Edge Config item key. Letters, digits, and underscores only. */
export const SCHWAB_EDGE_TOKEN_KEY = "schwabTokens";

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
 * Private blob for shadow alert outcomes. Not a token and not the trade log.
 * Same store as the alert book. No broker fills.
 */
export const SCHWAB_BLOB_SHADOW_BOOK_PATH = "schwab/shadow-book.json";

/**
 * Private blob for the JG-VWAP paper test. Not a token, not the alert book,
 * and not the A/B shadow scorecard.
 */
export const SCHWAB_BLOB_JG_VWAP_PATH = "schwab/jg-vwap-book.json";

/**
 * Private blob for the gap-day anchored VWAP paper log.
 * Not a token, not an order, and not the A/B shadow scorecard.
 */
export const SCHWAB_BLOB_AVWAP_PAPER_PATH = "schwab/avwap-paper-book.json";

/**
 * Private blob for the flush-then-reclaim call paper log.
 * Not a token, not an order, and not the A/B shadow scorecard.
 */
export const SCHWAB_BLOB_CALLS_PAPER_PATH = "schwab/calls-paper-book.json";

/**
 * Private blob for unusual-flow flags and their later marks.
 * Not a token, not an order, and not a Telegram alert.
 */
export const SCHWAB_BLOB_UNUSUAL_PATH = "schwab/unusual-flow.json";

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

export type SchwabStoreKind = "edge" | "kv" | "blob" | "memory" | "unconfigured";

export const SCHWAB_STORAGE_UNCONFIGURED_MESSAGE =
  "Schwab token storage is not configured. Set EDGE_CONFIG (or GLOBAL_CONFIG) and VERCEL_API_TOKEN (Vercel Edge Config; team stores also need VERCEL_TEAM_ID), or KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV), or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Upstash Redis), or BLOB_READ_WRITE_TOKEN (Vercel Blob). In-memory storage is not used in production, so the connection was not saved.";
