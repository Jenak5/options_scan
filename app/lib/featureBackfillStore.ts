import { parseAlertBook, type StoredAlert } from "@/app/lib/alertBook";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  backfillAlerts,
  DAILY_LOOKBACK_DAYS,
  NOT_RECOVERABLE,
  parseEarningsReports,
  parseExpectedEarnings,
  spyTrendAt,
  type BackfillCounts,
  type EarningsHistory,
  type UnderlyingHistory,
} from "@/app/lib/featureBackfill";
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
}

export async function runFeatureBackfill(input: { apply: boolean; now: Date }): Promise<FeatureBackfillResult> {
  const now = input.now;
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
  };
  const book = parseAlertBook(await readAlertBookText());
  const shadows = parseShadowBook(await readShadowBookText());
  const alerts = book.records;
  const earliest = new Map<string, number>();
  const note = (ticker: string, at: number) => {
    const prior = earliest.get(ticker);
    if (prior == null || at < prior) earliest.set(ticker, at);
  };
  for (let i = 0; i < alerts.length; i++) note(alerts[i].ticker, alerts[i].sentAt);
  let first = Infinity;
  for (let i = 0; i < alerts.length; i++) first = Math.min(first, alerts[i].sentAt);
  for (let i = 0; i < shadows.records.length; i++) first = Math.min(first, shadows.records[i].openedAt);
  const research = shadows.research ?? [];
  for (let i = 0; i < research.length; i++) first = Math.min(first, research[i].openedAt);
  if (Number.isFinite(first)) {
    note("SPY", first);
    note("QQQ", first);
  }
  result.tickers = Array.from(earliest.keys()).sort();
  if (result.tickers.length === 0) return result;

  const opened = await openCandleAccess();
  if (!opened.access) {
    result.errors.push(opened.errorSample);
    return result;
  }
  const access = opened.access;
  const history = await fetchHistory(access, earliest, result.errors);
  for (let i = 0; i < result.tickers.length; i++) {
    const ticker = result.tickers[i];
    const row = history.get(ticker);
    if (!row || row.intraday.length === 0 || row.daily.length === 0) result.tickersWithoutHistory.push(ticker);
  }
  const alertTickers = Array.from(new Set(alerts.map((alert) => alert.ticker))).sort();
  const earnings = await fetchEarnings(access, alertTickers);
  earnings.forEach((value, ticker) => {
    if (value == null) result.earningsUnavailable.push(ticker);
  });

  const filled = backfillAlerts(alerts, { history, earnings, now });
  result.counts = filled.counts;
  const changedById = new Map<string, StoredAlert>();
  for (let i = 0; i < filled.alerts.length; i++) {
    if (filled.alerts[i] !== alerts[i]) changedById.set(filled.alerts[i].id, filled.alerts[i]);
  }

  const spy = history.get("SPY");
  const shadowPlan = planShadowFills(shadows, changedById, spy, now);
  result.shadowSpyTrendFilled = shadowPlan.shadowSpy;
  result.researchSpyTrendFilled = shadowPlan.researchSpy;
  if (!input.apply) return result;

  const alertSaved = changedById.size === 0 ? true : await updateAlertBook((current) => {
    const latest = parseAlertBook(current);
    return JSON.stringify({
      ...latest,
      records: latest.records.map((alert) => mergeFilled(alert, changedById.get(alert.id))),
    });
  });
  const shadowSaved = await updateShadowBook((current) => {
    const latest = parseShadowBook(current);
    return serializeShadowBook(planShadowFills(latest, changedById, spy, now).book);
  });
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
  spy: UnderlyingHistory | undefined,
  now: Date,
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
      const trend = spyTrendAt(spy, next.openedAt, now);
      if (trend !== "unknown") {
        next = { ...next, spyTrend: trend, spyTrendSource: "backfill" };
        shadowSpy += 1;
      }
    }
    return next;
  });
  const research = (shadows.research ?? []).map((track) => {
    if (track.spyTrend !== "unknown") return track;
    const trend = spyTrendAt(spy, track.openedAt, now);
    if (trend === "unknown") return track;
    researchSpy += 1;
    return { ...track, spyTrend: trend, spyTrendSource: "backfill" as const };
  });
  return { book: { ...shadows, records, research: shadows.research ? research : undefined }, shadowSpy, researchSpy };
}

async function fetchHistory(
  access: CandleAccess,
  earliest: ReadonlyMap<string, number>,
  errors: string[],
): Promise<Map<string, UnderlyingHistory>> {
  const intradaySubs: CandleSubscription[] = [];
  const dailySubs: CandleSubscription[] = [];
  earliest.forEach((at, ticker) => {
    const day = Math.floor(at / DAY_MS) * DAY_MS;
    intradaySubs.push({ streamer: ticker, fromTime: day - DAY_MS, period: "5m" });
    dailySubs.push({ streamer: ticker, fromTime: day - DAILY_LOOKBACK_DAYS * DAY_MS, period: "1d" });
  });
  const [intraday, daily] = await Promise.all([
    fetchOptionCandles(intradaySubs, { access, timeoutMs: 90_000, quietMs: 4000 }),
    fetchOptionCandles(dailySubs, { access, timeoutMs: 60_000, quietMs: 4000 }),
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
