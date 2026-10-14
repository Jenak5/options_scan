import { parseAlertBook, type StoredAlert } from "@/app/lib/alertBook";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  backfillAlertsPaced,
  DAILY_LOOKBACK_DAYS,
  NOT_RECOVERABLE,
  parseEarningsReports,
  parseExpectedEarnings,
  spyTrendAt,
  type BackfillCounts,
  type EarningsHistory,
  type UnderlyingHistory,
} from "@/app/lib/featureBackfill";
import type { IndexDirection } from "@/app/lib/marketContext";
import { parseShadowBook, serializeShadowBook } from "@/app/lib/shadow";
import { readAlertBookText, readShadowBookText, updateAlertBook, updateShadowBook } from "@/app/lib/schwabStore";
import {
  fetchOptionCandles,
  openCandleAccess,
  tastytradeGetJson,
  type CandleAccess,
  type CandleSubscription,
} from "@/app/lib/tastytradeCandles";

/**
 * Network and storage side of the feature backfill.
 * Dry run by default: reads the alert book and the shadow book, fetches Tastytrade history, and
 * returns the counts it would fill. Apply writes the alert book and the shadow book.
 * Read-only toward Tastytrade. No order endpoint is called.
 */

const DAY_MS = 86_400_000;

export interface FeatureBackfillResult {
  dryRun: boolean;
  saved: boolean;
  counts: BackfillCounts | null;
  shadowSpyTrendFilled: number;
  researchSpyTrendFilled: number;
  tickers: string[];
  tickersWithoutHistory: string[];
  earningsUnavailable: string[];
  notRecoverable: Readonly<Record<string, string>>;
  errors: string[];
  /** True when the run hit the time cap and returned what it had. Nothing is written after a cap hit. */
  partial: boolean;
  /** The step that was still running when the cap hit. Null when the run finished. */
  stoppedAt: string | null;
  /** Each step with its duration, in order. Also written to the function log. */
  trace: BackfillStep[];
  /** Bars Tastytrade returned per ticker. Zero means that ticker could not be filled. */
  barCounts: Record<string, { intraday: number; daily: number }>;
  /** True when ?skipResearch=1 left the C/D research paths alone. */
  skippedResearch: boolean;
}

/** Entries handled between pauses, so the cap timer and the runtime get a turn. */
export const ENTRIES_PER_PAUSE = 25;

export function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * SPY trend at each entry time, computed in small slices with a pause between them.
 * Keyed by entry time. Unknown results are left out.
 */
export async function spyTrendsByTime(
  spy: UnderlyingHistory | undefined,
  times: readonly number[],
  now: Date,
): Promise<Map<number, IndexDirection>> {
  const out = new Map<number, IndexDirection>();
  if (!spy) return out;
  for (let i = 0; i < times.length; i++) {
    if (i > 0 && i % ENTRIES_PER_PAUSE === 0) await pause();
    const at = times[i];
    if (out.has(at)) continue;
    const trend = spyTrendAt(spy, at, now);
    if (trend !== "unknown") out.set(at, trend);
  }
  return out;
}

export interface BackfillStep {
  step: string;
  ms: number;
  ok: boolean;
  note?: string;
}

/** Leave headroom under the route's 300 s maxDuration so the JSON always goes out. */
export const BACKFILL_TIME_CAP_MS = 200_000;

class BackfillDeadline extends Error {
  readonly step: string;

  constructor(step: string) {
    super(`Stopped at ${step}: the ${BACKFILL_TIME_CAP_MS / 1000} s cap was reached`);
    this.step = step;
  }
}

