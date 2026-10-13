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
import { readAlertBookText, readShadowBookText } from "@/app/lib/schwabStore";
import { fetchOptionCandles, tastytradeCandleConfigured, type CandleSubscription } from "@/app/lib/tastytradeCandles";
import type { CandleBar } from "@/app/lib/candleTypes";

/**
 * Fetch 1-minute option candles and store one blob per contract per day.
 * This does not recompute live scorecard exits.
 */

export interface CandleJobResult {
  ok: boolean;
  skipped?: string;
  reason?: string;
  alerts: number;
  fetched: number;
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
}): Promise<CandleJobResult> {
  const now = options.now ?? new Date();
  const empty: CandleJobResult = {
    ok: false,
    alerts: 0,
    fetched: 0,
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
      daysWritten: saved.daysWritten,
      daysSkipped: saved.daysSkipped,
      errors: 0,
      errorNotes: [],
      errorSample: null,
      rateLimited: saved.rateLimited,
    };
  }

  const subs: CandleSubscription[] = pending.map((target) => ({ streamer: target.streamer, fromTime }));
  const fetchCandles = options.fetchCandles ?? fetchOptionCandles;
  const fetched = await fetchCandles(subs);
  if (fetched.errorSample) {
    const note = fetched.errorSample;
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
      daysWritten: saved.daysWritten,
      daysSkipped: saved.daysSkipped,
      errors: 1,
      errorNotes: [note],
      errorSample: note,
      rateLimited: saved.rateLimited,
      reason: note,
    };
  }
  const completed = new Set(fetched.completed);
  const writes: CandleWrite[] = [];
  for (let i = 0; i < pending.length; i++) {
    const target = pending[i];
    const bars = fetched.candles.get(target.streamer) ?? [];
    const done = completed.has(target.streamer);
    if (!done && bars.length === 0) continue;
    writes.push(writeFor(target, bars, options.mode, now, done));
  }
  const notes = fetched.errors.slice(0, 8);
  const missed = pending.filter((target) => !completed.has(target.streamer) && !(fetched.candles.get(target.streamer)?.length)).length;
  const errors = notes.length > 0 ? Math.max(notes.length, missed) : 0;
  const saved = await commitCandleRun({
    now: now.getTime(),
    errors,
    errorNotes: notes,
    errorSample: null,
    writes,
  });
  return {
    ok: errors === 0 && !saved.rateLimited,
    alerts: targets.length,
    fetched: pending.length,
    daysWritten: saved.daysWritten,
    daysSkipped: saved.daysSkipped,
    errors: saved.rateLimited ? errors + 1 : errors,
    errorNotes: saved.rateLimited ? notes.concat("Vercel Blob returned 429 Too Many Requests").slice(0, 8) : notes,
    errorSample: null,
    rateLimited: saved.rateLimited,
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

