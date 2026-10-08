import type { OptionContract } from "@/app/lib/contract";
import type { StoredTrade } from "@/app/lib/trades";
import { FLOW_BATCH_SIZE } from "@/app/lib/flow";
import { findContract, checkBidAskSpread } from "@/app/lib/gate";
import { normalizeOptionSymbol, schwabOptionSymbol } from "@/app/lib/optionSymbol";
import {
  getOptionChain,
  getQuoteEntries,
  schwabConfigured,
  SchwabConfigError,
  SchwabNotConnectedError,
} from "@/app/lib/schwab";

/**
 * Marks for open paper trades and shadow alerts, from the same Schwab chain the scanner uses.
 * The midpoint is the mark. The bid is kept for a shadow exit when the midpoint is missing.
 * A missing quote leaves that contract unmarked. Nothing here places an order.
 */

export interface ContractMark {
  mid: number | null;
  bid: number | null;
}

type Quotable = Pick<StoredTrade, "id" | "ticker" | "putCall" | "strike" | "expiration" | "closedAt">;

export async function quoteTradeMarks(trades: readonly Quotable[]): Promise<Record<string, number>> {
  const marks = await quoteContractMarks(trades);
  const mids: Record<string, number> = {};
  const ids = Object.keys(marks);
  for (let i = 0; i < ids.length; i++) {
    const mid = marks[ids[i]].mid;
    if (mid != null && mid > 0) mids[ids[i]] = mid;
  }
  return mids;
}

export async function quoteContractMarks(trades: readonly Quotable[]): Promise<Record<string, ContractMark>> {
  const marks: Record<string, ContractMark> = {};
  if (!schwabConfigured()) return marks;
  const open = trades.filter((trade) => trade.closedAt == null);
  const unique: Quotable[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < open.length; i++) {
    const trade = open[i];
    const key = contractKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trade);
  }

  for (let i = 0; i < unique.length; i += FLOW_BATCH_SIZE) {
    const batch = unique.slice(i, i + FLOW_BATCH_SIZE);
    let batchMarks: Array<{ trade: Quotable; mark: ContractMark | null }> = [];
    try {
      batchMarks = await Promise.all(batch.map(async (trade) => ({
        trade,
        mark: await readMark(trade),
      })));
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) return marks;
      batchMarks = [];
    }
    for (let j = 0; j < batchMarks.length; j++) {
      const item = batchMarks[j];
      if (!item.mark) continue;
      assignMark(marks, open, item.trade, item.mark);
    }
  }
  return marks;
}

async function readMark(trade: Quotable): Promise<ContractMark | null> {
  try {
    const chain = await getOptionChain({
      symbol: trade.ticker,
      contractType: trade.putCall === "call" ? "CALL" : "PUT",
      strike: trade.strike,
      fromDate: trade.expiration,
      toDate: trade.expiration,
    });
    const contract = findContract(chain.contracts, {
      expiration: trade.expiration,
      strike: trade.strike,
      putCall: trade.putCall,
    });
    if (!contract) return null;
    const spread = checkBidAskSpread(contract.bid, contract.ask);
    const mid = spread.mid != null && spread.mid > 0 ? spread.mid : null;
    const bid = Number.isFinite(contract.bid) && contract.bid > 0 ? contract.bid : null;
    if (mid == null && bid == null) return null;
    return { mid, bid };
  } catch (err) {
    if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
    return null;
  }
}

function assignMark(
  marks: Record<string, ContractMark>,
  open: readonly Quotable[],
  trade: Quotable,
  mark: ContractMark,
): void {
  for (let i = 0; i < open.length; i++) {
    const other = open[i];
    if (other.ticker !== trade.ticker || other.putCall !== trade.putCall) continue;
    if (other.expiration !== trade.expiration) continue;
    if (Math.abs(other.strike - trade.strike) >= 0.001) continue;
    marks[other.id] = mark;
  }
}

function contractKey(trade: Quotable): string {
  return `${trade.ticker}|${trade.expiration}|${trade.strike}|${trade.putCall}`;
}

