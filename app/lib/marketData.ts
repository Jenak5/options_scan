import type { OptionContract } from "@/app/lib/contract";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import * as schwab from "@/app/lib/schwab";
import type { ChainParseResult, ParsedQuote, PriceCandle } from "@/app/lib/schwabParse";
import { preferredDataSource, type DataSource } from "@/app/lib/dataSourcePref";
import { tastytradeCandleConfigured } from "@/app/lib/tastytradeCandles";
import { ttOptionChain, ttPriceHistory, ttQuoteEntries } from "@/app/lib/tastytradeMarket";

/**
 * Market data router. DATA_SOURCE=tastytrade (the default when the Tastytrade
 * OAuth values are set) tries Tastytrade first and falls back to Schwab on an
 * error or an empty answer, but only when the Schwab login is still valid.
 * A dead Schwab login skips that item. DATA_SOURCE=schwab uses Schwab only
 * and still stops the run when Schwab is disconnected.
 * Signatures match app/lib/schwab so callers only change the import.
 * Read-only. Logs name the source, never a token.
 */

export type { DataSource };
export { preferredDataSource };
export type DataKind = "chain" | "quotes" | "history";

/** Tastytrade missed this item and Schwab could not fill it. Not fatal while Tastytrade is preferred. */
export class BothSourcesFailedError extends Error {
  readonly label: string;
  constructor(label: string, primaryReason: string, backupReason: string) {
    super(`${label} skipped: ${primaryReason}; ${backupReason}`);
    this.name = "BothSourcesFailedError";
    this.label = label;
  }
}

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

function failBoth(label: string, primaryReason: string, backupReason: string): never {
  const primary = shortenPrimary(primaryReason);
  console.warn(`${label} skipped: ${primary}; ${backupReason}`);
  throw new BothSourcesFailedError(label, primary, backupReason);
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
    if (isAbort(err)) throw err;
    reason = safeReason(err);
  }
  if (!(await schwab.schwabBackupAvailable())) {
    failBoth(label, reason, "Schwab backup not connected");
  }
  try {
    const value = await backup();
    note(kind, label, "schwab", reason);
    return value;
  } catch (err) {
    if (isAbort(err)) throw err;
    failBoth(label, reason, backupFailureReason(err));
  }
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
  if (preferredDataSource() === "schwab") {
    const value = await schwab.getQuoteEntries(wanted, signal);
    note("quotes", `${wanted.length} symbols`, "schwab", null);
    return value;
  }

  let primaryEntries: ParsedQuote[] = [];
  let reason = "empty Tastytrade answer";
  try {
    const primary = await ttQuoteEntries(wanted, signal);
    primaryEntries = primary.entries;
    if (missingSymbols(wanted, primaryEntries).length === 0) {
      note("quotes", `${wanted.length} symbols`, "tastytrade", null);
      return { entries: primaryEntries, problem: primary.problem };
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
      note("quotes", `${wanted.length} symbols`, "tastytrade", "partial");
      return { entries: primaryEntries, problem: null };
    }
    failBoth(label, reason, "Schwab backup not connected");
  }

  try {
    const backup = await schwab.getQuoteEntries(missing, signal);
    const merged = mergeEntries(primaryEntries, backup.entries);
    const still = missingSymbols(wanted, merged);
    const usedBackup = backup.entries.length > 0;
    note("quotes", `${wanted.length} symbols`, usedBackup ? "schwab" : "tastytrade", reason);
    if (still.length > 0) {
      logSkip(missingLabel(still), reason, usedBackup ? "Schwab had no quote" : "Schwab backup failed");
    }
    return { entries: merged, problem: merged.length > 0 ? null : backup.problem };
  } catch (err) {
    if (isAbort(err)) throw err;
    if (primaryEntries.length > 0) {
      logSkip(label, reason, backupFailureReason(err));
      note("quotes", `${wanted.length} symbols`, "tastytrade", "partial");
      return { entries: primaryEntries, problem: null };
    }
    failBoth(label, reason, backupFailureReason(err));
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
