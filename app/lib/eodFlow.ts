import type { OptionContract, PutCall } from "@/app/lib/contract";
import { addCalendarDays, calendarDaysBetween, newYorkDate } from "@/app/lib/flow";
import { isMarketDay, isNewYorkMinuteWindow, isNyseEarlyCloseYmd } from "@/app/lib/marketHours";
import {
  parseOccSymbol,
  selectChainSymbols,
  streamerFromOcc,
  type NestedExpiration,
} from "@/app/lib/tastytradeMarketParse";

/**
 * End-of-day put/call volume and open interest for QQQ and NDX.
 * Pure math: no network and no store. A missing reading stays null.
 */

export const EOD_UNDERLYINGS = ["QQQ", "NDX"] as const;
export type EodUnderlying = (typeof EOD_UNDERLYINGS)[number];

/** NDX history includes the NDX and NDXP option roots. QQQ is one root. */
export const EOD_ROOTS: Record<EodUnderlying, readonly string[]> = {
  QQQ: ["QQQ"],
  NDX: ["NDX", "NDXP"],
};

export const EOD_MIN_DTE = 0;
export const EOD_MAX_DTE = 45;
/** 0 through 7 calendar days. 8 through 45 is the other volume bucket. */
export const EOD_NEAR_DTE = 7;

/**
 * DXLink allows 5,000 unique symbols on one connection.
 * Stay under that so a chunk cannot trip the cap.
 */
export const EOD_DXLINK_CAP = 5_000;
export const EOD_DXLINK_CHUNK = 4_500;

/** 4:20pm America/New_York, plus a few minutes for a late cron fire. */
export const EOD_CRON_START_MINUTE = 16 * 60 + 20;
export const EOD_CRON_END_MINUTE = 16 * 60 + 25;
/** Second fire, used only when the first pass still has contracts left. */
export const EOD_CONTINUE_START_MINUTE = 16 * 60 + 30;
export const EOD_CONTINUE_END_MINUTE = 16 * 60 + 35;

const ROW_CAP = 800;

export interface EodContract {
  /** Streamer symbol, or a synthetic id when the backup chain had no OCC symbol. */
  id: string;
  root: string;
  expiration: string;
  strike: number;
  putCall: PutCall;
  dte: number;
  /** True when volume and open interest already came from a backup chain. */
  settled: boolean;
}

export interface EodReading {
  dayVolume: number | null;
  openInterest: number | null;
}

export interface EodRootLoad {
  contracts: EodContract[];
  readings: Record<string, EodReading>;
}

export interface EodTopStrike {
  strike: number;
  putCall: PutCall;
  volume: number;
}

export interface EodFlowRow {
  date: string;
  underlying: EodUnderlying;
  putVolume: number | null;
  callVolume: number | null;
  putCallVolumeRatio: number | null;
  putOpenInterest: number | null;
  callOpenInterest: number | null;
  putCallOiRatio: number | null;
  putVolume0to7: number | null;
  callVolume0to7: number | null;
  putVolume8to45: number | null;
  callVolume8to45: number | null;
  topStrikes: EodTopStrike[];
  friday: boolean;
  earlyClose: boolean;
  /** Contracts with a dayVolume reading, divided by contracts in the chain, times 100. */
  volumeCoverage: number | null;
  /** Contracts with an openInterest reading, divided by contracts in the chain, times 100. */
  oiCoverage: number | null;
  contractCount: number;
  collectedAt: number | null;
}

export interface EodWork {
  date: string;
  underlying: EodUnderlying;
  friday: boolean;
  earlyClose: boolean;
  contracts: EodContract[];
  readings: Record<string, EodReading>;
  nextChunk: number;
  pendingRoots: string[];
}

export interface EodBook {
  version: 1;
  rows: EodFlowRow[];
  work: EodWork | null;
  lockUntil: number | null;
}

export interface EodSession {
  date: string;
  friday: boolean;
  earlyClose: boolean;
}

export function eodCronDecision(now: Date, manual: boolean): { run: boolean; reason: string | null } {
  if (!isMarketDay(now)) return { run: false, reason: "market holiday" };
  if (manual) return { run: true, reason: null };
  if (isNewYorkMinuteWindow(now, EOD_CRON_START_MINUTE, EOD_CRON_END_MINUTE)) return { run: true, reason: null };
  if (isNewYorkMinuteWindow(now, EOD_CONTINUE_START_MINUTE, EOD_CONTINUE_END_MINUTE)) return { run: true, reason: null };
  return { run: false, reason: "Outside the 4:20pm America/New_York end-of-day window" };
}

export function eodSession(now: Date): EodSession | null {
  const date = newYorkDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    friday: new Date(`${date}T00:00:00Z`).getUTCDay() === 5,
    earlyClose: isNyseEarlyCloseYmd(date),
  };
}

