import seedRows from "../../data/eod-flow-seed.json";
import { addCalendarDays } from "@/app/lib/flow";
import {
  aggregateEod,
  chunkSymbols,
  EOD_DXLINK_CHUNK,
  EOD_MAX_DTE,
  EOD_ROOTS,
  EOD_UNDERLYINGS,
  eodAcceptedRoots,
  eodContractsFromNested,
  eodCronDecision,
  eodLoadFromSchwab,
  eodReadingKey,
  eodSession,
  emptyEodBook,
  mergeEodSeed,
  parseEodBook,
  underlyingsComplete,
  upsertEodRow,
  type EodBook,
  type EodContract,
  type EodFlowRow,
  type EodReading,
  type EodRootLoad,
  type EodUnderlying,
  type EodWork,
} from "@/app/lib/eodFlow";
import type { GexRow } from "@/app/lib/gex";
import { SCAN_TIME_BUDGET_MS } from "@/app/lib/scanHealth";
import * as schwab from "@/app/lib/schwab";
import { loadGexRows } from "@/app/lib/gexJob";
import { readEodFlowText, resolveStoreKind, updateEodFlow } from "@/app/lib/schwabStore";
import { ttEodStream, ttOptionExpirations } from "@/app/lib/tastytradeMarket";

/**
 * Collects one trading day's SPY, QQQ, NDX, and VIX option volume after the close.
 * Tastytrade nested chains and DXLink Trade/Summary are primary.
 * Schwab's chain is used only when that call fails.
 * A run stops inside the scanner's time budget and leaves the rest for the next fire.
 */

const SAVE_MARGIN_MS = 15_000;
const STORE_MESSAGE = "The private store is not configured, so the end-of-day flow was not saved.";

export interface EodJobOptions {
  now?: Date;
  manual?: boolean;
  budgetMs?: number;
  nowMs?: () => number;
  /** Test seam. Production uses 4,500, under the DXLink cap. */
  chunkSize?: number;
  loadRoot?: (root: string, sessionDate: string) => Promise<EodRootLoad>;
  loadChunk?: (streamers: readonly string[], timeoutMs: number) => Promise<Record<string, EodReading>>;
  backupChunk?: (contracts: readonly EodContract[], sessionDate: string) => Promise<Record<string, EodReading>>;
}

export interface EodJobResult {
  ok: boolean;
  skipped: string | null;
  reason: string | null;
  date: string | null;
  saved: EodUnderlying[];
  pending: EodUnderlying | null;
  remainingChunks: number;
  errors: string[];
}

export interface EodPage {
  stored: boolean;
  rows: EodFlowRow[];
  gex: GexRow[];
  pending: { date: string; underlying: EodUnderlying } | null;
}

/** Checked-in history. A row that does not parse is dropped, not guessed. */
export function eodSeedRows(): EodFlowRow[] {
  const book = parseEodBook(JSON.stringify({ version: 1, rows: seedRows, work: null, lockUntil: null }));
  return book?.rows ?? [];
}

function withSeed(rows: EodFlowRow[]): EodFlowRow[] {
  return mergeEodSeed(rows, eodSeedRows());
}

export async function loadEodPage(): Promise<EodPage> {
  const gex = await loadGexRows().catch(() => [] as GexRow[]);
  if (resolveStoreKind() === "unconfigured") {
    return { stored: false, rows: withSeed([]), gex, pending: null };
  }
  const book = parseEodBook(await readEodFlowText());
  if (!book) return { stored: true, rows: [], gex, pending: null };
  return {
    stored: true,
    rows: withSeed(book.rows),
    gex,
    pending: book.work ? { date: book.work.date, underlying: book.work.underlying } : null,
  };
}

