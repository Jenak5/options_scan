import { loadAlertBook } from "@/app/lib/alertStore";
import { openingLabelsById } from "@/app/lib/openingCheck";
import { quoteContractMarks } from "@/app/lib/tradeQuotes";
import { parseTradeLog } from "@/app/lib/trades";
import { chooseExperimental, experimentalShadow } from "@/app/lib/experiment";
import type { FlowRow } from "@/app/lib/flow";
import {
  addMissingShadows,
  addShadowRecords,
  applyShadowQuote,
  attachMissingFeatures,
  contractKey,
  emptyShadowBook,
  isExperimentShadow,
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

/** Tickers with an open shadow alert or an open paper trade. Cron scans these every run. */
export async function openScanTickers(): Promise<string[]> {
  const [shadowText, tradeText] = await Promise.all([readShadowBookText(), readTradeLogText()]);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (ticker: string) => {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    out.push(symbol);
  };
  const shadows = parseShadowBook(shadowText).records;
  for (let i = 0; i < shadows.length; i++) {
    if (shadows[i].status === "open" && !isExperimentShadow(shadows[i])) add(shadows[i].ticker);
  }
  const trades = parseTradeLog(tradeText).trades;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].closedAt == null) add(trades[i].ticker);
  }
  return out;
}

export async function shadowCsv(): Promise<string> {
  const [text, tradeText, alerts] = await Promise.all([
    readShadowBookText(),
    readTradeLogText(),
    loadAlertBook(),
  ]);
  const book = parseShadowBook(text);
  return shadowsToCsv(book.records, paperAlertIds(tradeText), openingLabelsById(alerts.records));
}

/**
 * Open a shadow row for every saved A or B that does not have one yet.
 * No Schwab quote. A later pass marks the open rows.
 */
/** Skip a second mark when this shadow was already marked a few minutes ago. */
const MARK_REUSE_MS = 10 * 60 * 1000;

/**
 * Mark open shadows from chain rows this scan already scored.
 * No extra Schwab read. A shadow marked in the last 10 minutes is left as it is.
 */
export async function markShadowsFromRows(
  rows: readonly FlowRow[],
  now: Date,
): Promise<{ marked: number; closed: number; saved: boolean }> {
  const quotes = quotesFromRows(rows);
  if (quotes.size === 0) return { marked: 0, closed: 0, saved: true };
  const preview = applyRowMarks(parseShadowBook(await readShadowBookText()), quotes, now);
  if (preview.marked === 0) return { marked: 0, closed: 0, saved: true };
  let marked = 0;
  let closed = 0;
  const saved = await updateShadowBook((text) => {
    const applied = applyRowMarks(parseShadowBook(text), quotes, now);
    marked = applied.marked;
    closed = applied.closed;
    if (applied.marked === 0) return text ?? JSON.stringify({ version: 1, records: applied.records });
    return JSON.stringify({ version: 1, records: applied.records });
  });
  return { marked: saved ? marked : 0, closed: saved ? closed : 0, saved };
}

function quotesFromRows(rows: readonly FlowRow[]): Map<string, { mid: number | null; bid: number | null }> {
  const quotes = new Map<string, { mid: number | null; bid: number | null }>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const mid = row.mid != null && Number.isFinite(row.mid) && row.mid > 0 ? row.mid : null;
    const bid = Number.isFinite(row.bid) && row.bid > 0 ? row.bid : null;
    if (mid == null && bid == null) continue;
    quotes.set(row.id, { mid, bid });
  }
  return quotes;
}

