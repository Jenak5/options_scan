import type { OptionContract } from "@/app/lib/contract";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import * as schwab from "@/app/lib/schwab";
import type { ChainParseResult, ParsedQuote, PriceCandle } from "@/app/lib/schwabParse";
import { preferredDataSource, requestedPrimary, type DataSource } from "@/app/lib/dataSourcePref";
import { tastytradeCandleConfigured } from "@/app/lib/tastytradeCandles";
import {
  emptyMarketDataHealth,
  getTradeSideDataAvailable,
  mergeMarketDataHealth,
  redactReason,
  type MarketDataHealth,
  type MarketDataKind,
  type ServedRecord,
} from "@/app/lib/marketDataHealth";
import { createSchwabProvider, createTastytradeProvider, type MarketDataProvider } from "@/app/lib/marketProviders";
import { readStoredMarketDataHealth, writeStoredMarketDataHealth } from "@/app/lib/tastytradeStore";

/**
 * Market data router. MARKET_DATA_PRIMARY=tastytrade (the default when the
 * Tastytrade OAuth values are set) tries Tastytrade first and falls back to
 * Schwab on a 401, a timeout, an empty answer, or any other error, but only
 * when the Schwab login is still valid. A dead Schwab login skips that item.
 * MARKET_DATA_PRIMARY=schwab uses Schwab only and still stops the run when
 * Schwab is disconnected. DATA_SOURCE is the older name of the same flag.
 * Read-only. Logs name the source, never a token.
 */

export type { DataSource, MarketDataKind, ServedRecord };
export { preferredDataSource, requestedPrimary };
export type DataKind = MarketDataKind;

/** Tastytrade missed this item and Schwab could not fill it. Not fatal while Tastytrade is preferred. */
export class BothSourcesFailedError extends Error {
  readonly label: string;
  constructor(label: string, primaryReason: string, backupReason: string) {
    super(`${label} skipped: ${primaryReason}; ${backupReason}`);
    this.name = "BothSourcesFailedError";
    this.label = label;
  }
}

export type DataSourceStatus = MarketDataHealth;

const lastServed: MarketDataHealth["lastServed"] = { chain: null, quotes: null, history: null, candles: null };
const active: MarketDataHealth["active"] = {
  chain: null,
  quotes: null,
  history: null,
  candles: null,
  openInterest: null,
  volume: null,
  greeks: null,
};
const counts: Record<DataSource, number> = { tastytrade: 0, schwab: 0 };
let fallbacks = 0;
let lastError: string | null = null;
let lastTastytradeSuccessAt: string | null = null;
let persistTail: Promise<void> = Promise.resolve();

const tastytradeProvider = createTastytradeProvider();
const schwabProvider = createSchwabProvider();

/**
 * Health flag for the monitor. True when Tastytrade is the configured primary,
 * the OAuth credentials are present, and this record shows it has served data.
 * The account-tab flag (`TASTYTRADE_ENABLED`) is a different switch and is not read here.
 */
export function healthTastytradeEnabled(
  status: DataSourceStatus | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!status || preferredDataSource(env) !== "tastytrade") return false;
  if (status.lastTastytradeSuccessAt) return true;
  const active = status.active;
  return active.chain === "tastytrade"
    || active.quotes === "tastytrade"
    || active.history === "tastytrade"
    || active.candles === "tastytrade"
    || active.openInterest === "tastytrade"
    || active.volume === "tastytrade"
    || active.greeks === "tastytrade";
}

export function dataSourceStatus(env: Record<string, string | undefined> = process.env): DataSourceStatus {
  return {
    primary: requestedPrimary(env),
    preferred: preferredDataSource(env),
    tastytradeConfigured: tastytradeCandleConfigured(env),
    tastytradeOrigin: "live",
    fallback: "schwab",
    active: { ...active },
    lastServed: {
      chain: lastServed.chain,
      quotes: lastServed.quotes,
      history: lastServed.history,
      candles: lastServed.candles,
    },
    counts: { ...counts },
    fallbackCount: fallbacks,
    fallbacks,
    lastError,
    lastTastytradeSuccessAt,
    tradeSideDataAvailable: getTradeSideDataAvailable(),
  };
}

/** Memory plus the last blob snapshot. primary and preferred follow the current env. */
export async function loadMarketDataHealth(env: Record<string, string | undefined> = process.env): Promise<DataSourceStatus> {
  const live = dataSourceStatus(env);
  try {
    const stored = await readStoredMarketDataHealth();
    return mergeMarketDataHealth(live, stored);
  } catch {
    return live;
  }
}

function persistStatus(): Promise<void> {
  if (process.env.VITEST === "true" || !process.env.BLOB_READ_WRITE_TOKEN) return Promise.resolve();
  const snap = dataSourceStatus();
  persistTail = persistTail.then(() => writeStoredMarketDataHealth(snap)).catch(() => undefined);
  return persistTail;
}

