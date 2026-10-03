import { loadAlertBook } from "@/app/lib/alertStore";
import { quoteContractMarks } from "@/app/lib/tradeQuotes";
import { parseTradeLog } from "@/app/lib/trades";
import {
  addMissingShadows,
  applyShadowQuote,
  contractKey,
  emptyShadowBook,
  mergeShadowBooks,
  parseShadowBook,
  shadowsToCsv,
  shadowsToQuote,
  summarizeShadows,
  type ShadowBook,
  type ShadowScorecard,
  type ShadowTrade,
} from "@/app/lib/shadow";
import {
  readShadowBookText,
  readTradeLogText,
  resolveStoreKind,
  updateShadowBook,
} from "@/app/lib/schwabStore";

/**
 * Shadow outcomes on the same private store as the alert book.
 * No new environment variable. Nothing here places an order.
 * Paper trades stay in the trade log. A shadow for that alert is left out of the totals.
 */

export interface ShadowPassResult {
  opened: number;
  quoted: number;
  closed: number;
  saved: boolean;
}

export interface ShadowPage extends ShadowScorecard {
  stored: boolean;
}

export async function loadShadowPage(now: Date): Promise<ShadowPage> {
  const [text, tradeText] = await Promise.all([readShadowBookText(), readTradeLogText()]);
  const book = parseShadowBook(text);
  return {
    ...summarizeShadows(book.records, paperAlertIds(tradeText), now),
    stored: resolveStoreKind() !== "unconfigured",
  };
}

export async function shadowCsv(): Promise<string> {
  const [text, tradeText] = await Promise.all([readShadowBookText(), readTradeLogText()]);
  const book = parseShadowBook(text);
  return shadowsToCsv(book.records, paperAlertIds(tradeText));
}

/**
 * Open a shadow for every new A or B, then mark the open ones and apply the exit rules.
 * Quote work is outside the store write so a retried save does not fetch the chain again.
 */
export async function runShadowPass(now: Date): Promise<ShadowPassResult> {
  const [alertBook, currentText] = await Promise.all([loadAlertBook(), readShadowBookText()]);
  const synced = addMissingShadows(parseShadowBook(currentText), alertBook.records);
  const due = shadowsToQuote(synced.book.records);
  const dueIds = new Set(due.map((row) => row.id));
  const quotes = await quoteContractMarks(due.map(asQuotable));
  const quotedIds = new Set<string>();
  const nextRecords = synced.book.records.map((row) => {
    if (row.status !== "open") return row;
    if (!dueIds.has(row.id)) return applyShadowQuote(row, null, now);
    const quote = quotes[row.id] ?? null;
    if (quote) quotedIds.add(contractKey(row));
    return applyShadowQuote(row, quote, now);
  });
  const quoted = quotedIds.size;
  const edited: ShadowBook = { version: 1, records: nextRecords };
  const closed = countClosed(synced.book.records, edited.records);
  if (sameBook(synced.book, edited) && synced.opened === 0) {
    return { opened: 0, quoted, closed: 0, saved: true };
  }
  const saved = await updateShadowBook((current) => {
    const merged = mergeShadowBooks(parseShadowBook(current), edited);
    return JSON.stringify(merged);
  });
  return { opened: synced.opened, quoted, closed, saved };
}

function paperAlertIds(tradeText: string | null): Set<string> {
  const ids = new Set<string>();
  const trades = parseTradeLog(tradeText).trades;
  for (let i = 0; i < trades.length; i++) {
    const id = trades[i].alertId;
    if (id) ids.add(id);
  }
  return ids;
}

function asQuotable(row: ShadowTrade): {
  id: string;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  closedAt: null;
} {
  return {
    id: row.id,
    ticker: row.ticker,
    putCall: row.putCall,
    strike: row.strike,
    expiration: row.expiration,
    closedAt: null,
  };
}

function countClosed(before: readonly ShadowTrade[], after: readonly ShadowTrade[]): number {
  const wasOpen = new Set<string>();
  for (let i = 0; i < before.length; i++) {
    if (before[i].status === "open") wasOpen.add(before[i].id);
  }
  let closed = 0;
  for (let i = 0; i < after.length; i++) {
    if (wasOpen.has(after[i].id) && after[i].status === "closed") closed += 1;
  }
  return closed;
}

function sameBook(left: ShadowBook, right: ShadowBook): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export { emptyShadowBook };