function applyRowMarks(
  book: ShadowBook,
  quotes: ReadonlyMap<string, { mid: number | null; bid: number | null }>,
  now: Date,
): { records: ShadowTrade[]; marked: number; closed: number } {
  let marked = 0;
  let closed = 0;
  const nowMs = now.getTime();
  const records = book.records.map((shadow) => {
    if (shadow.status !== "open") return shadow;
    if (shadow.lastMarkedAt != null && nowMs >= shadow.lastMarkedAt && nowMs - shadow.lastMarkedAt < MARK_REUSE_MS) {
      return shadow;
    }
    const quote = quotes.get(contractKey(shadow));
    if (!quote) return shadow;
    const updated = applyShadowQuote(shadow, quote, now);
    if (updated.lastMarkedAt !== nowMs) return shadow;
    marked += 1;
    if (updated.status === "closed") closed += 1;
    return updated;
  });
  return { records, marked, closed };
}

export async function openMissingShadows(): Promise<{ opened: number; saved: boolean }> {
  const [alertBook, currentText] = await Promise.all([loadAlertBook(), readShadowBookText()]);
  const synced = addMissingShadows(parseShadowBook(currentText), alertBook.records);
  if (synced.opened === 0) return { opened: 0, saved: true };
  const saved = await updateShadowBook((current) => {
    const latest = parseShadowBook(current);
    const again = addMissingShadows(latest, alertBook.records);
    return JSON.stringify({ version: 1, records: attachMissingFeatures(again.book.records, alertBook.records) });
  });
  return { opened: saved ? synced.opened : 0, saved };
}

/**
 * Open a shadow for every new A or B, then mark the open ones and apply the exit rules.
 * Quote work is outside the store write so a retried save does not fetch the chain again.
 */
export async function runShadowPass(now: Date): Promise<ShadowPassResult> {
  const [alertBook, currentText] = await Promise.all([loadAlertBook(), readShadowBookText()]);
  const synced = addMissingShadows(parseShadowBook(currentText), alertBook.records);
  const withFeatures = attachMissingFeatures(synced.book.records, alertBook.records);
  const featured: ShadowBook = { version: 1, records: withFeatures };
  const due = shadowsToQuote(featured.records);
  const dueIds = new Set(due.map((row) => row.id));
  const quotes = await quoteContractMarks(due.map(asQuotable));
  const quotedIds = new Set<string>();
  const nextRecords = featured.records.map((row) => {
    if (row.status !== "open") return row;
    if (!dueIds.has(row.id)) return applyShadowQuote(row, null, now);
    const quote = quotes[row.id] ?? null;
    if (quote) quotedIds.add(contractKey(row));
    return applyShadowQuote(row, quote, now);
  });
  const quoted = quotedIds.size;
  const edited: ShadowBook = { version: 1, records: nextRecords };
  const closed = countClosed(featured.records, edited.records);
  if (sameBook(featured, edited) && synced.opened === 0) {
    return { opened: 0, quoted, closed: 0, saved: true };
  }
  const saved = await updateShadowBook((current) => {
    const merged = mergeShadowBooks(parseShadowBook(current), edited);
    return JSON.stringify(merged);
  });
  return { opened: synced.opened, quoted, closed, saved };
}

/**
 * Open test shadows from contracts the scan already scored.
 * No chain read. Quotes wait for a later shadow pass, inside the existing cap.
 */
export async function recordExperimentalShadows(
  rows: readonly FlowRow[],
  consecutiveLosses: number | null,
  now: Date,
): Promise<{ opened: number; saved: boolean }> {
  const current = parseShadowBook(await readShadowBookText());
  if (chooseExperimental({ rows, consecutiveLosses, now, existing: current.records }).length === 0) {
    return { opened: 0, saved: true };
  }
  let opened = 0;
  const saved = await updateShadowBook((text) => {
    const latest = parseShadowBook(text);
    const picks = chooseExperimental({ rows, consecutiveLosses, now, existing: latest.records });
    const added: ShadowTrade[] = [];
    for (let i = 0; i < picks.length; i++) {
      const shadow = experimentalShadow(picks[i].row, picks[i].probe, now);
      if (shadow) added.push(shadow);
    }
    opened = added.length;
    if (added.length === 0) return JSON.stringify(latest);
    return JSON.stringify(addShadowRecords(latest, added));
  });
  return { opened: saved ? opened : 0, saved };
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