/** Roots accepted from one chain request. The NDX chain may already list NDXP. */
export function eodAcceptedRoots(root: string): string[] {
  const name = root.trim().toUpperCase();
  if (name === "NDX" || name === "NDXP") return ["NDX", "NDXP"];
  return [name];
}

/**
 * Unique symbols, original order, at most {@link EOD_DXLINK_CHUNK} per chunk.
 * A larger requested size is clamped so one connection stays under the DXLink cap.
 */
export function chunkSymbols(symbols: readonly string[], size: number = EOD_DXLINK_CHUNK): string[][] {
  const requested = Number.isFinite(size) && size >= 1 ? Math.floor(size) : EOD_DXLINK_CHUNK;
  const cap = Math.min(requested, EOD_DXLINK_CHUNK);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += cap) out.push(unique.slice(i, i + cap));
  return out;
}

/** Puts divided by calls. Null when either side is missing or calls are zero. */
export function putCallRatio(put: number | null, call: number | null): number | null {
  if (put == null || call == null) return null;
  if (!Number.isFinite(put) || !Number.isFinite(call) || !(call > 0)) return null;
  return put / call;
}

/** Known readings divided by contracts in the chain, as a percent. Null when the chain is empty. */
export function coveragePercent(known: number, total: number): number | null {
  if (!Number.isFinite(known) || !Number.isFinite(total) || !(total > 0)) return null;
  return (known / total) * 100;
}

export function eodContractsFromNested(
  expirations: readonly NestedExpiration[],
  sessionDate: string,
  allowedRoots: readonly string[],
): EodContract[] {
  const toDate = addCalendarDays(sessionDate, EOD_MAX_DTE);
  const selected = selectChainSymbols(expirations, { fromDate: sessionDate, toDate, contractType: "ALL" }, null);
  const roots = new Set(allowedRoots.map((root) => root.trim().toUpperCase()));
  const out: EodContract[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i];
    const occ = parseOccSymbol(sel.symbol);
    if (!occ || !roots.has(occ.root)) continue;
    const dte = calendarDaysBetween(sessionDate, sel.expiration);
    if (dte == null || dte < EOD_MIN_DTE || dte > EOD_MAX_DTE) continue;
    const streamer = streamerFromOcc(sel.symbol);
    if (!streamer || seen.has(streamer)) continue;
    seen.add(streamer);
    out.push({
      id: streamer,
      root: occ.root,
      expiration: sel.expiration,
      strike: sel.strike,
      putCall: sel.putCall,
      dte,
      settled: false,
    });
  }
  return out;
}

export function eodLoadFromSchwab(
  contracts: readonly OptionContract[],
  sessionDate: string,
  root: string,
): EodRootLoad {
  const name = root.trim().toUpperCase();
  const out: EodContract[] = [];
  const readings: Record<string, EodReading> = {};
  const seen = new Set<string>();
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const dte = calendarDaysBetween(sessionDate, contract.expiration);
    if (dte == null || dte < EOD_MIN_DTE || dte > EOD_MAX_DTE) continue;
    if (contract.putCall !== "put" && contract.putCall !== "call") continue;
    if (!(contract.strike > 0)) continue;
    const id = eodReadingKey(name, contract.expiration, contract.strike, contract.putCall);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      root: name,
      expiration: contract.expiration,
      strike: contract.strike,
      putCall: contract.putCall,
      dte,
      settled: true,
    });
    readings[id] = {
      dayVolume: finiteNonNegative(contract.volume),
      openInterest: finiteNonNegative(contract.openInterest),
    };
  }
  return { contracts: out, readings };
}

export function eodReadingKey(root: string, expiration: string, strike: number, putCall: string): string {
  return `${root}|${expiration}|${strike}|${putCall}`;
}