/** Runs each awaited step against one deadline, and logs how long it took. */
export function makeStepper(trace: BackfillStep[], deadline: number, log: (line: string) => void = console.log) {
  return async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const remaining = deadline - started;
    if (remaining <= 0) {
      trace.push({ step: name, ms: 0, ok: false, note: "not started: time cap reached" });
      log(`[feature-backfill] ${name} skipped: time cap reached`);
      throw new BackfillDeadline(name);
    }
    log(`[feature-backfill] ${name} start (${Math.round(remaining / 1000)} s left)`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cap = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BackfillDeadline(name)), remaining);
    });
    try {
      const value = await Promise.race([work(), cap]);
      const ms = Date.now() - started;
      trace.push({ step: name, ms, ok: true });
      log(`[feature-backfill] ${name} done in ${ms} ms`);
      return value;
    } catch (err) {
      const ms = Date.now() - started;
      const note = err instanceof Error ? err.message.slice(0, 160) : "failed";
      trace.push({ step: name, ms, ok: false, note });
      log(`[feature-backfill] ${name} failed after ${ms} ms: ${note}`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export async function runFeatureBackfill(input: {
  apply: boolean;
  now: Date;
  tickers?: readonly string[] | null;
  capMs?: number;
  skipResearch?: boolean;
}): Promise<FeatureBackfillResult> {
  const now = input.now;
  const trace: BackfillStep[] = [];
  const step = makeStepper(trace, Date.now() + (input.capMs ?? BACKFILL_TIME_CAP_MS));
  const result: FeatureBackfillResult = {
    dryRun: !input.apply,
    saved: false,
    counts: null,
    shadowSpyTrendFilled: 0,
    researchSpyTrendFilled: 0,
    tickers: [],
    tickersWithoutHistory: [],
    earningsUnavailable: [],
    notRecoverable: NOT_RECOVERABLE,
    errors: [],
    partial: false,
    stoppedAt: null,
    trace,
    barCounts: {},
    skippedResearch: input.skipResearch === true,
  };
  try {
    return await runSteps(input, now, result, step);
  } catch (err) {
    if (err instanceof BackfillDeadline) {
      result.partial = true;
      result.stoppedAt = err.step;
      result.saved = false;
      result.errors.push(err.message);
      return result;
    }
    result.errors.push(err instanceof Error ? err.message.slice(0, 200) : "Backfill failed");
    return result;
  }
}

async function runSteps(
  input: { apply: boolean; tickers?: readonly string[] | null; skipResearch?: boolean },
  now: Date,
  result: FeatureBackfillResult,
  step: ReturnType<typeof makeStepper>,
): Promise<FeatureBackfillResult> {
  const book = parseAlertBook(await step("read alert book", () => readAlertBookText()));
  const shadows = parseShadowBook(await step("read shadow book", () => readShadowBookText()));
  const only = input.tickers && input.tickers.length > 0 ? new Set(input.tickers) : null;
  const alerts = only ? book.records.filter((alert) => only.has(alert.ticker)) : book.records;
  const latest = new Map<string, number>();
  const earliest = new Map<string, number>();
  const note = (ticker: string, at: number) => {
    const prior = earliest.get(ticker);
    if (prior == null || at < prior) earliest.set(ticker, at);
    const last = latest.get(ticker);
    if (last == null || at > last) latest.set(ticker, at);
  };
  for (let i = 0; i < alerts.length; i++) note(alerts[i].ticker, alerts[i].sentAt);
  let first = Infinity;
  for (let i = 0; i < alerts.length; i++) first = Math.min(first, alerts[i].sentAt);
  for (let i = 0; i < shadows.records.length; i++) first = Math.min(first, shadows.records[i].openedAt);
  const research = input.skipResearch ? [] : shadows.research ?? [];
  for (let i = 0; i < research.length; i++) first = Math.min(first, research[i].openedAt);
  let last = -Infinity;
  for (let i = 0; i < alerts.length; i++) last = Math.max(last, alerts[i].sentAt);
  for (let i = 0; i < shadows.records.length; i++) last = Math.max(last, shadows.records[i].openedAt);
  for (let i = 0; i < research.length; i++) last = Math.max(last, research[i].openedAt);
  if (Number.isFinite(first)) {
    for (const index of ["SPY", "QQQ"]) {
      note(index, first);
      note(index, last);
    }
  }
  result.tickers = Array.from(earliest.keys()).sort();
  if (result.tickers.length === 0) return result;

  const opened = await step("tastytrade oauth", () => openCandleAccess());
  if (!opened.access) {
    result.errors.push(opened.errorSample);
    return result;
  }
  const access = opened.access;
  const history = await step("dxlink candles", () => fetchHistory(access, earliest, latest, result.errors));
  history.forEach((row, ticker) => {
    result.barCounts[ticker] = { intraday: row.intraday.length, daily: row.daily.length };
  });
  for (let i = 0; i < result.tickers.length; i++) {
    const ticker = result.tickers[i];
    const row = history.get(ticker);
    if (!row || row.intraday.length === 0 || row.daily.length === 0) result.tickersWithoutHistory.push(ticker);
  }
  const alertTickers = Array.from(new Set(alerts.map((alert) => alert.ticker))).sort();
  const earnings = await step("earnings", () => fetchEarnings(access, alertTickers));
  earnings.forEach((value, ticker) => {
    if (value == null) result.earningsUnavailable.push(ticker);
  });

  const filled = await step("compute alerts", () => backfillAlertsPaced(alerts, { history, earnings, now }));
  result.counts = filled.counts;
  const changedById = new Map<string, StoredAlert>();
  for (let i = 0; i < filled.alerts.length; i++) {
    if (filled.alerts[i] !== alerts[i]) changedById.set(filled.alerts[i].id, filled.alerts[i]);
  }

  const spy = history.get("SPY");
  const entryTimes: number[] = [];
  for (let i = 0; i < shadows.records.length; i++) {
    const row = shadows.records[i];
    if (row.quoteTrack === true && (row.spyTrend == null || row.spyTrend === "unknown")) entryTimes.push(row.openedAt);
  }
  for (let i = 0; i < research.length; i++) {
    if (research[i].spyTrend === "unknown") entryTimes.push(research[i].openedAt);
  }
  const trends = await step("compute spy trend", () => spyTrendsByTime(spy, entryTimes, now));
  const skipResearch = input.skipResearch === true;
  const shadowPlan = planShadowFills(shadows, changedById, trends, skipResearch);
  result.shadowSpyTrendFilled = shadowPlan.shadowSpy;
  result.researchSpyTrendFilled = shadowPlan.researchSpy;
  if (!input.apply) return result;

  const alertSaved = changedById.size === 0 ? true : await step("write alert book", () => updateAlertBook((current) => {
    const latest = parseAlertBook(current);
    return JSON.stringify({
      ...latest,
      records: latest.records.map((alert) => mergeFilled(alert, changedById.get(alert.id))),
    });
  }));
  const shadowSaved = await step("write shadow book", () => updateShadowBook((current) => {
    const latest = parseShadowBook(current);
    return serializeShadowBook(planShadowFills(latest, changedById, trends, skipResearch).book);
  }));
  result.saved = alertSaved && shadowSaved;
  if (!alertSaved) result.errors.push("The alert book write failed.");
  if (!shadowSaved) result.errors.push("The shadow book write failed.");
  return result;
}

/** Keep the latest stored alert and swap in only the filled features, in case a scan wrote meanwhile. */
function mergeFilled(latest: StoredAlert, filled: StoredAlert | undefined): StoredAlert {
  if (!filled || !filled.features) return latest;
  if (latest.features?.capturedAtAlert && !filled.features.capturedAtAlert) return latest;
  return { ...latest, features: filled.features };
}

function planShadowFills(
  shadows: ReturnType<typeof parseShadowBook>,
  changedById: ReadonlyMap<string, StoredAlert>,
  trends: ReadonlyMap<number, IndexDirection>,
  skipResearch: boolean,
): { book: ReturnType<typeof parseShadowBook>; shadowSpy: number; researchSpy: number } {
  let shadowSpy = 0;
  let researchSpy = 0;
  const records = shadows.records.map((row) => {
    let next = row;
    const alert = changedById.get(row.alertId);
    // A shadow keeps its own copy of the features. Copy the filled snapshot so Learning reads it.
    if (alert?.features?.backfilled && (!row.features?.capturedAtAlert || alert.features.capturedAtAlert)) {
      next = { ...next, features: alert.features };
    }
    if (next.quoteTrack === true && (next.spyTrend == null || next.spyTrend === "unknown")) {
      const trend = trends.get(next.openedAt);
      if (trend) {
        next = { ...next, spyTrend: trend, spyTrendSource: "backfill" };
        shadowSpy += 1;
      }
    }
    return next;
  });
  const research = (shadows.research ?? []).map((track) => {
    if (skipResearch || track.spyTrend !== "unknown") return track;
    const trend = trends.get(track.openedAt);
    if (!trend) return track;
    researchSpy += 1;
    return { ...track, spyTrend: trend, spyTrendSource: "backfill" as const };
  });
  return { book: { ...shadows, records, research: shadows.research ? research : undefined }, shadowSpy, researchSpy };
}

async function fetchHistory(
  access: CandleAccess,
  earliest: ReadonlyMap<string, number>,
  latest: ReadonlyMap<string, number>,
  errors: string[],
): Promise<Map<string, UnderlyingHistory>> {
  const intradaySubs: CandleSubscription[] = [];
  const dailySubs: CandleSubscription[] = [];
  earliest.forEach((at, ticker) => {
    const day = Math.floor(at / DAY_MS) * DAY_MS;
    const end = latest.get(ticker) ?? at;
    intradaySubs.push({ streamer: ticker, fromTime: day - DAY_MS, period: "5m", ...intradayCover(at, end) });
    dailySubs.push({ streamer: ticker, fromTime: day - DAILY_LOOKBACK_DAYS * DAY_MS, period: "1d", ...dailyCover(at, end) });
  });
  const [intraday, daily] = await Promise.all([
    fetchOptionCandles(intradaySubs, { access, timeoutMs: 45_000, quietMs: 3000 }),
    fetchOptionCandles(dailySubs, { access, timeoutMs: 30_000, quietMs: 3000 }),
  ]);
  for (let i = 0; i < intraday.errors.length; i++) errors.push(`5m: ${intraday.errors[i]}`);
  for (let i = 0; i < daily.errors.length; i++) errors.push(`daily: ${daily.errors[i]}`);
  const out = new Map<string, UnderlyingHistory>();
  earliest.forEach((_at, ticker) => {
    out.set(ticker, {
      intraday: intraday.candles.get(ticker) ?? ([] as CandleBar[]),
      daily: daily.candles.get(ticker) ?? ([] as CandleBar[]),
    });
  });
  return out;
}

async function fetchEarnings(access: CandleAccess, tickers: readonly string[]): Promise<Map<string, EarningsHistory | null>> {
  const out = new Map<string, EarningsHistory | null>();
  if (tickers.length === 0) return out;
  const metrics = await tastytradeGetJson(access, `/market-metrics?symbols=${encodeURIComponent(tickers.join(","))}`);
  const expected = metrics ? parseExpectedEarnings(metrics) : null;
  await Promise.all(tickers.map(async (ticker) => {
    const payload = await tastytradeGetJson(
      access,
      `/market-metrics/historic-corporate-events/earnings-reports/${encodeURIComponent(ticker)}?start-date=2025-01-01`,
    );
    if (payload == null || expected == null) {
      out.set(ticker, null);
      return;
    }
    out.set(ticker, { reported: parseEarningsReports(payload), nextExpected: expected.get(ticker) ?? null });
  }));
  return out;
}

/** The 5-minute range the alerts need: a closed bar before the first send and one before the last. */
export function intradayCover(first: number, last: number): { coverFrom: number; coverUntil: number } {
  return { coverFrom: first - 5 * 60_000, coverUntil: last - 15 * 60_000 };
}

/** The daily range: 30 calendar days before the first alert, and a bar within 4 days of the last. */
export function dailyCover(first: number, last: number): { coverFrom: number; coverUntil: number } {
  return { coverFrom: first - 30 * DAY_MS, coverUntil: last - 4 * DAY_MS };
}

/** ?tickers=AAPL,NVDA to upper-case symbols. Empty or invalid means every ticker. */
export function parseTickerParam(value: string | null): string[] | null {
  if (!value) return null;
  const out: string[] = [];
  const parts = value.split(",");
  for (let i = 0; i < parts.length && out.length < 40; i++) {
    const ticker = parts[i].trim().toUpperCase();
    if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker) && out.indexOf(ticker) === -1) out.push(ticker);
  }
  return out.length > 0 ? out : null;
}
