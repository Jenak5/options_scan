import type { OptionContract } from "@/app/lib/contract";
import * as schwab from "@/app/lib/schwab";
import type { ChainParseResult, PriceCandle } from "@/app/lib/schwabParse";
import { tastytradeCandleConfigured } from "@/app/lib/tastytradeCandles";
import { ttOptionChain, ttPriceHistory, ttQuoteEntries } from "@/app/lib/tastytradeMarket";

/**
 * Market data router. DATA_SOURCE=tastytrade (the default when the Tastytrade
 * OAuth values are set) tries Tastytrade first and falls back to Schwab on an
 * error or an empty answer. DATA_SOURCE=schwab uses Schwab only.
 * Signatures match app/lib/schwab so callers only change the import.
 * Read-only. Logs name the source, never a token.
 */

export type DataSource = "tastytrade" | "schwab";
export type DataKind = "chain" | "quotes" | "history";

export interface ServedRecord {
  source: DataSource;
  at: string;
  fallback: boolean;
  reason: string | null;
}

export interface DataSourceStatus {
  preferred: DataSource;
  tastytradeConfigured: boolean;
  tastytradeOrigin: "live";
  fallback: "schwab";
  /** Last request of each kind on this server instance. Null before the first one. */
  lastServed: Record<DataKind, ServedRecord | null>;
  counts: Record<DataSource, number>;
  fallbacks: number;
}

const lastServed: Record<DataKind, ServedRecord | null> = { chain: null, quotes: null, history: null };
const counts: Record<DataSource, number> = { tastytrade: 0, schwab: 0 };
let fallbacks = 0;

export function preferredDataSource(env: Record<string, string | undefined> = process.env): DataSource {
  const flag = (env.DATA_SOURCE ?? "").trim().toLowerCase();
  if (flag === "schwab") return "schwab";
  if (!tastytradeCandleConfigured(env)) return "schwab";
  return "tastytrade";
}

export function dataSourceStatus(env: Record<string, string | undefined> = process.env): DataSourceStatus {
  return {
    preferred: preferredDataSource(env),
    tastytradeConfigured: tastytradeCandleConfigured(env),
    tastytradeOrigin: "live",
    fallback: "schwab",
    lastServed: { ...lastServed },
    counts: { ...counts },
    fallbacks,
  };
}

function note(kind: DataKind, label: string, source: DataSource, reason: string | null): void {
  const fallback = reason != null;
  lastServed[kind] = { source, at: new Date().toISOString(), fallback, reason };
  counts[source] += 1;
  if (fallback) fallbacks += 1;
  const tail = fallback ? ` (fallback: ${reason})` : "";
  console.info(`[market-data] ${kind} ${label} served by ${source}${tail}`);
}

function safeReason(err: unknown): string {
  const text = err instanceof Error ? err.message : "error";
  return text.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/\s+/g, " ").slice(0, 120);
}

export async function withFallback<T>(
  kind: DataKind,
  label: string,
  primary: () => Promise<T>,
  backup: () => Promise<T>,
  usable: (value: T) => boolean,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  if (preferredDataSource(env) === "schwab") {
    const value = await backup();
    note(kind, label, "schwab", null);
    return value;
  }
  let reason: string;
  try {
    const value = await primary();
    if (usable(value)) {
      note(kind, label, "tastytrade", null);
      return value;
    }
    reason = "empty Tastytrade answer";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    reason = safeReason(err);
  }
  const value = await backup();
  note(kind, label, "schwab", reason);
  return value;
}

type ChainInput = Parameters<typeof schwab.getOptionChain>[0];
type HistoryInput = Parameters<typeof schwab.getPriceHistory>[0];

export async function getOptionChain(input: ChainInput): Promise<ChainParseResult> {
  return withFallback(
    "chain",
    input.symbol,
    () => ttOptionChain(input),
    () => schwab.getOptionChain(input),
    (r) => r.contracts.length > 0 && r.underlyingPrice != null,
  );
}

export async function getPriceHistory(input: HistoryInput): Promise<PriceCandle[]> {
  return withFallback(
    "history",
    `${input.symbol} ${input.frequencyType}${input.frequencyType === "minute" ? input.frequency : ""}`,
    () => ttPriceHistory(input),
    () => schwab.getPriceHistory(input),
    (r) => r.length > 0,
  );
}

export async function getQuoteEntries(symbols: string[], signal?: AbortSignal): Promise<schwab.QuoteEntriesResult> {
  return withFallback(
    "quotes",
    `${symbols.length} symbols`,
    () => ttQuoteEntries(symbols, signal),
    () => schwab.getQuoteEntries(symbols, signal),
    // Partial Tastytrade answers fall back so no open trade loses its mark.
    (r) => r.entries.length >= new Set(symbols.map((s) => s.trim()).filter(Boolean)).size,
  );
}

export async function getQuotes(symbols: string[], signal?: AbortSignal): Promise<OptionContract[]> {
  const read = await getQuoteEntries(symbols, signal);
  return read.entries.map((e) => e.contract);
}

export function resetDataSourceStatsForTests(): void {
  lastServed.chain = null;
  lastServed.quotes = null;
  lastServed.history = null;
  counts.tastytrade = 0;
  counts.schwab = 0;
  fallbacks = 0;
}

/** At least one source can answer: Tastytrade preferred, or Schwab app keys set. */
export function marketDataConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return preferredDataSource(env) === "tastytrade" || schwab.schwabConfigured();
}

/**
 * The Schwab connect check only blocks a scan when Schwab is the only source.
 * With Tastytrade first, a disconnected Schwab just means no fallback.
 */
export async function requireMarketData(now: number): Promise<void> {
  if (preferredDataSource() === "tastytrade") return;
  const status = await schwab.getSchwabStatus(now);
  if (!status.configured) throw new schwab.SchwabConfigError();
  if (!status.connected) throw new schwab.SchwabNotConnectedError();
}
