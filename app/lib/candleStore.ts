import { get, put } from "@vercel/blob";
import type { CandleBar } from "@/app/lib/candleTypes";
import { chicagoDate } from "@/app/lib/marketHours";
import { SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE, SCHWAB_BLOB_TOKEN_ENV } from "@/app/lib/schwabStorage";

/**
 * One private blob per contract per Chicago day, plus a small index.
 * Day files are written only when the candle count grew. The index is one
 * write per run. This path does not call head() and does not list the store.
 * A Blob 429 stops further writes.
 */

export const CANDLE_INDEX_PATH = "candles/index.json";

export interface CandleDayMeta {
  n: number;
  last: number;
  /** True after the post-close run, or for a day already in the past. */
  closed: boolean;
}

export interface CandleContractMeta {
  /** Set when a backfill session for this contract finished. */
  backfillFrom: string | null;
  ids: string[];
  days: Record<string, CandleDayMeta>;
}

export interface CandleIndex {
  version: 1;
  lastRunAt: number | null;
  errors: number;
  errorNotes: string[];
  contracts: Record<string, CandleContractMeta>;
}

export interface CandleHealth {
  candlesLastRun: string | null;
  candleAlertsCovered: number;
  candleErrors: number;
}

export interface CandleCoverage extends CandleHealth {
  note: string;
}

interface CandleBlob {
  get(pathname: string): Promise<string | null>;
  put(pathname: string, body: string): Promise<void>;
}

export interface CandleWrite {
  contractKey: string;
  ids: readonly string[];
  bars: readonly CandleBar[];
  closed: boolean;
  backfillFrom: string | null;
  /** Chicago days with no trades. Recorded on the index only, so the next run does not refetch them. */
  emptyClosedDays?: readonly string[];
}

export interface CandleCommitResult {
  daysWritten: number;
  daysSkipped: number;
  rateLimited: boolean;
}

const SERIES_CACHE = new Map<string, { stamp: string; bars: CandleBar[] }>();
let blobOverride: CandleBlob | null = null;
let rateLimitedUntil = 0;

export function emptyCandleIndex(): CandleIndex {
  return { version: 1, lastRunAt: null, errors: 0, errorNotes: [], contracts: {} };
}

export function emptyCandleHealth(): CandleHealth {
  return { candlesLastRun: null, candleAlertsCovered: 0, candleErrors: 0 };
}

export function setCandleBlobForTests(next: CandleBlob | null): void {
  blobOverride = next;
  SERIES_CACHE.clear();
  rateLimitedUntil = 0;
}

export function candleDayPath(contractKey: string, day: string): string {
  return `candles/days/${safeKey(contractKey)}/${day}.json`;
}

export function coveredAlertCount(index: CandleIndex): number {
  let count = 0;
  const keys = Object.keys(index.contracts);
  for (let i = 0; i < keys.length; i++) {
    const contract = index.contracts[keys[i]];
    if (!hasCandles(contract)) continue;
    count += Math.max(1, contract.ids.length);
  }
  return count;
}

export function candleHealthFromIndex(index: CandleIndex): CandleHealth {
  return {
    candlesLastRun: index.lastRunAt != null && Number.isFinite(index.lastRunAt)
      ? new Date(index.lastRunAt).toISOString()
      : null,
    candleAlertsCovered: coveredAlertCount(index),
    candleErrors: index.errors,
  };
}

export function scorecardCandleNote(health: CandleHealth): string {
  if (health.candleAlertsCovered === 0 && health.candlesLastRun == null) {
    return "1-minute candles are not stored yet. Exit what-ifs fall back to 15-minute marks. The results on this page are the live scorecard and stay as stored.";
  }
  const when = health.candlesLastRun ? ` Last candle run ${formatChicago(health.candlesLastRun)}.` : "";
  const errors = health.candleErrors > 0
    ? ` ${health.candleErrors} error${health.candleErrors === 1 ? "" : "s"} on that run.`
    : " No errors on that run.";
  const alerts = `${health.candleAlertsCovered} alert${health.candleAlertsCovered === 1 ? "" : "s"}`;
  return `1-minute candles cover ${alerts}.${when}${errors} What-if uses those highs and lows when a path has candles. Live exits on this page stay as stored.`;
}

