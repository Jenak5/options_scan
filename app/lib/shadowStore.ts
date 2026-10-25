import { loadAlertBook } from "@/app/lib/alertStore";
import { selectPathMarkShadows, shadowPathStillNeeded } from "@/app/lib/exitWhatIf";
import { openingLabelsById } from "@/app/lib/openingCheck";
import { quoteContractMarks } from "@/app/lib/tradeQuotes";
import { parseTradeLog } from "@/app/lib/trades";
import { loadCandleSeries } from "@/app/lib/candleStore";
import type { CandleBar } from "@/app/lib/candleTypes";
import { chooseEarningsWindow, earningsWindowShadow } from "@/app/lib/earningsWindow";
import { chooseExperimental, experimentalShadow } from "@/app/lib/experiment";
import { CORE_FLOW_WATCHLIST, type FlowRow } from "@/app/lib/flow";
import { chicagoDate, chicagoWallTimeMs, isChicagoMarketHours } from "@/app/lib/marketHours";
import { fetchOptionCandles, tastytradeCandleConfigured } from "@/app/lib/tastytradeCandles";
import {
  addTimeStopShadows,
  refineTimeStop,
  syncTimeStops,
  timeStopsNeedingCandles,
} from "@/app/lib/timeStop60";
import { chooseVwapPuts, vwapPutShadow } from "@/app/lib/vwapPut";
import {
  addResearchTracks,
  type ResearchCandidate,
  type ResearchTrack,
} from "@/app/lib/researchTrack";
import {
  addMissingShadows,
  addShadowRecords,
  appendShadowPathMark,
  applyShadowQuote,
  attachMissingFeatures,
  contractKey,
  emptyShadowBook,
  isExperimentShadow,
  isSideStudyShadow,
  mergeShadowBooks,
  parseShadowBook,
  serializeShadowBook,
  shadowBooksEqual,
  shadowsToCsv,
  shadowsToQuote,
  summarizeShadows,
  type ShadowBook,
  type ShadowScorecard,
  type ShadowTrade,
} from "@/app/lib/shadow";
import { MARK_REUSE_MS } from "@/app/lib/cronCadence";
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
  researchOpened: number;
  researchQuoted: number;
  researchSkipped: number;
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
/**
 * Mark open shadows from chain rows this scan already scored.
 * No extra Schwab read. A shadow marked inside the reuse window is left as it is.
 * That window is one minute under the 5-minute cadence, so the next scheduled scan still marks.
 */
