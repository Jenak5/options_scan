import { parseAlertBook } from "@/app/lib/alertBook";
import {
  commitCandleRun,
  readCandleIndex,
  type CandleWrite,
} from "@/app/lib/candleStore";
import {
  CANDLE_BACKFILL_FROM,
  backfillCandleTargets,
  candleFromTime,
  dailyCandleTargets,
  needsBackfillFetch,
  needsDailyFetch,
  type CandleTarget,
} from "@/app/lib/candleTargets";
import { chicagoClock, chicagoDate } from "@/app/lib/marketHours";
import { parseShadowBook } from "@/app/lib/shadow";
import { refineStoredTimeStops } from "@/app/lib/shadowStore";
import { readAlertBookText, readShadowBookText } from "@/app/lib/schwabStore";
import { noteMarketDataError, recordMarketData } from "@/app/lib/marketData";
import {
  fetchOptionCandles,
  openCandleAccess,
  tastytradeCandleConfigured,
  type CandleAccess,
  type CandleSubscription,
} from "@/app/lib/tastytradeCandles";
import type { CandleBar } from "@/app/lib/candleTypes";

/**
 * Fetch 1-minute option candles and store one blob per contract per day.
 * One call handles a slice, saves each contract before the next, and returns
 * how many are still waiting. This does not recompute live scorecard exits.
 * A stored 60-minute paper row can be repriced from the bars just saved. The A or B exit stays as stored.
 */

/** Contracts started on one cron or backfill call. DXLink allows 100; this stays under the route limit. */
export const CANDLE_CONTRACTS_PER_CALL = 50;

/** Stop before Vercel's 300s limit so the response, and the last save, still finish. */
export const CANDLE_TIME_BUDGET_MS = 240_000;

export interface CandleJobResult {
  ok: boolean;
  skipped?: string;
  reason?: string;
  alerts: number;
  fetched: number;
  /** Contracts saved with a done marker on this call. */
  processed: number;
  /** Contracts still waiting after this call. */
  remaining: number;
  daysWritten: number;
  daysSkipped: number;
  errors: number;
  errorNotes: string[];
  /** Tastytrade OAuth error and error_description. Null when that request succeeded. */
  errorSample: string | null;
  rateLimited: boolean;
}