export async function readCandleHealth(): Promise<CandleHealth> {
  return candleHealthFromIndex(await readCandleIndex());
}

export async function readCandleCoverage(): Promise<CandleCoverage> {
  const health = await readCandleHealth();
  return { ...health, note: scorecardCandleNote(health) };
}

export async function readCandleIndex(): Promise<CandleIndex> {
  if (Date.now() < rateLimitedUntil) return emptyCandleIndex();
  try {
    const text = await readText(CANDLE_INDEX_PATH);
    if (!text) return emptyCandleIndex();
    return parseCandleIndex(text);
  } catch (err) {
    if (isRateLimit(err)) return emptyCandleIndex();
    throw err;
  }
}

/**
 * Write changed days, then the index once. A 429 stops the rest of the puts.
 * Days already stored with the same last candle are not written again.
 */
export async function commitCandleRun(input: {
  now: number;
  errors: number;
  errorNotes: readonly string[];
  writes: readonly CandleWrite[];
}): Promise<CandleCommitResult> {
  if (Date.now() < rateLimitedUntil) {
    return { daysWritten: 0, daysSkipped: 0, rateLimited: true };
  }
  let index: CandleIndex;
  try {
    const existing = await readText(CANDLE_INDEX_PATH);
    index = existing ? parseCandleIndex(existing) : emptyCandleIndex();
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    rateLimitedUntil = Date.now() + 20_000;
    return { daysWritten: 0, daysSkipped: 0, rateLimited: true };
  }
  let daysWritten = 0;
  let daysSkipped = 0;
  let rateLimited = Date.now() < rateLimitedUntil;
  for (let i = 0; i < input.writes.length; i++) {
    const write = input.writes[i];
    const contract = ensureContract(index, write.contractKey, write.ids);
    if (write.backfillFrom && (!contract.backfillFrom || write.backfillFrom < contract.backfillFrom)) {
      contract.backfillFrom = write.backfillFrom;
    }
    const emptyDays = write.emptyClosedDays ?? [];
    for (let e = 0; e < emptyDays.length; e++) {
      const day = emptyDays[e];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || contract.days[day]) continue;
      contract.days[day] = { n: 0, last: 0, closed: true };
    }
    const grouped = groupBarsByChicagoDay(write.bars);
    const days = Array.from(grouped.keys()).sort();
    for (let d = 0; d < days.length; d++) {
      const day = days[d];
      const bars = grouped.get(day) ?? [];
      if (bars.length === 0) continue;
      const last = bars[bars.length - 1].t;
      const prior = contract.days[day];
      const closed = write.closed || day < chicagoDate(new Date(input.now));
      if (prior && prior.n === bars.length && prior.last === last && prior.closed === closed) {
        daysSkipped += 1;
        continue;
      }
      if (prior && prior.n > bars.length) {
        daysSkipped += 1;
        if (closed && !prior.closed) contract.days[day] = { ...prior, closed };
        continue;
      }
      if (rateLimited) continue;
      try {
        await writeText(candleDayPath(write.contractKey, day), serializeBars(bars));
        contract.days[day] = { n: bars.length, last, closed };
        daysWritten += 1;
      } catch (err) {
        if (isRateLimit(err)) {
          rateLimited = true;
          rateLimitedUntil = Date.now() + 20_000;
          break;
        }
        throw err;
      }
    }
    if (rateLimited) break;
  }
  index.lastRunAt = input.now;
  index.errors = input.errors;
  index.errorNotes = input.errorNotes.slice(0, 8).map((note) => note.slice(0, 180));
  if (!rateLimited) {
    try {
      const latestText = await readText(CANDLE_INDEX_PATH);
      const merged = mergeIndex(latestText ? parseCandleIndex(latestText) : emptyCandleIndex(), index);
      await writeText(CANDLE_INDEX_PATH, JSON.stringify(merged));
      SERIES_CACHE.clear();
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      rateLimited = true;
      rateLimitedUntil = Date.now() + 20_000;
    }
  }
  return { daysWritten, daysSkipped, rateLimited };
}