export async function markShadowsFromRows(
  rows: readonly FlowRow[],
  now: Date,
  candidates: readonly ResearchCandidate[] = [],
): Promise<{ marked: number; closed: number; saved: boolean }> {
  const quotes = quotesFromRows(rows);
  const current = parseShadowBook(await readShadowBookText());
  const preview = previewRowPass(current, quotes, candidates, now);
  if (!preview.changed) return { marked: 0, closed: 0, saved: true };
  let marked = 0;
  let closed = 0;
  const saved = await updateShadowBook((text) => {
    const applied = previewRowPass(parseShadowBook(text), quotes, candidates, now);
    marked = applied.marked;
    closed = applied.closed;
    if (!applied.changed) return text ?? serializeShadowBook(applied.book);
    return serializeShadowBook(applied.book);
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

function previewRowPass(
  book: ShadowBook,
  quotes: ReadonlyMap<string, { mid: number | null; bid: number | null }>,
  _candidates: readonly ResearchCandidate[],
  now: Date,
): { book: ShadowBook; marked: number; closed: number; researchOpened: number; changed: boolean } {
  const applied = applyRowMarks(book, quotes, now);
  return {
    book: { ...book, records: applied.records },
    marked: applied.marked,
    closed: applied.closed,
    researchOpened: 0,
    changed: applied.changed,
  };
}

function applyRowMarks(
  book: ShadowBook,
  quotes: ReadonlyMap<string, { mid: number | null; bid: number | null }>,
  now: Date,
): { records: ShadowTrade[]; marked: number; closed: number; changed: boolean } {
  let marked = 0;
  let closed = 0;
  let changed = false;
  const nowMs = now.getTime();
  const records = book.records.map((shadow) => {
    if (shadow.cohort === "time-60") return shadow;
    if (shadow.status === "closed") {
      if (!shadowPathStillNeeded(shadow, now) || markedTooRecently(shadow, nowMs)) return shadow;
      const quote = quotes.get(contractKey(shadow));
      if (!quote) return shadow;
      const updated = appendShadowPathMark(shadow, quote, now);
      if (updated === shadow) return shadow;
      marked += 1;
      changed = true;
      return updated;
    }
    if (shadow.status !== "open") return shadow;
    if (shadow.lastMarkedAt != null && nowMs >= shadow.lastMarkedAt && nowMs - shadow.lastMarkedAt < MARK_REUSE_MS) {
      return shadow;
    }
    const quote = quotes.get(contractKey(shadow));
    if (!quote) return shadow;
    const updated = applyShadowQuote(shadow, quote, now);
    if (updated.lastMarkedAt !== nowMs && updated === shadow) return shadow;
    if (updated === shadow) return shadow;
    changed = true;
    if (!isSideStudyShadow(shadow)) {
      marked += 1;
      if (updated.status === "closed") closed += 1;
    }
    return updated;
  });
  const synced = syncTimeStops(records, now);
  if (synced.some((row, index) => row !== records[index])) changed = true;
  return { records: synced, marked, closed, changed };
}

export async function openMissingShadows(): Promise<{ opened: number; saved: boolean }> {
  const [alertBook, currentText] = await Promise.all([loadAlertBook(), readShadowBookText()]);
  const synced = withNewTimeStops(parseShadowBook(currentText), alertBook.records);
  if (synced.opened === 0 && synced.timeStops === 0) return { opened: 0, saved: true };
  const saved = await updateShadowBook((current) => {
    const latest = parseShadowBook(current);
    const again = withNewTimeStops(latest, alertBook.records);
    return serializeShadowBook({
      version: 1,
      records: attachMissingFeatures(again.book.records, alertBook.records),
      research: again.book.research,
    });
  });
  return { opened: saved ? synced.opened : 0, saved };
}

/**
 * Open a shadow for every new A or B, then mark the open ones and apply the exit rules.
 * Resolved A/B shadows keep a quote path for what-if replays until those replays
 * finish, or until the trading-day or expiry cap. That path uses the same quote
 * batch as the open shadows, with its own small cap. A resolved shadow stays
 * resolved on its original exit.
 * Quote work is outside the store write so a retried save does not fetch the chain again.
 */
export async function runShadowPass(
  now: Date,
  candidates: readonly ResearchCandidate[] = [],
): Promise<ShadowPassResult> {
  const [alertBook, currentText] = await Promise.all([loadAlertBook(), readShadowBookText()]);
  const parsed = parseShadowBook(currentText);
  const synced = withNewTimeStops(parsed, alertBook.records);
  const withFeatures = attachMissingFeatures(synced.book.records, alertBook.records);
  const researchAdded = addResearchTracks(synced.book.research ?? [], candidates, alertBook.records, now);
  const featured: ShadowBook = { version: 1, records: withFeatures, research: researchAdded.tracks };
  const openDue = shadowsToQuote(featured.records);
  const pathDue = selectPathMarkShadows(featured.records, openDue, now);
  const due = openDue.concat(pathDue);
  const dueIds = new Set(due.map((row) => row.id));
  const quotes = await quoteContractMarks(due.map(asQuotable));
  const quotedIds = new Set<string>();
  const quotedRecords = featured.records.map((row) => {
    if (row.cohort === "time-60") return row;
    if (row.status === "closed") {
      if (!dueIds.has(row.id)) return row;
      const quote = quotes[row.id] ?? null;
      if (quote) quotedIds.add(contractKey(row));
      return appendShadowPathMark(row, quote, now);
    }
    if (row.status !== "open") return row;
    if (!dueIds.has(row.id)) return applyShadowQuote(row, null, now);
    const quote = quotes[row.id] ?? null;
    if (quote) quotedIds.add(contractKey(row));
    return applyShadowQuote(row, quote, now);
  });
  const nextRecords = await priceTimeStops(syncTimeStops(quotedRecords, now), now);
  const quoted = quotedIds.size;
  const researchPass = await markResearchTracks(researchAdded.tracks);
  const edited: ShadowBook = { version: 1, records: nextRecords, research: researchPass.tracks };
  const closed = countClosed(featured.records, edited.records);
  const idle = shadowBooksEqual(featured, edited) && synced.opened === 0 && researchAdded.opened === 0;
  if (idle) {
    return {
      opened: 0,
      quoted,
      closed: 0,
      saved: true,
      researchOpened: 0,
      researchQuoted: researchPass.quoted,
      researchSkipped: researchPass.skipped,
    };
  }
  const saved = await updateShadowBook((current) => {
    const merged = mergeShadowBooks(parseShadowBook(current), edited);
    return serializeShadowBook(merged);
  });
  return {
    opened: synced.opened,
    quoted,
    closed,
    saved,
    researchOpened: saved ? researchAdded.opened : 0,
    researchQuoted: researchPass.quoted,
    researchSkipped: researchPass.skipped,
  };
}

/**
 * Stored C and D tracks are not quoted. Their marks stay as saved.
 */
async function markResearchTracks(
  tracks: readonly ResearchTrack[],
): Promise<{ tracks: ResearchTrack[]; quoted: number; skipped: number }> {
  return { tracks: tracks.slice(), quoted: 0, skipped: 0 };
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
    if (added.length === 0) return serializeShadowBook(latest);
    return serializeShadowBook(addShadowRecords(latest, added));
  });
  return { opened: saved ? opened : 0, saved };
}

function withNewTimeStops(
  book: ShadowBook,
  alerts: Parameters<typeof addMissingShadows>[1],
): { book: ShadowBook; opened: number; timeStops: number } {
  const synced = addMissingShadows(book, alerts);
  const timed = addTimeStopShadows(synced.book.records, synced.added);
  if (timed.opened === 0) return { book: synced.book, opened: synced.opened, timeStops: 0 };
  const extra = timed.records.slice(synced.book.records.length);
  return { book: addShadowRecords(synced.book, extra), opened: synced.opened, timeStops: extra.length };
}

/** After the hour, stored 1-minute option candles can replace the live 60-minute price. */
async function priceTimeStops(records: readonly ShadowTrade[], now: Date): Promise<ShadowTrade[]> {
  const due = timeStopsNeedingCandles(records, now).slice(0, 20);
  if (due.length === 0) return records.slice();
  let series: Map<string, CandleBar[]>;
  try {
    series = await loadCandleSeries(due.map((row) => contractKey(row)));
  } catch {
    return records.slice();
  }
  if (series.size === 0) return records.slice();
  return records.map((row) => {
    const bars = series.get(contractKey(row));
    if (!bars || row.cohort !== "time-60") return row;
    return refineTimeStop(row, bars, now, true);
  });
}

const CORE_TICKERS = new Set<string>(CORE_FLOW_WATCHLIST);

/**
 * Paper VWAP puts from contracts this scan already scored.
 * One Tastytrade candle read for the core names. No Schwab call is added, and nothing is sent.
 */
export async function recordVwapRejectionPuts(
  rows: readonly FlowRow[],
  now: Date,
): Promise<{ opened: number; saved: boolean }> {
  if (!isChicagoMarketHours(now) || !tastytradeCandleConfigured()) return { opened: 0, saved: true };
  const tickers: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const ticker = rows[i].ticker;
    if (!CORE_TICKERS.has(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    tickers.push(ticker);
  }
  if (tickers.length === 0) return { opened: 0, saved: true };
  let candles: Map<string, CandleBar[]>;
  try {
    candles = await fetchCoreUnderlyingMinutes(tickers, now);
  } catch {
    return { opened: 0, saved: true };
  }
  return saveVwapPuts(rows, candles, now);
}

/** Save paper puts from candles the caller already has. Tests use this directly. */
export async function saveVwapPuts(
  rows: readonly FlowRow[],
  candles: ReadonlyMap<string, readonly CandleBar[]>,
  now: Date,
): Promise<{ opened: number; saved: boolean }> {
  const current = parseShadowBook(await readShadowBookText());
  if (chooseVwapPuts({ rows, candles, now, existing: current.records }).length === 0) {
    return { opened: 0, saved: true };
  }
  let opened = 0;
  const saved = await updateShadowBook((text) => {
    const latest = parseShadowBook(text);
    const picks = chooseVwapPuts({ rows, candles, now, existing: latest.records });
    const added: ShadowTrade[] = [];
    for (let i = 0; i < picks.length; i++) {
      const shadow = vwapPutShadow(picks[i], now);
      if (shadow) added.push(shadow);
    }
    opened = added.length;
    if (added.length === 0) return serializeShadowBook(latest);
    return serializeShadowBook(addShadowRecords(latest, added));
  });
  return { opened: saved ? opened : 0, saved };
}

/**
 * Paper shadows for contracts the earnings downgrade kept out of A and B.
 * Saved A and B alerts are opened by openMissingShadows and are not duplicated here.
 * No chain read and no Telegram send.
 */
export async function recordEarningsWindowShadows(
  rows: readonly FlowRow[],
  consecutiveLosses: number | null,
  now: Date,
  dates: ReadonlyMap<string, string | null>,
): Promise<{ opened: number; saved: boolean }> {
  const current = parseShadowBook(await readShadowBookText());
  if (chooseEarningsWindow({ rows, consecutiveLosses, now, existing: current.records, dates }).length === 0) {
    return { opened: 0, saved: true };
  }
  let opened = 0;
  const saved = await updateShadowBook((text) => {
    const latest = parseShadowBook(text);
    const picks = chooseEarningsWindow({ rows, consecutiveLosses, now, existing: latest.records, dates });
    const added: ShadowTrade[] = [];
    for (let i = 0; i < picks.length; i++) {
      const shadow = earningsWindowShadow(picks[i].row, picks[i].probe, now);
      if (shadow) added.push(shadow);
    }
    opened = added.length;
    if (added.length === 0) return serializeShadowBook(latest);
    return serializeShadowBook(addShadowRecords(latest, added));
  });
  return { opened: saved ? opened : 0, saved };
}

export async function fetchCoreUnderlyingMinutes(
  tickers: readonly string[],
  now: Date,
): Promise<Map<string, CandleBar[]>> {
  const open = chicagoWallTimeMs(chicagoDate(now), 8, 30);
  if (open == null) return new Map();
  const coverUntil = Math.max(open, now.getTime() - 60_000);
  const fetched = await fetchOptionCandles(tickers.map((ticker) => ({
    streamer: ticker,
    fromTime: open,
    period: "1m" as const,
    coverFrom: open,
    coverUntil,
  })), { timeoutMs: 12_000, quietMs: 700, emptyWaitMs: 2_500 });
  return fetched.candles;
}

/** Price 60-minute rows from candles just stored. A and B rows are not changed. */
export async function refineStoredTimeStops(
  pairs: readonly { key: string; bars: readonly CandleBar[] }[],
  now: Date,
): Promise<void> {
  if (pairs.length === 0) return;
  const byKey = new Map<string, readonly CandleBar[]>();
  for (let i = 0; i < pairs.length; i++) byKey.set(pairs[i].key, pairs[i].bars);
  await updateShadowBook((text) => {
    const book = parseShadowBook(text);
    let changed = false;
    const records = book.records.map((row) => {
      if (row.cohort !== "time-60") return row;
      const bars = byKey.get(contractKey(row));
      if (!bars || bars.length === 0) return row;
      const next = refineTimeStop(row, bars, now, true);
      if (next !== row) changed = true;
      return next;
    });
    if (!changed) return text ?? serializeShadowBook(book);
    return serializeShadowBook({ version: 1, records, research: book.research });
  });
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

function markedTooRecently(shadow: ShadowTrade, nowMs: number): boolean {
  const marks = shadow.marks ?? [];
  let at = shadow.lastMarkedAt;
  for (let i = 0; i < marks.length; i++) {
    if (at == null || marks[i].at > at) at = marks[i].at;
  }
  return at != null && nowMs >= at && nowMs - at < MARK_REUSE_MS;
}

function countClosed(before: readonly ShadowTrade[], after: readonly ShadowTrade[]): number {
  const wasOpen = new Set<string>();
  for (let i = 0; i < before.length; i++) {
    if (before[i].status === "open") wasOpen.add(before[i].id);
  }
  let closed = 0;
  for (let i = 0; i < after.length; i++) {
    if (wasOpen.has(after[i].id) && after[i].status === "closed" && !isSideStudyShadow(after[i])) closed += 1;
  }
  return closed;
}

export { emptyShadowBook };