/**
 * One Schwab quotes read for the open paper trades in a brief.
 * Chains are heavier and the scorecard already uses them on its 15-minute pass.
 * This does not write a trade, a shadow, or an alert. A slow or failed quote
 * returns whatever already arrived, or nothing, so the brief can label the stored mark.
 * A token refresh inside the Schwab client can still update the stored access token.
 */

/** How long the brief waits on Schwab before it falls back to the stored mark. */
export const BRIEF_QUOTE_TIMEOUT_MS = 5_000;

/** Symbols per quotes request. Open paper trades are few, so this is usually one call. */
export const BRIEF_QUOTE_BATCH = 20;

export interface PaperQuote {
  bid: number | null;
  ask: number | null;
  /** (bid + ask) / 2 when both sides are present and the ask is not below the bid. */
  mid: number | null;
  /** Schwab quote time, milliseconds since epoch. Null when the payload had no time. */
  quotedAt: number | null;
}

export async function quoteOpenPaperTrades(
  trades: readonly Quotable[],
  timeoutMs: number = BRIEF_QUOTE_TIMEOUT_MS,
): Promise<Record<string, PaperQuote>> {
  const open = trades.filter((trade) => trade.closedAt == null);
  if (open.length === 0 || !schwabConfigured()) return {};
  try {
    return await withDeadline((signal) => fetchPaperQuotes(open, signal), timeoutMs);
  } catch {
    return {};
  }
}

async function fetchPaperQuotes(
  open: readonly Quotable[],
  signal: AbortSignal,
): Promise<Record<string, PaperQuote>> {
  const quotes: Record<string, PaperQuote> = {};
  const groups = quoteGroups(open);
  const bySymbol = new Map<string, string[]>();
  for (let i = 0; i < groups.length; i++) bySymbol.set(normalizeOptionSymbol(groups[i].symbol), groups[i].ids);

  for (let i = 0; i < groups.length; i += BRIEF_QUOTE_BATCH) {
    if (signal.aborted) break;
    const batch = groups.slice(i, i + BRIEF_QUOTE_BATCH);
    const symbols: string[] = [];
    for (let j = 0; j < batch.length; j++) symbols.push(batch[j].symbol);
    let entries: Awaited<ReturnType<typeof getQuoteEntries>> = [];
    try {
      entries = await getQuoteEntries(symbols, signal);
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) break;
      break;
    }
    for (let j = 0; j < entries.length; j++) {
      const quote = paperQuoteFromContract(entries[j].contract);
      if (!quote) continue;
      const ids = bySymbol.get(normalizeOptionSymbol(entries[j].symbol));
      if (!ids) continue;
      for (let k = 0; k < ids.length; k++) quotes[ids[k]] = quote;
    }
  }
  return quotes;
}

function quoteGroups(open: readonly Quotable[]): Array<{ symbol: string; ids: string[] }> {
  const groups: Array<{ symbol: string; ids: string[] }> = [];
  const index = new Map<string, { symbol: string; ids: string[] }>();
  for (let i = 0; i < open.length; i++) {
    const trade = open[i];
    const symbol = schwabOptionSymbol({
      ticker: trade.ticker,
      expiration: trade.expiration,
      strike: trade.strike,
      putCall: trade.putCall,
    });
    if (!symbol) continue;
    const key = normalizeOptionSymbol(symbol);
    const existing = index.get(key);
    if (existing) {
      existing.ids.push(trade.id);
      continue;
    }
    const group = { symbol, ids: [trade.id] };
    index.set(key, group);
    groups.push(group);
  }
  return groups;
}

function paperQuoteFromContract(contract: OptionContract): PaperQuote | null {
  const bid = positivePrice(contract.bid);
  const ask = positivePrice(contract.ask);
  const mid = bid != null && ask != null && ask >= bid ? roundQuote((bid + ask) / 2) : null;
  if (bid == null && mid == null) return null;
  const quotedAt = contract.quoteTime != null && Number.isFinite(contract.quoteTime) && contract.quoteTime > 0
    ? contract.quoteTime
    : null;
  return { bid, ask, mid, quotedAt };
}

function positivePrice(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || !(value > 0)) return null;
  return value;
}

/** Keep a computed midpoint off a binary tail. Schwab quotes are already in cents or half-cents. */
function roundQuote(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("quote timeout"));
    }, timeoutMs);
    work(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