export async function loadCandleSeries(keys: readonly string[]): Promise<Map<string, CandleBar[]>> {
  const index = await readCandleIndex();
  const out = new Map<string, CandleBar[]>();
  const pending: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const contract = index.contracts[key];
    if (!contract || !hasCandles(contract)) continue;
    const stamp = seriesStamp(contract);
    const cached = SERIES_CACHE.get(key);
    if (cached && cached.stamp === stamp) {
      out.set(key, cached.bars);
      continue;
    }
    pending.push(key);
  }
  const loaded = await mapPool(pending, 4, async (key) => {
    const contract = index.contracts[key];
    const days = Object.keys(contract.days).sort();
    const bars: CandleBar[] = [];
    for (let i = 0; i < days.length; i++) {
      if (contract.days[days[i]].n <= 0) continue;
      const text = await readText(candleDayPath(key, days[i]));
      if (!text) continue;
      bars.push(...parseBars(text));
    }
    bars.sort((a, b) => a.t - b.t);
    SERIES_CACHE.set(key, { stamp: seriesStamp(contract), bars });
    return bars;
  });
  for (let i = 0; i < pending.length; i++) {
    if (loaded[i] && loaded[i].length > 0) out.set(pending[i], loaded[i]);
  }
  return out;
}

export function parseCandleIndex(text: string): CandleIndex {
  try {
    const parsed = JSON.parse(text) as Partial<CandleIndex>;
    const contracts: CandleIndex["contracts"] = {};
    const source = parsed.contracts;
    if (source && typeof source === "object") {
      const keys = Object.keys(source);
      for (let i = 0; i < keys.length; i++) {
        const row = source[keys[i]];
        if (!row || typeof row !== "object") continue;
        contracts[keys[i]] = {
          backfillFrom: typeof row.backfillFrom === "string" ? row.backfillFrom : null,
          ids: Array.isArray(row.ids) ? row.ids.filter((id): id is string => typeof id === "string").slice(0, 50) : [],
          days: parseDays(row.days),
        };
      }
    }
    return {
      version: 1,
      lastRunAt: typeof parsed.lastRunAt === "number" && Number.isFinite(parsed.lastRunAt) ? parsed.lastRunAt : null,
      errors: typeof parsed.errors === "number" && parsed.errors >= 0 ? Math.floor(parsed.errors) : 0,
      errorNotes: Array.isArray(parsed.errorNotes)
        ? parsed.errorNotes.filter((note): note is string => typeof note === "string").slice(0, 8)
        : [],
      contracts,
    };
  } catch {
    return emptyCandleIndex();
  }
}

export function groupBarsByChicagoDay(bars: readonly CandleBar[]): Map<string, CandleBar[]> {
  const grouped = new Map<string, CandleBar[]>();
  const ordered = bars.filter((bar) => validBar(bar)).slice().sort((a, b) => a.t - b.t);
  for (let i = 0; i < ordered.length; i++) {
    const bar = ordered[i];
    const day = chicagoDate(new Date(bar.t));
    if (!day) continue;
    const list = grouped.get(day);
    if (list) {
      const prev = list[list.length - 1];
      if (prev && prev.t === bar.t) list[list.length - 1] = bar;
      else list.push(bar);
    } else {
      grouped.set(day, [bar]);
    }
  }
  return grouped;
}

function parseDays(value: unknown): Record<string, CandleDayMeta> {
  const days: Record<string, CandleDayMeta> = {};
  if (!value || typeof value !== "object") return days;
  const source = value as Record<string, Partial<CandleDayMeta>>;
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(keys[i])) continue;
    const row = source[keys[i]];
    if (!row || typeof row.n !== "number" || typeof row.last !== "number") continue;
    days[keys[i]] = { n: row.n, last: row.last, closed: row.closed === true };
  }
  return days;
}

function ensureContract(index: CandleIndex, contractKey: string, ids: readonly string[]): CandleContractMeta {
  let contract = index.contracts[contractKey];
  if (!contract) {
    contract = { backfillFrom: null, ids: [], days: {} };
    index.contracts[contractKey] = contract;
  }
  for (let i = 0; i < ids.length; i++) {
    if (contract.ids.indexOf(ids[i]) === -1 && contract.ids.length < 50) contract.ids.push(ids[i]);
  }
  return contract;
}

