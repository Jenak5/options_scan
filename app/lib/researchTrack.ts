import { OUTCOME_RULES, type LetterGrade } from "@/app/lib/alertConfig";
import type { StoredAlert } from "@/app/lib/alertBook";
import type { OptionContract } from "@/app/lib/contract";
import type { ShadowMark } from "@/app/lib/exitWhatIf";
import {
  calendarDaysBetween,
  newYorkDate,
  RESEARCH_QUOTE_CHUNK,
  RESEARCH_QUOTES_PER_RUN,
  type FlowRow,
} from "@/app/lib/flow";
import {
  isChicagoMarketHours,
  isChicagoMinuteWindow,
  isMarketDay,
  chicagoTradingDaysElapsed,
  PATH_MARK_TRADING_DAY_CAP,
} from "@/app/lib/marketHours";
import { parseSpyTrend, spyTrendFromDirection, type IndexDirection } from "@/app/lib/marketContext";
import { normalizeOptionSymbol, schwabOptionSymbol } from "@/app/lib/optionSymbol";
import {
  getQuoteEntries,
  schwabConfigured,
  SchwabConfigError,
  SchwabNotConnectedError,
} from "@/app/lib/schwab";
/** Same length as SHADOW_MARK_CAP. Kept here so this file does not import the scorecard module. */
export const RESEARCH_MARK_CAP = 220;

export interface TrackedShadow {
  quoteTrack?: boolean;
  openedAt: number;
  expiration: string;
}

/**
 * Quote paths for alerts saved after this tracking shipped.
 * A and B stay on the scorecard. C and D are research tracks only.
 * Marks are real quotes. A missed 15-minute slot is left blank.
 */

export const RESEARCH_TRACK_CAP = 400;

/** Skip a second mark when this track was quoted a few minutes ago. */
export const RESEARCH_MARK_REUSE_MS = 10 * 60 * 1000;

export interface ResearchTrack {
  id: string;
  /** ticker|expiration|strike|putCall, the same key as a flow row id. */
  contractKey: string;
  /** Alert-book id when a saved C or D opened this track. Null when it was not an alert. */
  alertId: string | null;
  openedAt: number;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  grade: LetterGrade;
  entryPrice: number;
  /** Underlying price at entry. Null when the scan did not have one. */
  entryUnderlying: number | null;
  /** SPY versus its session VWAP at entry. See SPY_TREND_NOTE. */
  spyTrend: IndexDirection;
  marks: ShadowMark[];
}

export interface ResearchCandidate {
  row: FlowRow;
  grade: LetterGrade;
}

export interface TrackedAlertCounts {
  trackedAlertsTotal: number;
  trackedAlertsActive: number;
  trackedAlertsComplete: number;
}

const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const GRADES: LetterGrade[] = ["A", "B", "C", "D"];

/**
 * True during the Central regular session and the 15:00–15:20 close window.
 * Weekends and full-day NYSE holidays are excluded. A manual flag does not override that.
 */
export function researchSessionOpen(now: Date): boolean {
  if (!isMarketDay(now)) return false;
  if (isChicagoMarketHours(now)) return true;
  const start = OUTCOME_RULES.closeCheckpointMinutes;
  return isChicagoMinuteWindow(now, start, start + OUTCOME_RULES.closeWindowMinutes);
}

/** Finished the 7 Chicago trading-day window. Expiration before that is not this count. */
export function trackWindowComplete(openedAt: number, now: Date): boolean {
  return chicagoTradingDaysElapsed(new Date(openedAt), now) >= PATH_MARK_TRADING_DAY_CAP;
}

/** Still inside 7 trading days and not past expiration. */
export function trackWindowOpen(openedAt: number, expiration: string, now: Date): boolean {
  if (trackWindowComplete(openedAt, now)) return false;
  const dte = calendarDaysBetween(newYorkDate(now), expiration);
  if (dte != null && dte < 0) return false;
  return true;
}

export function countTrackedAlerts(
  shadows: readonly TrackedShadow[],
  research: readonly ResearchTrack[],
  now: Date,
): TrackedAlertCounts {
  let trackedAlertsTotal = 0;
  let trackedAlertsActive = 0;
  let trackedAlertsComplete = 0;
  const add = (openedAt: number, expiration: string) => {
    trackedAlertsTotal += 1;
    if (trackWindowComplete(openedAt, now)) trackedAlertsComplete += 1;
    else if (trackWindowOpen(openedAt, expiration, now)) trackedAlertsActive += 1;
  };
  for (let i = 0; i < shadows.length; i++) {
    const row = shadows[i];
    if (row.quoteTrack !== true) continue;
    add(row.openedAt, row.expiration);
  }
  for (let i = 0; i < research.length; i++) add(research[i].openedAt, research[i].expiration);
  return { trackedAlertsTotal, trackedAlertsActive, trackedAlertsComplete };
}