export async function runCandleJob(options: {
  mode: "daily" | "backfill";
  now?: Date;
  fetchCandles?: typeof fetchOptionCandles;
  /** Injected in tests. Production opens one token for the whole call. */
  access?: CandleAccess | null;
  cap?: number;
  budgetMs?: number;
  nowMs?: () => number;
}): Promise<CandleJobResult> {
  const now = options.now ?? new Date();
  const empty: CandleJobResult = {
    ok: false,
    alerts: 0,
    fetched: 0,
    processed: 0,
    remaining: 0,
    daysWritten: 0,
    daysSkipped: 0,
    errors: 0,
    errorNotes: [],
    errorSample: null,
    rateLimited: false,
  };
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return { ...empty, reason: "Blob storage is not configured" };
  }
  if (!tastytradeCandleConfigured()) {
    const note = "Set TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, and TASTYTRADE_REFRESH_TOKEN.";
    await commitCandleRun({
      now: now.getTime(),
      errors: 1,
      errorNotes: [note],
      errorSample: null,
      writes: [],
    }).catch(() => undefined);
    return { ...empty, errors: 1, errorNotes: [note], reason: note };
  }
  const fromTime = candleFromTime(options.mode, now);
  if (fromTime == null) return { ...empty, reason: "Candle start time is not a Chicago timestamp" };

  const [alertText, shadowText] = await Promise.all([
    readAlertBookText().catch(() => null),
    readShadowBookText().catch(() => null),
  ]);
  const alerts = parseAlertBook(alertText).records;
  const book = parseShadowBook(shadowText);
  const targets = options.mode === "backfill"
    ? backfillCandleTargets({ alerts, shadows: book.records, research: book.research ?? [] })
    : dailyCandleTargets({ alerts, shadows: book.records, research: book.research ?? [], now });
  const index = await readCandleIndex();
  const today = chicagoDate(now);
  const pending = targets.filter((target) => {
    const meta = index.contracts[target.contractKey];
    return options.mode === "backfill" ? needsBackfillFetch(meta) : needsDailyFetch(meta, today);
  });
  if (pending.length === 0) {
    const saved = await commitCandleRun({
      now: now.getTime(),
      errors: 0,
      errorNotes: [],
      errorSample: null,
      writes: [],
    });
    return {
      ok: !saved.rateLimited,
      alerts: targets.length,
      fetched: 0,
      processed: 0,
      remaining: 0,
      daysWritten: saved.daysWritten,
      daysSkipped: saved.daysSkipped,
      errors: 0,
      errorNotes: [],
      errorSample: null,
      rateLimited: saved.rateLimited,
    };
  }

  const cap = Math.max(1, options.cap ?? CANDLE_CONTRACTS_PER_CALL);
  const budgetMs = options.budgetMs ?? CANDLE_TIME_BUDGET_MS;
  const nowMs = options.nowMs ?? Date.now;
  const started = nowMs();
  const slice = pending.slice(0, cap);
  let access = options.access ?? null;
  if (!options.fetchCandles && !access) {
    const opened = await openCandleAccess();
      if (!opened.access) {
      const note = opened.errorSample;
      await noteMarketDataError(note);
      const saved = await commitCandleRun({
        now: now.getTime(),
        errors: 1,
        errorNotes: [note],
        errorSample: note,
        writes: [],
      });
      return {
        ok: false,
        alerts: targets.length,
        fetched: 0,
        processed: 0,
        remaining: pending.length,
        daysWritten: saved.daysWritten,
        daysSkipped: saved.daysSkipped,
        errors: 1,
        errorNotes: [note],
        errorSample: note,
        rateLimited: saved.rateLimited,
        reason: note,
      };
    }
    access = opened.access;
  }
  const fetchCandles = options.fetchCandles ?? ((subs: readonly CandleSubscription[]) => fetchOptionCandles(subs, { access }));
  let processed = 0;
  let daysWritten = 0;
  let daysSkipped = 0;
  let errors = 0;
  const notes: string[] = [];
  const refined: { key: string; bars: readonly CandleBar[] }[] = [];
  const hasTimeStop = book.records.some((row) => row.cohort === "time-60");
  let errorSample: string | null = null;
  let rateLimited = false;
  for (let i = 0; i < slice.length; i++) {
    if (i > 0 && nowMs() - started >= budgetMs) break;
    if (rateLimited) break;
    const target = slice[i];
    const fetched = await fetchCandles([{ streamer: target.streamer, fromTime }]);
    if (fetched.errorSample) {
      errorSample = fetched.errorSample;
      notes.push(errorSample);
      errors += 1;
      const saved = await commitCandleRun({
        now: now.getTime(),
        errors,
        errorNotes: notes.slice(0, 8),
        errorSample,
        writes: [],
      });
      rateLimited = saved.rateLimited;
      daysWritten += saved.daysWritten;
      daysSkipped += saved.daysSkipped;
      break;
    }
    const bars = fetched.candles.get(target.streamer) ?? [];
    const done = fetched.completed.indexOf(target.streamer) !== -1;
    if (!done && bars.length === 0) {
      errors += 1;
      const note = fetched.errors[0] ?? `${target.streamer} did not finish`;
      if (notes.length < 8) notes.push(note);
      const saved = await commitCandleRun({
        now: now.getTime(),
        errors,
        errorNotes: notes.slice(0, 8),
        errorSample: null,
        writes: [],
      });
      daysWritten += saved.daysWritten;
      daysSkipped += saved.daysSkipped;
      rateLimited = saved.rateLimited;
      continue;
    }
    const saved = await commitCandleRun({
      now: now.getTime(),
      errors,
      errorNotes: notes.slice(0, 8),
      errorSample: null,
      writes: [writeFor(target, bars, options.mode, now, done)],
    });
    daysWritten += saved.daysWritten;
    daysSkipped += saved.daysSkipped;
    if (saved.rateLimited) {
      rateLimited = true;
      notes.push("Vercel Blob returned 429 Too Many Requests");
      break;
    }
    processed += 1;
    if (hasTimeStop) refined.push({ key: target.contractKey, bars });
  }
  if (hasTimeStop && refined.length > 0) {
    await refineStoredTimeStops(refined, now).catch(() => undefined);
  }
  if (processed > 0) {
    await recordMarketData("candles", "tastytrade", null, "option candles");
  } else if (errorSample) {
    await noteMarketDataError(errorSample);
  }
  const remaining = pending.length - processed;
  return {
    ok: errors === 0 && !rateLimited && errorSample == null,
    alerts: targets.length,
    fetched: processed,
    processed,
    remaining,
    daysWritten,
    daysSkipped,
    errors: rateLimited ? errors + 1 : errors,
    errorNotes: notes.slice(0, 8),
    errorSample,
    rateLimited,
    reason: errorSample ?? undefined,
  };
}

function writeFor(
  target: CandleTarget,
  bars: readonly CandleBar[],
  mode: "daily" | "backfill",
  now: Date,
  completed: boolean,
): CandleWrite {
  const today = chicagoDate(now);
  const minutes = chicagoClock(now)?.minutes ?? -1;
  const afterClose = minutes >= 15 * 60 + 30;
  const emptyClosedDays: string[] = [];
  if (completed && bars.length === 0 && mode === "daily" && afterClose) emptyClosedDays.push(today);
  return {
    contractKey: target.contractKey,
    ids: target.id.split(",").filter((id) => id.length > 0),
    bars,
    closed: afterClose,
    backfillFrom: mode === "backfill" && completed ? CANDLE_BACKFILL_FROM : null,
    emptyClosedDays,
  };
}