function mergeIndex(fresh: CandleIndex, local: CandleIndex): CandleIndex {
  const keys = Object.keys(fresh.contracts);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const prior = fresh.contracts[key];
    const next = local.contracts[key];
    if (!next) {
      local.contracts[key] = prior;
      continue;
    }
    const dayKeys = Object.keys(prior.days);
    for (let d = 0; d < dayKeys.length; d++) {
      const day = dayKeys[d];
      const kept = next.days[day];
      const older = prior.days[day];
      if (!kept || older.n > kept.n) next.days[day] = older;
    }
    for (let n = 0; n < prior.ids.length; n++) {
      if (next.ids.indexOf(prior.ids[n]) === -1 && next.ids.length < 50) next.ids.push(prior.ids[n]);
    }
    if (prior.backfillFrom && (!next.backfillFrom || prior.backfillFrom < next.backfillFrom)) {
      next.backfillFrom = prior.backfillFrom;
    }
  }
  return local;
}

function hasCandles(contract: CandleContractMeta): boolean {
  const days = Object.keys(contract.days);
  for (let i = 0; i < days.length; i++) {
    if (contract.days[days[i]].n > 0) return true;
  }
  return false;
}

function seriesStamp(contract: CandleContractMeta): string {
  return Object.keys(contract.days).sort().map((day) => {
    const meta = contract.days[day];
    return `${day}:${meta.n}:${meta.last}`;
  }).join("|");
}

function serializeBars(bars: readonly CandleBar[]): string {
  return JSON.stringify({
    v: 1,
    bars: bars.map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c]),
  });
}

function parseBars(text: string): CandleBar[] {
  try {
    const parsed = JSON.parse(text) as { bars?: unknown };
    if (!Array.isArray(parsed.bars)) return [];
    const out: CandleBar[] = [];
    for (let i = 0; i < parsed.bars.length; i++) {
      const row = parsed.bars[i];
      if (!Array.isArray(row) || row.length < 5) continue;
      const bar = { t: row[0], o: row[1], h: row[2], l: row[3], c: row[4] };
      if (validBar(bar)) out.push(bar);
    }
    return out;
  } catch {
    return [];
  }
}

function validBar(bar: CandleBar): boolean {
  return Number.isFinite(bar.t) && bar.t > 0
    && Number.isFinite(bar.o) && bar.o > 0
    && Number.isFinite(bar.h) && bar.h > 0
    && Number.isFinite(bar.l) && bar.l > 0
    && Number.isFinite(bar.c) && bar.c > 0
    && bar.h + 1e-9 >= bar.l;
}

function safeKey(contractKey: string): string {
  const cleaned = contractKey.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 180) || "contract";
}

function formatChicago(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

async function mapPool<T>(items: readonly string[], limit: number, run: (key: string) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      if (Date.now() < rateLimitedUntil) {
        out[index] = [] as T;
        continue;
      }
      try {
        out[index] = await run(items[index]);
      } catch (err) {
        if (isRateLimit(err)) rateLimitedUntil = Date.now() + 20_000;
        out[index] = [] as T;
      }
    }
  };
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < workers; i++) jobs.push(worker());
  await Promise.all(jobs);
  return out;
}

function blobToken(): string {
  return process.env[SCHWAB_BLOB_TOKEN_ENV]?.trim() ?? "";
}

async function readText(pathname: string): Promise<string | null> {
  if (blobOverride) return blobOverride.get(pathname);
  const token = blobToken();
  if (!token) return null;
  try {
    const result = await get(pathname, { access: "private", token, useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return await new Response(result.stream).text();
  } catch (err) {
    if (isMissing(err)) return null;
    if (isRateLimit(err)) rateLimitedUntil = Date.now() + 20_000;
    throw err;
  }
}

async function writeText(pathname: string, body: string): Promise<void> {
  if (blobOverride) {
    await blobOverride.put(pathname, body);
    return;
  }
  const token = blobToken();
  if (!token) throw new Error("Blob storage is not configured");
  await put(pathname, body, {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
    contentType: "application/json",
    token,
  });
}

function isMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return /not found/i.test(message) || /\b404\b/.test(message);
}

function isRateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = typeof err === "object" && err && "status" in err ? (err as { status?: unknown }).status : null;
  return status === 429 || /\b429\b/.test(message) || /too many requests/i.test(message);
}