export function aggregateEod(input: {
  contracts: readonly EodContract[];
  readings: Readonly<Record<string, EodReading>>;
  underlying: EodUnderlying;
  session: EodSession;
  collectedAt: number;
}): EodFlowRow {
  const contracts = input.contracts.filter((contract) => contract.dte >= EOD_MIN_DTE && contract.dte <= EOD_MAX_DTE);
  const putVol: Array<number | null> = [];
  const callVol: Array<number | null> = [];
  const putOi: Array<number | null> = [];
  const callOi: Array<number | null> = [];
  const nearPut: Array<number | null> = [];
  const nearCall: Array<number | null> = [];
  const farPut: Array<number | null> = [];
  const farCall: Array<number | null> = [];
  let volumeKnown = 0;
  let oiKnown = 0;
  const byStrike = new Map<string, { strike: number; putCall: PutCall; volume: number; known: boolean }>();

  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const reading = input.readings[contract.id];
    const volume = finiteNonNegative(reading?.dayVolume);
    const openInterest = finiteNonNegative(reading?.openInterest);
    if (volume != null) volumeKnown += 1;
    if (openInterest != null) oiKnown += 1;
    if (contract.putCall === "put") {
      putVol.push(volume);
      putOi.push(openInterest);
      if (contract.dte <= EOD_NEAR_DTE) nearPut.push(volume);
      else farPut.push(volume);
    } else {
      callVol.push(volume);
      callOi.push(openInterest);
      if (contract.dte <= EOD_NEAR_DTE) nearCall.push(volume);
      else farCall.push(volume);
    }
    if (volume == null) continue;
    const key = `${contract.strike}|${contract.putCall}`;
    const bucket = byStrike.get(key) ?? { strike: contract.strike, putCall: contract.putCall, volume: 0, known: false };
    bucket.volume += volume;
    bucket.known = true;
    byStrike.set(key, bucket);
  }

  const putVolume = sumKnown(putVol);
  const callVolume = sumKnown(callVol);
  const putOpenInterest = sumKnown(putOi);
  const callOpenInterest = sumKnown(callOi);
  const topStrikes = Array.from(byStrike.values())
    .filter((row) => row.known)
    .sort((a, b) => b.volume - a.volume || a.strike - b.strike || (a.putCall < b.putCall ? -1 : a.putCall > b.putCall ? 1 : 0))
    .slice(0, 5)
    .map((row) => ({ strike: row.strike, putCall: row.putCall, volume: row.volume }));

  return {
    date: input.session.date,
    underlying: input.underlying,
    putVolume,
    callVolume,
    putCallVolumeRatio: putCallRatio(putVolume, callVolume),
    putOpenInterest,
    callOpenInterest,
    putCallOiRatio: putCallRatio(putOpenInterest, callOpenInterest),
    putVolume0to7: sumKnown(nearPut),
    callVolume0to7: sumKnown(nearCall),
    putVolume8to45: sumKnown(farPut),
    callVolume8to45: sumKnown(farCall),
    topStrikes,
    friday: input.session.friday,
    earlyClose: input.session.earlyClose,
    volumeCoverage: coveragePercent(volumeKnown, contracts.length),
    oiCoverage: coveragePercent(oiKnown, contracts.length),
    contractCount: contracts.length,
    collectedAt: Number.isFinite(input.collectedAt) ? input.collectedAt : null,
  };
}

/** Replace the row with the same date and underlying. Newest date first. */
export function upsertEodRow(rows: readonly EodFlowRow[], next: EodFlowRow): EodFlowRow[] {
  const kept = rows.filter((row) => !(row.date === next.date && row.underlying === next.underlying));
  kept.push(next);
  kept.sort((a, b) => b.date.localeCompare(a.date) || a.underlying.localeCompare(b.underlying));
  return kept.slice(0, ROW_CAP);
}

export function underlyingsComplete(rows: readonly EodFlowRow[], date: string): boolean {
  for (let i = 0; i < EOD_UNDERLYINGS.length; i++) {
    const name = EOD_UNDERLYINGS[i];
    if (!rows.some((row) => row.date === date && row.underlying === name)) return false;
  }
  return true;
}

export function emptyEodBook(): EodBook {
  return { version: 1, rows: [], work: null, lockUntil: null };
}

/** Null when the text is present but not a book. An empty store is an empty book. */
export function parseEodBook(text: string | null): EodBook | null {
  if (text == null || text.trim() === "") return emptyEodBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.rows)) return null;
  const rows: EodFlowRow[] = [];
  for (let i = 0; i < record.rows.length; i++) {
    const row = parseRow(record.rows[i]);
    if (row) rows.push(row);
  }
  return {
    version: 1,
    rows,
    work: parseWork(record.work),
    lockUntil: typeof record.lockUntil === "number" && Number.isFinite(record.lockUntil) ? record.lockUntil : null,
  };
}

export function formatEodCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const digits = Math.abs(value - Math.round(value)) < 1e-6 ? 0 : 2;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatEodRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatEodPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function formatTopStrikes(strikes: readonly EodTopStrike[]): string {
  if (strikes.length === 0) return "n/a";
  return strikes.map((row) => `${formatStrike(row.strike)} ${row.putCall} ${formatEodCount(row.volume)}`).join("; ");
}

export interface EodChartPoint {
  date: string;
  qqq: number | null;
  ndx: number | null;
}

/** One point per date, oldest first. A missing ratio stays null. */
export function eodRatioSeries(rows: readonly EodFlowRow[]): EodChartPoint[] {
  const dates = Array.from(new Set(rows.map((row) => row.date))).sort();
  return dates.map((date) => ({
    date,
    qqq: ratioFor(rows, date, "QQQ"),
    ndx: ratioFor(rows, date, "NDX"),
  }));
}