export function researchFromRow(row: FlowRow, grade: LetterGrade, now: Date): ResearchTrack | null {
  if (grade !== "C" && grade !== "D") return null;
  if (!Number.isFinite(row.ask) || !(row.ask > 0)) return null;
  return buildTrack({
    id: `${now.getTime()}-${row.id}`,
    contractKey: row.id,
    alertId: null,
    openedAt: now.getTime(),
    ticker: row.ticker,
    putCall: row.putCall,
    strike: row.strike,
    expiration: row.expiration,
    grade,
    entryPrice: row.ask,
    entryUnderlying: positiveOrNull(row.underlyingPrice),
    spyTrend: spyTrendFromDirection(row.context?.spyDirection),
    marks: [],
  });
}

/** A saved C or D. A and B stay on the scorecard shadow instead of a second row. */
export function researchFromAlert(alert: StoredAlert): ResearchTrack | null {
  if (alert.trackQuotes !== true) return null;
  if (alert.grade !== "C" && alert.grade !== "D") return null;
  if (!Number.isFinite(alert.ask) || !(alert.ask > 0)) return null;
  return buildTrack({
    id: alert.id,
    contractKey: alert.contractKey,
    alertId: alert.id,
    openedAt: alert.sentAt,
    ticker: alert.ticker,
    putCall: alert.putCall,
    strike: alert.strike,
    expiration: alert.expiration,
    grade: alert.grade,
    entryPrice: alert.ask,
    entryUnderlying: positiveOrNull(alert.underlyingPrice),
    spyTrend: spyTrendFromDirection(alert.features?.spyDirection),
    marks: [],
  });
}

/**
 * Open a research track for each new C or D.
 * An alert saved before trackQuotes existed is left out. Prices are not filled in later.
 * A contract that already has an open window is not opened again.
 */
export function addResearchTracks(
  existing: readonly ResearchTrack[],
  candidates: readonly ResearchCandidate[],
  alerts: readonly StoredAlert[],
  now: Date,
): { tracks: ResearchTrack[]; opened: number } {
  const tracks = existing.slice();
  const active = new Set<string>();
  for (let i = 0; i < tracks.length; i++) {
    const row = tracks[i];
    if (trackWindowOpen(row.openedAt, row.expiration, now)) active.add(row.contractKey);
  }
  let opened = 0;
  const consider = (track: ResearchTrack | null) => {
    if (!track) return;
    if (active.has(track.contractKey)) return;
    active.add(track.contractKey);
    tracks.push(track);
    opened += 1;
  };
  for (let i = 0; i < alerts.length; i++) consider(researchFromAlert(alerts[i]));
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    if (item.grade !== "C" && item.grade !== "D") continue;
    consider(researchFromRow(item.row, item.grade, now));
  }
  return { tracks: trimResearch(tracks, now), opened };
}

export function selectResearchMarks(
  tracks: readonly ResearchTrack[],
  now: Date,
  limit: number = RESEARCH_QUOTES_PER_RUN,
): { due: ResearchTrack[]; skipped: number } {
  const nowMs = now.getTime();
  const eligible = tracks.filter((row) => {
    if (!trackWindowOpen(row.openedAt, row.expiration, now)) return false;
    if (!schwabOptionSymbol(row)) return false;
    return !markedTooRecently(row, nowMs);
  }).slice().sort(byResearchAge);
  const cap = Math.max(0, limit);
  return { due: eligible.slice(0, cap), skipped: Math.max(0, eligible.length - cap) };
}

export function appendResearchMark(row: ResearchTrack, quote: { mid: number | null; bid: number | null } | null, now: Date): ResearchTrack {
  const price = markPrice(quote);
  if (price == null) return row;
  const marks = appendMark(row.marks, { at: now.getTime(), price });
  if (marks.length === row.marks.length) return row;
  return { ...row, marks };
}

export function applyResearchRowQuotes(
  tracks: readonly ResearchTrack[],
  quotes: ReadonlyMap<string, { mid: number | null; bid: number | null }>,
  now: Date,
): { tracks: ResearchTrack[]; marked: number } {
  const nowMs = now.getTime();
  let marked = 0;
  const next = tracks.map((row) => {
    if (!trackWindowOpen(row.openedAt, row.expiration, now)) return row;
    if (markedTooRecently(row, nowMs)) return row;
    const quote = quotes.get(row.contractKey);
    if (!quote) return row;
    const updated = appendResearchMark(row, quote, now);
    if (updated === row) return row;
    marked += 1;
    return updated;
  });
  return { tracks: next, marked };
}