async function note(kind: DataKind, label: string, source: DataSource, reason: string | null): Promise<void> {
  const fallback = reason != null;
  const at = new Date().toISOString();
  lastServed[kind] = { source, at, fallback, reason };
  active[kind] = source;
  if (kind === "history") active.candles = source;
  if (kind === "chain" || kind === "quotes") {
    active.openInterest = source;
    active.volume = source;
    active.greeks = source;
  }
  counts[source] += 1;
  if (fallback) {
    fallbacks += 1;
    lastError = reason;
  }
  if (source === "tastytrade" && !fallback) lastTastytradeSuccessAt = at;
  const tail = fallback ? ` (fallback: ${reason})` : "";
  console.info(`[market-data] ${kind} ${label} served by ${source}${tail}`);
  await persistStatus();
}

/** Record a candle-job result without counting it as a Schwab fallback. */
export async function noteMarketDataError(reason: string): Promise<void> {
  lastError = redactReason(reason);
  await persistStatus();
}

export async function recordMarketData(kind: DataKind, source: DataSource, reason: string | null, label: string = kind): Promise<void> {
  await note(kind, label, source, reason);
}

function safeReason(err: unknown): string {
  return redactReason(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** A Schwab disconnect stops the run only when Schwab is the only source. */
export function isFatalSchwabError(err: unknown, env: Record<string, string | undefined> = process.env): boolean {
  if (preferredDataSource(env) !== "schwab") return false;
  if (err instanceof schwab.SchwabNotConnectedError || err instanceof schwab.SchwabConfigError) return true;
  return err instanceof Error && err.message.startsWith("Schwab token refresh failed");
}

export function rethrowIfSchwabOnly(err: unknown): void {
  if (isFatalSchwabError(err)) throw err;
}

/** Schwab could not answer. Fatal only when Schwab is the only source. */
export function isSchwabBackupMiss(err: unknown): boolean {
  if (err instanceof BothSourcesFailedError) return true;
  if (err instanceof schwab.SchwabNotConnectedError || err instanceof schwab.SchwabConfigError) return true;
  return err instanceof Error && err.message.startsWith("Schwab token refresh failed");
}

function shortenPrimary(reason: string): string {
  const status = /\((\d{3})\)/.exec(reason);
  if (status && /tastytrade/i.test(reason)) return `tastytrade ${status[1]}`;
  if (/timed out/i.test(reason)) return "tastytrade timeout";
  if (reason === "empty Tastytrade answer") return "tastytrade empty";
  if (reason === "partial Tastytrade quote") return "tastytrade partial";
  return reason.replace(/\s+/g, " ").slice(0, 80);
}

function backupFailureReason(err: unknown): string {
  if (err instanceof schwab.SchwabNotConnectedError || err instanceof schwab.SchwabConfigError) {
    return "Schwab backup not connected";
  }
  if (err instanceof Error && /token refresh failed/i.test(err.message)) return "Schwab token refresh failed";
  if (err instanceof Error) {
    const status = /failed \((\d{3})\)/.exec(err.message);
    if (status) return `Schwab ${status[1]}`;
  }
  return "Schwab backup failed";
}

async function failBoth(label: string, primaryReason: string, backupReason: string): Promise<BothSourcesFailedError> {
  const primary = shortenPrimary(primaryReason);
  lastError = primary;
  console.warn(`${label} skipped: ${primary}; ${backupReason}`);
  await persistStatus();
  return new BothSourcesFailedError(label, primary, backupReason);
}

function logSkip(label: string, primaryReason: string, backupReason: string): void {
  console.warn(`${label} skipped: ${shortenPrimary(primaryReason)}; ${backupReason}`);
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
    await note(kind, label, "schwab", null);
    return value;
  }
  let reason: string;
  try {
    const value = await primary();
    if (usable(value)) {
      await note(kind, label, "tastytrade", null);
      return value;
    }
    reason = "empty Tastytrade answer";
  } catch (err) {
    if (isAbort(err)) throw err;
    reason = safeReason(err);
  }
  if (!(await schwab.schwabBackupAvailable())) {
    throw await failBoth(label, reason, "Schwab backup not connected");
  }
  try {
    const value = await backup();
    await note(kind, label, "schwab", reason);
    return value;
  } catch (err) {
    if (isAbort(err)) throw err;
    throw await failBoth(label, reason, backupFailureReason(err));
  }
}

type ChainInput = Parameters<typeof schwab.getOptionChain>[0];
type HistoryInput = Parameters<typeof schwab.getPriceHistory>[0];

function providers(): { primary: MarketDataProvider; backup: MarketDataProvider } {
  return { primary: tastytradeProvider, backup: schwabProvider };
}

export async function getOptionChain(input: ChainInput): Promise<ChainParseResult> {
  const { primary, backup } = providers();
  return withFallback(
    "chain",
    input.symbol,
    () => primary.getOptionChain(input),
    () => backup.getOptionChain(input),
    (r) => r.contracts.length > 0 && r.underlyingPrice != null,
  );
}

export async function getPriceHistory(input: HistoryInput): Promise<PriceCandle[]> {
  const { primary, backup } = providers();
  return withFallback(
    "history",
    `${input.symbol} ${input.frequencyType}${input.frequencyType === "minute" ? input.frequency : ""}`,
    () => primary.getPriceHistory(input),
    () => backup.getPriceHistory(input),
    (r) => r.length > 0,
  );
}

function uniqueSymbols(symbols: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i].trim();
    if (!symbol) continue;
    const key = normalizeOptionSymbol(symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

function coveredKeys(entries: readonly ParsedQuote[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < entries.length; i++) keys.add(normalizeOptionSymbol(entries[i].symbol));
  return keys;
}

function missingSymbols(wanted: readonly string[], entries: readonly ParsedQuote[]): string[] {
  const have = coveredKeys(entries);
  const missing: string[] = [];
  for (let i = 0; i < wanted.length; i++) {
    if (!have.has(normalizeOptionSymbol(wanted[i]))) missing.push(wanted[i]);
  }
  return missing;
}

function mergeEntries(primary: readonly ParsedQuote[], extra: readonly ParsedQuote[]): ParsedQuote[] {
  const out = primary.slice();
  const seen = coveredKeys(out);
  for (let i = 0; i < extra.length; i++) {
    const key = normalizeOptionSymbol(extra[i].symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(extra[i]);
  }
  return out;
}

function missingLabel(missing: readonly string[]): string {
  if (missing.length === 1) return missing[0];
  if (missing.length <= 4) return missing.join(",");
  return `${missing.length} symbols`;
}

/**
 * Keep every quote Tastytrade returned. Schwab is asked only for the symbols
 * still missing, and only when that login can refresh. A partial Tastytrade
 * answer is never thrown away because the backup is down.
 */
export async function getQuoteEntries(symbols: string[], signal?: AbortSignal): Promise<schwab.QuoteEntriesResult> {
  const wanted = uniqueSymbols(symbols);
  if (wanted.length === 0) return { entries: [], problem: null };
  if (signal?.aborted) throw new DOMException("The quote was aborted", "AbortError");
  const { primary, backup } = providers();
  if (preferredDataSource() === "schwab") {
    const value = await backup.getQuoteEntries(wanted, signal);
    await note("quotes", `${wanted.length} symbols`, "schwab", null);
    return value;
  }

  let primaryEntries: ParsedQuote[] = [];
  let reason = "empty Tastytrade answer";
  try {
    const read = await primary.getQuoteEntries(wanted, signal);
    primaryEntries = read.entries;
    if (missingSymbols(wanted, primaryEntries).length === 0) {
      await note("quotes", `${wanted.length} symbols`, "tastytrade", null);
      return { entries: primaryEntries, problem: read.problem };
    }
    reason = primaryEntries.length > 0 ? "partial Tastytrade quote" : "empty Tastytrade answer";
  } catch (err) {
    if (isAbort(err)) throw err;
    reason = safeReason(err);
    primaryEntries = [];
  }

  const missing = missingSymbols(wanted, primaryEntries);
  const label = missingLabel(missing);
  if (!(await schwab.schwabBackupAvailable())) {
    if (primaryEntries.length > 0) {
      logSkip(label, reason, "Schwab backup not connected");
      await note("quotes", `${wanted.length} symbols`, "tastytrade", "partial");
      return { entries: primaryEntries, problem: null };
    }
    throw await failBoth(label, reason, "Schwab backup not connected");
  }

  try {
    const filled = await backup.getQuoteEntries(missing, signal);
    const merged = mergeEntries(primaryEntries, filled.entries);
    const still = missingSymbols(wanted, merged);
    const usedBackup = filled.entries.length > 0;
    await note("quotes", `${wanted.length} symbols`, usedBackup ? "schwab" : "tastytrade", reason);
    if (still.length > 0) {
      logSkip(missingLabel(still), reason, usedBackup ? "Schwab had no quote" : "Schwab backup failed");
    }
    return { entries: merged, problem: merged.length > 0 ? null : filled.problem };
  } catch (err) {
    if (isAbort(err)) throw err;
    if (primaryEntries.length > 0) {
      logSkip(label, reason, backupFailureReason(err));
      await note("quotes", `${wanted.length} symbols`, "tastytrade", "partial");
      return { entries: primaryEntries, problem: null };
    }
    throw await failBoth(label, reason, backupFailureReason(err));
  }
}

export async function getQuotes(symbols: string[], signal?: AbortSignal): Promise<OptionContract[]> {
  const read = await getQuoteEntries(symbols, signal);
  return read.entries.map((e) => e.contract);
}

export function resetDataSourceStatsForTests(): void {
  lastServed.chain = null;
  lastServed.quotes = null;
  lastServed.history = null;
  lastServed.candles = null;
  active.chain = null;
  active.quotes = null;
  active.history = null;
  active.candles = null;
  active.openInterest = null;
  active.volume = null;
  active.greeks = null;
  counts.tastytrade = 0;
  counts.schwab = 0;
  fallbacks = 0;
  lastError = null;
  lastTastytradeSuccessAt = null;
  persistTail = Promise.resolve();
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

export { emptyMarketDataHealth };
