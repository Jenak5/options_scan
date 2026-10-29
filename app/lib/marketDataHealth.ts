import type { DataSource } from "@/app/lib/dataSourcePref";

/**
 * Provider status for /api/health and /api/brief.
 * Counts and errors only. No tokens, account numbers, or response bodies.
 */

export type MarketDataKind = "chain" | "quotes" | "history" | "candles";
export type DerivedMarketKind = "openInterest" | "volume" | "greeks";
export type TradeSideAvailability = "yes" | "no";

export interface ServedRecord {
  source: DataSource;
  at: string;
  fallback: boolean;
  reason: string | null;
}

export interface MarketDataHealth {
  /** MARKET_DATA_PRIMARY, else legacy DATA_SOURCE, else tastytrade. */
  primary: DataSource;
  /** Source tried first. Schwab when Tastytrade was requested but is not configured. */
  preferred: DataSource;
  tastytradeConfigured: boolean;
  tastytradeOrigin: "live";
  fallback: "schwab";
  /** Last provider that served each kind. Null before the first call on this record. */
  active: Record<MarketDataKind | DerivedMarketKind, DataSource | null>;
  lastServed: Record<MarketDataKind, ServedRecord | null>;
  counts: Record<DataSource, number>;
  /** Times this record fell back from the primary source. */
  fallbackCount: number;
  /** Same number as fallbackCount. Kept for readers of the older field. */
  fallbacks: number;
  /** Most recent fallback or feed error. Secrets stripped. */
  lastError: string | null;
  lastTastytradeSuccessAt: string | null;
  /**
   * yes when the last DXLink session subscribed to TimeAndSale without the feed rejecting it.
   * A quiet window can still be yes. no means the feed was not reached or it rejected TimeAndSale.
   */
  tradeSideDataAvailable: TradeSideAvailability;
}

const KINDS: MarketDataKind[] = ["chain", "quotes", "history", "candles"];
const DERIVED: DerivedMarketKind[] = ["openInterest", "volume", "greeks"];

export function emptyMarketDataHealth(): MarketDataHealth {
  return {
    primary: "tastytrade",
    preferred: "tastytrade",
    tastytradeConfigured: false,
    tastytradeOrigin: "live",
    fallback: "schwab",
    active: {
      chain: null,
      quotes: null,
      history: null,
      candles: null,
      openInterest: null,
      volume: null,
      greeks: null,
    },
    lastServed: { chain: null, quotes: null, history: null, candles: null },
    counts: { tastytrade: 0, schwab: 0 },
    fallbackCount: 0,
    fallbacks: 0,
    lastError: null,
    lastTastytradeSuccessAt: null,
    tradeSideDataAvailable: "no",
  };
}

/** Drop bearer tokens and credential assignments. Keep HTTP statuses. */
export function redactMarketText(text: string): string {
  return text
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(
      /(access_token|refresh_token|client_secret|client_id|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1$2[redacted]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

export function redactReason(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  return redactMarketText(text);
}

let tradeSideDataAvailable: TradeSideAvailability = "no";

export function setTradeSideDataAvailable(value: TradeSideAvailability): void {
  tradeSideDataAvailable = value === "yes" ? "yes" : "no";
}

export function getTradeSideDataAvailable(): TradeSideAvailability {
  return tradeSideDataAvailable;
}

export function resetTradeSideForTests(): void {
  tradeSideDataAvailable = "no";
}

function isSource(value: unknown): value is DataSource {
  return value === "tastytrade" || value === "schwab";
}

function parseServed(value: unknown): ServedRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<ServedRecord>;
  if (!isSource(row.source)) return null;
  if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) return null;
  return {
    source: row.source,
    at: row.at,
    fallback: row.fallback === true,
    reason: typeof row.reason === "string" ? redactMarketText(row.reason) : null,
  };
}

/** A blob snapshot. Null when the body is not a status record. */
export function parseStoredMarketDataHealth(value: unknown): MarketDataHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<MarketDataHealth>;
  const base = emptyMarketDataHealth();
  if (!isSource(row.primary) || !isSource(row.preferred)) return null;
  const active = { ...base.active };
  const rawActive = row.active;
  if (rawActive && typeof rawActive === "object") {
    for (const key of [...KINDS, ...DERIVED]) {
      const source = (rawActive as Record<string, unknown>)[key];
      active[key] = isSource(source) ? source : null;
    }
  }
  const lastServed = { ...base.lastServed };
  const rawServed = row.lastServed;
  if (rawServed && typeof rawServed === "object") {
    for (const key of KINDS) {
      lastServed[key] = parseServed((rawServed as Record<string, unknown>)[key]);
    }
  }
  const counts = { tastytrade: 0, schwab: 0 };
  if (row.counts && typeof row.counts === "object") {
    const raw = row.counts as Partial<Record<DataSource, unknown>>;
    if (typeof raw.tastytrade === "number" && raw.tastytrade >= 0) counts.tastytrade = Math.floor(raw.tastytrade);
    if (typeof raw.schwab === "number" && raw.schwab >= 0) counts.schwab = Math.floor(raw.schwab);
  }
  const fallbacks = typeof row.fallbacks === "number" && row.fallbacks >= 0
    ? Math.floor(row.fallbacks)
    : typeof row.fallbackCount === "number" && row.fallbackCount >= 0
      ? Math.floor(row.fallbackCount)
      : 0;
  const success = typeof row.lastTastytradeSuccessAt === "string" && Number.isFinite(Date.parse(row.lastTastytradeSuccessAt))
    ? row.lastTastytradeSuccessAt
    : null;
  return {
    ...base,
    primary: row.primary,
    preferred: row.preferred,
    tastytradeConfigured: row.tastytradeConfigured === true,
    active,
    lastServed,
    counts,
    fallbackCount: fallbacks,
    fallbacks,
    lastError: typeof row.lastError === "string" ? redactMarketText(row.lastError) : null,
    lastTastytradeSuccessAt: success,
    tradeSideDataAvailable: row.tradeSideDataAvailable === "yes" ? "yes" : "no",
  };
}

function stamp(health: MarketDataHealth): number {
  let max = 0;
  for (const key of KINDS) {
    const at = Date.parse(health.lastServed[key]?.at ?? "");
    if (at > max) max = at;
  }
  const success = Date.parse(health.lastTastytradeSuccessAt ?? "");
  if (success > max) max = success;
  return max;
}

/**
 * The scanning instance's memory wins when it has a newer serve.
 * primary and preferred always come from the current process env (the live view).
 */
export function mergeMarketDataHealth(live: MarketDataHealth, stored: MarketDataHealth | null): MarketDataHealth {
  if (!stored) return live;
  const newer = stamp(live) >= stamp(stored) && stamp(live) > 0 ? live : stored;
  return {
    ...newer,
    primary: live.primary,
    preferred: live.preferred,
    tastytradeConfigured: live.tastytradeConfigured,
    tastytradeOrigin: "live",
    fallback: "schwab",
  };
}