function ratioFor(rows: readonly EodFlowRow[], date: string, underlying: EodUnderlying): number | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.date === date && row.underlying === underlying) return row.putCallVolumeRatio;
  }
  return null;
}

function formatStrike(strike: number): string {
  if (!Number.isFinite(strike)) return "n/a";
  return strike.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function sumKnown(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let known = 0;
  for (let i = 0; i < values.length; i++) {
    const value = finiteNonNegative(values[i]);
    if (value == null) continue;
    sum += value;
    known += 1;
  }
  return known === 0 ? null : sum;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseRow(value: unknown): EodFlowRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  if (row.underlying !== "QQQ" && row.underlying !== "NDX") return null;
  const top = Array.isArray(row.topStrikes) ? row.topStrikes : [];
  const topStrikes: EodTopStrike[] = [];
  for (let i = 0; i < top.length && topStrikes.length < 5; i++) {
    const item = top[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const strike = finiteNonNegative((item as Record<string, unknown>).strike);
    const volume = finiteNonNegative((item as Record<string, unknown>).volume);
    const putCall = (item as Record<string, unknown>).putCall;
    if (strike == null || !(strike > 0) || volume == null) continue;
    if (putCall !== "put" && putCall !== "call") continue;
    topStrikes.push({ strike, putCall, volume });
  }
  return {
    date: row.date,
    underlying: row.underlying,
    putVolume: finiteNonNegative(row.putVolume),
    callVolume: finiteNonNegative(row.callVolume),
    putCallVolumeRatio: finiteNonNegative(row.putCallVolumeRatio),
    putOpenInterest: finiteNonNegative(row.putOpenInterest),
    callOpenInterest: finiteNonNegative(row.callOpenInterest),
    putCallOiRatio: finiteNonNegative(row.putCallOiRatio),
    putVolume0to7: finiteNonNegative(row.putVolume0to7),
    callVolume0to7: finiteNonNegative(row.callVolume0to7),
    putVolume8to45: finiteNonNegative(row.putVolume8to45),
    callVolume8to45: finiteNonNegative(row.callVolume8to45),
    topStrikes,
    friday: row.friday === true,
    earlyClose: row.earlyClose === true,
    volumeCoverage: finiteNonNegative(row.volumeCoverage),
    oiCoverage: finiteNonNegative(row.oiCoverage),
    contractCount: finiteNonNegative(row.contractCount) ?? 0,
    collectedAt: typeof row.collectedAt === "number" && Number.isFinite(row.collectedAt) ? row.collectedAt : null,
  };
}

function parseWork(value: unknown): EodWork | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const work = value as Record<string, unknown>;
  if (typeof work.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(work.date)) return null;
  if (work.underlying !== "QQQ" && work.underlying !== "NDX") return null;
  if (!Array.isArray(work.contracts) || !Array.isArray(work.pendingRoots)) return null;
  const contracts: EodContract[] = [];
  for (let i = 0; i < work.contracts.length; i++) {
    const contract = parseContract(work.contracts[i]);
    if (contract) contracts.push(contract);
  }
  const readings: Record<string, EodReading> = {};
  const rawReadings = work.readings;
  if (rawReadings && typeof rawReadings === "object" && !Array.isArray(rawReadings)) {
    const entries = Object.entries(rawReadings as Record<string, unknown>);
    for (let i = 0; i < entries.length; i++) {
      const reading = entries[i][1];
      if (!reading || typeof reading !== "object" || Array.isArray(reading)) continue;
      readings[entries[i][0]] = {
        dayVolume: finiteNonNegative((reading as Record<string, unknown>).dayVolume),
        openInterest: finiteNonNegative((reading as Record<string, unknown>).openInterest),
      };
    }
  }
  const pendingRoots = work.pendingRoots.filter((root): root is string => typeof root === "string" && root.length > 0);
  const nextChunk = finiteNonNegative(work.nextChunk) ?? 0;
  return {
    date: work.date,
    underlying: work.underlying,
    friday: work.friday === true,
    earlyClose: work.earlyClose === true,
    contracts,
    readings,
    nextChunk,
    pendingRoots,
  };
}

function parseContract(value: unknown): EodContract | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (typeof row.root !== "string" || typeof row.expiration !== "string") return null;
  if (row.putCall !== "put" && row.putCall !== "call") return null;
  const strike = finiteNonNegative(row.strike);
  const dte = finiteNonNegative(row.dte);
  if (strike == null || !(strike > 0) || dte == null) return null;
  return {
    id: row.id,
    root: row.root,
    expiration: row.expiration,
    strike,
    putCall: row.putCall,
    dte,
    settled: row.settled === true,
  };
}