/**
 * One quotes read per chunk. The access token stays on the Schwab client's cache,
 * so a chunk does not add a token-blob read of its own.
 * A missing quote is left unmarked. Nothing here invents a price.
 */
export async function quoteResearchSymbols(
  tracks: readonly ResearchTrack[],
): Promise<Map<string, { mid: number | null; bid: number | null }>> {
  const quotes = new Map<string, { mid: number | null; bid: number | null }>();
  if (!schwabConfigured() || tracks.length === 0) return quotes;
  const groups: Array<{ symbol: string; ids: string[] }> = [];
  const index = new Map<string, { symbol: string; ids: string[] }>();
  for (let i = 0; i < tracks.length; i++) {
    const row = tracks[i];
    const symbol = schwabOptionSymbol(row);
    if (!symbol) continue;
    const key = normalizeOptionSymbol(symbol);
    const existing = index.get(key);
    if (existing) {
      existing.ids.push(row.id);
      continue;
    }
    const group = { symbol, ids: [row.id] };
    index.set(key, group);
    groups.push(group);
  }
  const byId = new Map<string, ResearchTrack>();
  for (let i = 0; i < tracks.length; i++) byId.set(tracks[i].id, tracks[i]);

  for (let i = 0; i < groups.length; i += RESEARCH_QUOTE_CHUNK) {
    const batch = groups.slice(i, i + RESEARCH_QUOTE_CHUNK);
    const symbols: string[] = [];
    for (let j = 0; j < batch.length; j++) symbols.push(batch[j].symbol);
    let entries: { symbol: string; contract: OptionContract }[];
    try {
      const read = await getQuoteEntries(symbols);
      entries = read.entries;
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      console.info("Research marks: quote request failed. Unmarked contracts stay unmarked.");
      break;
    }
    const claimed = new Set<string>();
    for (let j = 0; j < entries.length; j++) {
      const key = normalizeOptionSymbol(entries[j].symbol);
      claimed.add(key);
      const group = index.get(key);
      if (!group) continue;
      const quote = quoteFromContract(entries[j].contract);
      if (!quote) continue;
      for (let k = 0; k < group.ids.length; k++) {
        const track = byId.get(group.ids[k]);
        if (track) quotes.set(track.contractKey, quote);
      }
    }
  }
  return quotes;
}

export function parseResearchTracks(value: unknown): ResearchTrack[] {
  if (!Array.isArray(value)) return [];
  const tracks: ResearchTrack[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const row = parseResearchTrack(value[i]);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    tracks.push(row);
  }
  return tracks;
}

export function mergeResearchTracks(latest: readonly ResearchTrack[], edited: readonly ResearchTrack[]): ResearchTrack[] {
  const byId = new Map<string, ResearchTrack>();
  for (let i = 0; i < latest.length; i++) byId.set(latest[i].id, latest[i]);
  for (let i = 0; i < edited.length; i++) {
    const row = edited[i];
    const prior = byId.get(row.id);
    if (!prior) {
      byId.set(row.id, row);
      continue;
    }
    const marks = longerPath(prior.marks, row.marks);
    byId.set(row.id, marks ? { ...prior, marks } : prior);
  }
  return Array.from(byId.values());
}

function buildTrack(row: ResearchTrack): ResearchTrack | null {
  if (!ID_PATTERN.test(row.id)) return null;
  if (!TICKER_PATTERN.test(row.ticker.trim().toUpperCase())) return null;
  if (!DATE_PATTERN.test(row.expiration)) return null;
  if (!(row.entryPrice > 0) || !Number.isFinite(row.entryPrice)) return null;
  return {
    ...row,
    ticker: row.ticker.trim().toUpperCase(),
    entryUnderlying: positiveOrNull(row.entryUnderlying),
    spyTrend: spyTrendFromDirection(row.spyTrend),
    marks: [],
  };
}

function trimResearch(tracks: ResearchTrack[], now: Date): ResearchTrack[] {
  if (tracks.length <= RESEARCH_TRACK_CAP) return tracks;
  const drop = new Set<string>();
  let extra = tracks.length - RESEARCH_TRACK_CAP;
  const finished = tracks.filter((row) => !trackWindowOpen(row.openedAt, row.expiration, now))
    .slice()
    .sort((a, b) => a.openedAt - b.openedAt);
  for (let i = 0; i < finished.length && extra > 0; i++) {
    drop.add(finished[i].id);
    extra -= 1;
  }
  if (extra > 0) {
    const rest = tracks.filter((row) => !drop.has(row.id)).slice().sort((a, b) => a.openedAt - b.openedAt);
    for (let i = 0; i < rest.length && extra > 0; i++) {
      drop.add(rest[i].id);
      extra -= 1;
    }
  }
  if (drop.size > 0) {
    console.info(`Research tracks dropped ${drop.size} oldest rows to stay within ${RESEARCH_TRACK_CAP}.`);
  }
  return tracks.filter((row) => !drop.has(row.id));
}