export async function runEodFlowJob(options: EodJobOptions = {}): Promise<EodJobResult> {
  const now = options.now ?? new Date();
  const manual = options.manual === true;
  const nowMs = options.nowMs ?? Date.now;
  const decision = eodCronDecision(now, manual);
  const base = emptyResult(null);
  if (!decision.run) return { ...base, ok: true, skipped: decision.reason, reason: decision.reason };
  if (resolveStoreKind() === "unconfigured") return { ...base, ok: false, reason: STORE_MESSAGE };
  const session = eodSession(now);
  if (!session) return { ...base, ok: false, reason: "The New York session date is not available." };

  const budgetMs = options.budgetMs ?? SCAN_TIME_BUDGET_MS;
  const started = nowMs();
  const deadline = started + budgetMs;
  const held: { status: "ok" | "busy" | "skip" | "unreadable"; book: EodBook | null } = { status: "ok", book: null };
  const locked = await updateEodFlow((current) => {
    const parsed = parseEodBook(current);
    if (!parsed) {
      held.status = "unreadable";
      return null;
    }
    const book = { ...parsed, rows: withSeed(parsed.rows) };
    if (book.work && book.work.date !== session.date) book.work = null;
    if (!manual && book.work == null && underlyingsComplete(book.rows, session.date)) {
      held.status = "skip";
      held.book = book;
      return JSON.stringify(book);
    }
    if (book.lockUntil != null && book.lockUntil > nowMs()) {
      held.status = "busy";
      held.book = book;
      return current ?? JSON.stringify(book);
    }
    if (manual) book.work = null;
    book.lockUntil = deadline;
    held.status = "ok";
    held.book = book;
    return JSON.stringify(book);
  });

  if (held.status === "unreadable" || !locked) {
    return { ...emptyResult(session.date), ok: false, reason: "The end-of-day flow could not be read." };
  }
  if (held.status === "skip") {
    return { ...emptyResult(session.date), ok: true, skipped: "already collected", reason: "already collected" };
  }
  if (held.status === "busy") {
    return { ...emptyResult(session.date), ok: true, skipped: "busy", reason: "busy" };
  }

  let book = held.book ?? emptyEodBook();
  const saved: EodUnderlying[] = [];
  const errors: string[] = [];
  const restarted = new Set<EodUnderlying>();
  let failed = false;
  try {
    for (let step = 0; step < 8; step++) {
      if (outOfTime(nowMs(), deadline)) break;
      if (!book.work || book.work.date !== session.date) {
        const next = pickUnderlying(book, session.date, manual, restarted);
        if (!next) break;
        restarted.add(next);
        book.work = freshWork(next, session);
      }
      const name = book.work.underlying;
      const outcome = await stepWork(book, deadline, options, errors, nowMs, now.getTime());
      if (!(await writeBook(book))) {
        errors.push("The end-of-day flow could not be saved.");
        failed = true;
        break;
      }
      if (outcome === "saved") {
        saved.push(name);
        continue;
      }
      if (outcome === "retry") failed = true;
      break;
    }
  } finally {
    book.lockUntil = null;
    if (!(await writeBook(book))) {
      errors.push("The end-of-day flow could not be saved.");
      failed = true;
    }
  }

  return {
    ok: !failed && errors.length === 0,
    skipped: null,
    reason: errors[0] ?? null,
    date: session.date,
    saved,
    pending: book.work?.underlying ?? null,
    remainingChunks: remainingChunks(book, options.chunkSize ?? EOD_DXLINK_CHUNK),
    errors,
  };
}

async function stepWork(
  book: EodBook,
  deadline: number,
  options: EodJobOptions,
  errors: string[],
  nowMs: () => number,
  collectedAt: number,
): Promise<"saved" | "partial" | "retry"> {
  const work = book.work;
  if (!work) return "saved";
  const loadRoot = options.loadRoot ?? defaultLoadRoot;
  while (work.pendingRoots.length > 0) {
    if (outOfTime(nowMs(), deadline)) return "partial";
    const root = work.pendingRoots[0];
    try {
      const loaded = await loadRoot(root, work.date);
      addContracts(work, loaded);
      work.pendingRoots.shift();
    } catch (err) {
      errors.push(`${root}: ${safeError(err)}`);
      return "retry";
    }
  }

  const chunkSize = options.chunkSize ?? EOD_DXLINK_CHUNK;
  const ids = work.contracts.filter((contract) => !contract.settled).map((contract) => contract.id);
  const chunks = chunkSymbols(ids, chunkSize);
  const loadChunk = options.loadChunk ?? defaultLoadChunk;
  const backupChunk = options.backupChunk ?? defaultBackupChunk;
  while (work.nextChunk < chunks.length) {
    if (outOfTime(nowMs(), deadline)) return "partial";
    const chunk = chunks[work.nextChunk];
    const remaining = Math.max(1_000, deadline - nowMs() - SAVE_MARGIN_MS);
    try {
      mergeReadings(work, await loadChunk(chunk, remaining));
      work.nextChunk += 1;
    } catch (err) {
      try {
        const slice = work.contracts.filter((contract) => chunk.indexOf(contract.id) !== -1);
        mergeReadings(work, await backupChunk(slice, work.date));
        work.nextChunk += 1;
      } catch (backupErr) {
        errors.push(safeError(err));
        errors.push(safeError(backupErr));
        return "retry";
      }
    }
  }

  const row = aggregateEod({
    contracts: work.contracts,
    readings: work.readings,
    underlying: work.underlying,
    session: { date: work.date, friday: work.friday, earlyClose: work.earlyClose },
    collectedAt,
  });
  book.rows = upsertEodRow(book.rows, row);
  book.work = null;
  return "saved";
}

async function defaultLoadRoot(root: string, sessionDate: string): Promise<EodRootLoad> {
  try {
    const expirations = await ttOptionExpirations(root);
    const contracts = eodContractsFromNested(expirations, sessionDate, eodAcceptedRoots(root));
    if (contracts.length > 0) return { contracts, readings: {} };
  } catch {
    // Schwab below. An empty Tastytrade chain is treated the same as a failed one.
  }
  const chain = await schwab.getOptionChain({
    symbol: root,
    contractType: "ALL",
    range: "ALL",
    fromDate: sessionDate,
    toDate: addCalendarDays(sessionDate, EOD_MAX_DTE),
  });
  return eodLoadFromSchwab(chain.contracts, sessionDate, root);
}