function byResearchAge(a: ResearchTrack, b: ResearchTrack): number {
  const age = latestMarkAt(a) - latestMarkAt(b);
  if (age !== 0) return age;
  if (a.openedAt !== b.openedAt) return a.openedAt - b.openedAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function latestMarkAt(row: ResearchTrack): number {
  let latest = 0;
  for (let i = 0; i < row.marks.length; i++) {
    if (row.marks[i].at > latest) latest = row.marks[i].at;
  }
  return latest;
}

function markedTooRecently(row: ResearchTrack, nowMs: number): boolean {
  const at = latestMarkAt(row);
  return at > 0 && nowMs >= at && nowMs - at < RESEARCH_MARK_REUSE_MS;
}

function appendMark(marks: readonly ShadowMark[], mark: ShadowMark): ShadowMark[] {
  const list = marks.filter((item) => Number.isFinite(item.at) && item.price > 0);
  const last = list[list.length - 1];
  if (last && last.at === mark.at && last.price === mark.price) return list;
  list.push(mark);
  return list.slice(-RESEARCH_MARK_CAP);
}

function longerPath(prior: readonly ShadowMark[], edited: readonly ShadowMark[]): ShadowMark[] | null {
  if (edited.length <= prior.length) return null;
  for (let i = 0; i < prior.length; i++) {
    if (prior[i].at !== edited[i].at || prior[i].price !== edited[i].price) return null;
  }
  return edited.slice();
}

function markPrice(quote: { mid: number | null; bid: number | null } | null): number | null {
  if (!quote) return null;
  if (quote.mid != null && Number.isFinite(quote.mid) && quote.mid > 0) return quote.mid;
  if (quote.bid != null && Number.isFinite(quote.bid) && quote.bid > 0) return quote.bid;
  return null;
}

function quoteFromContract(contract: OptionContract): { mid: number | null; bid: number | null } | null {
  const bid = positiveOrNull(contract.bid);
  const ask = positiveOrNull(contract.ask);
  const mid = bid != null && ask != null && ask >= bid ? Math.round(((bid + ask) / 2) * 10000) / 10000 : null;
  if (mid == null && bid == null) return null;
  return { mid, bid };
}

function positiveOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || !(value > 0) || value > 100_000) return null;
  return value;
}

function parseResearchTrack(value: unknown): ResearchTrack | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!ID_PATTERN.test(id)) return null;
  const contractKey = typeof row.contractKey === "string" ? row.contractKey.trim() : "";
  if (!contractKey || contractKey.length > 120) return null;
  const alertId = row.alertId == null ? null : typeof row.alertId === "string" ? row.alertId.trim() : "";
  if (alertId === "") return null;
  const openedAt = typeof row.openedAt === "number" && Number.isFinite(row.openedAt) ? row.openedAt : null;
  if (openedAt == null || openedAt < 1_500_000_000_000 || openedAt > 2_200_000_000_000) return null;
  const ticker = typeof row.ticker === "string" ? row.ticker.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) return null;
  const putCall = row.putCall === "put" ? "put" : row.putCall === "call" ? "call" : null;
  if (!putCall) return null;
  const strike = positiveOrNull(typeof row.strike === "number" ? row.strike : null);
  if (strike == null) return null;
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  if (!DATE_PATTERN.test(expiration)) return null;
  const grade = GRADES.indexOf(row.grade as LetterGrade) >= 0 ? row.grade as LetterGrade : null;
  if (!grade) return null;
  const entryPrice = positiveOrNull(typeof row.entryPrice === "number" ? row.entryPrice : null);
  if (entryPrice == null) return null;
  const spyTrend = parseSpyTrend(row.spyTrend) ?? "unknown";
  return {
    id,
    contractKey,
    alertId,
    openedAt,
    ticker,
    putCall,
    strike,
    expiration,
    grade,
    entryPrice,
    entryUnderlying: row.entryUnderlying == null ? null : positiveOrNull(typeof row.entryUnderlying === "number" ? row.entryUnderlying : null),
    spyTrend,
    marks: parseMarks(row.marks),
  };
}

function parseMarks(value: unknown): ShadowMark[] {
  if (!Array.isArray(value)) return [];
  const marks: ShadowMark[] = [];
  for (let i = 0; i < value.length && marks.length < RESEARCH_MARK_CAP; i++) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    const item = row as { at?: unknown; price?: unknown };
    if (typeof item.at !== "number" || !Number.isFinite(item.at)) continue;
    if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price <= 0) continue;
    marks.push({ at: item.at, price: item.price });
  }
  return marks.slice(-RESEARCH_MARK_CAP);
}