async function defaultLoadChunk(streamers: readonly string[], timeoutMs: number): Promise<Record<string, EodReading>> {
  const feed = await ttEodStream(streamers, { timeoutMs });
  const out: Record<string, EodReading> = {};
  feed.forEach((reading, symbol) => {
    out[symbol] = { dayVolume: reading.dayVolume, openInterest: reading.openInterest };
  });
  return out;
}

async function defaultBackupChunk(contracts: readonly EodContract[], sessionDate: string): Promise<Record<string, EodReading>> {
  const roots: string[] = [];
  for (let i = 0; i < contracts.length; i++) {
    if (roots.indexOf(contracts[i].root) === -1) roots.push(contracts[i].root);
  }
  const out: Record<string, EodReading> = {};
  for (let i = 0; i < roots.length; i++) {
    const chain = await schwab.getOptionChain({
      symbol: roots[i],
      contractType: "ALL",
      range: "ALL",
      fromDate: sessionDate,
      toDate: addCalendarDays(sessionDate, EOD_MAX_DTE),
    });
    const loaded = eodLoadFromSchwab(chain.contracts, sessionDate, roots[i]);
    for (let j = 0; j < contracts.length; j++) {
      const contract = contracts[j];
      if (contract.root !== roots[i]) continue;
      const key = eodReadingKey(contract.root, contract.expiration, contract.strike, contract.putCall);
      const reading = loaded.readings[key];
      if (reading) out[contract.id] = reading;
    }
  }
  return out;
}

function freshWork(underlying: EodUnderlying, session: { date: string; friday: boolean; earlyClose: boolean }): EodWork {
  return {
    date: session.date,
    underlying,
    friday: session.friday,
    earlyClose: session.earlyClose,
    contracts: [],
    readings: {},
    nextChunk: 0,
    pendingRoots: [...EOD_ROOTS[underlying]],
  };
}

function pickUnderlying(
  book: EodBook,
  date: string,
  manual: boolean,
  restarted: Set<EodUnderlying>,
): EodUnderlying | null {
  for (let i = 0; i < EOD_UNDERLYINGS.length; i++) {
    const name = EOD_UNDERLYINGS[i];
    if (manual) {
      if (!restarted.has(name)) return name;
      continue;
    }
    if (!book.rows.some((row) => row.date === date && row.underlying === name)) return name;
  }
  return null;
}

function addContracts(work: EodWork, loaded: EodRootLoad): void {
  const ids = new Set(work.contracts.map((contract) => contract.id));
  const logical = new Set(work.contracts.map((contract) => eodReadingKey(contract.root, contract.expiration, contract.strike, contract.putCall)));
  for (let i = 0; i < loaded.contracts.length; i++) {
    const contract = loaded.contracts[i];
    const key = eodReadingKey(contract.root, contract.expiration, contract.strike, contract.putCall);
    if (ids.has(contract.id) || logical.has(key)) continue;
    ids.add(contract.id);
    logical.add(key);
    work.contracts.push(contract);
    const reading = loaded.readings[contract.id];
    if (reading) work.readings[contract.id] = reading;
  }
}

function mergeReadings(work: EodWork, readings: Record<string, EodReading>): void {
  const ids = Object.keys(readings);
  for (let i = 0; i < ids.length; i++) {
    const next = readings[ids[i]];
    const prior = work.readings[ids[i]] ?? { dayVolume: null, openInterest: null };
    work.readings[ids[i]] = {
      dayVolume: next.dayVolume != null ? next.dayVolume : prior.dayVolume,
      openInterest: next.openInterest != null ? next.openInterest : prior.openInterest,
    };
  }
}

function remainingChunks(book: EodBook, chunkSize: number): number {
  const work = book.work;
  if (!work) return 0;
  if (work.pendingRoots.length > 0) return work.pendingRoots.length;
  const ids = work.contracts.filter((contract) => !contract.settled).map((contract) => contract.id);
  const chunks = chunkSymbols(ids, chunkSize);
  return Math.max(0, chunks.length - work.nextChunk);
}

function outOfTime(nowMs: number, deadline: number): boolean {
  return nowMs >= deadline - SAVE_MARGIN_MS;
}

async function writeBook(book: EodBook): Promise<boolean> {
  return updateEodFlow((current) => {
    if (parseEodBook(current) == null) return null;
    return JSON.stringify(book);
  });
}

function emptyResult(date: string | null): EodJobResult {
  return {
    ok: false,
    skipped: null,
    reason: null,
    date,
    saved: [],
    pending: null,
    remainingChunks: 0,
    errors: [],
  };
}

function safeError(err: unknown): string {
  const text = err instanceof Error ? err.message : "The data request failed";
  return text.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/\s+/g, " ").slice(0, 180);
}
