import type { StoredAlert } from "@/app/lib/alertBook";
import type { CandleContractMeta } from "@/app/lib/candleStore";
import { chicagoDate, chicagoWallTimeMs, isChicagoMinuteWindow, isMarketDay } from "@/app/lib/marketHours";
import { tastytradeStreamerSymbol } from "@/app/lib/optionStreamer";
import { trackWindowOpen, type ResearchTrack } from "@/app/lib/researchTrack";
import type { ShadowTrade } from "@/app/lib/shadow";

/**
 * Who gets a 1-minute candle fetch.
 * Daily (the 3:30pm Chicago cron): open scorecard shadows and A/B alerts still
 * inside the 7-trading-day window. C and D research tracks, and any C or D
 * alert still on file, are left out of that fetch. Backfill still lists every
 * alert, shadow, and research track that has a contract symbol, including ones
 * whose window has ended, so stored history can be filled without the cron.
 */

export const CANDLE_BACKFILL_FROM = "2026-09-01";

/** 3:30pm America/Chicago, plus a few minutes for a late cron invocation. */
export const CANDLE_CRON_START_MINUTE = 15 * 60 + 30;
export const CANDLE_CRON_END_MINUTE = 15 * 60 + 35;

export interface CandleTarget {
  contractKey: string;
  /** Comma-joined alert, shadow, and research ids that share this contract. */
  id: string;
  streamer: string;
  openedAt: number;
}

export function isAfterCloseCandleSlot(now: Date): boolean {
  return isChicagoMinuteWindow(now, CANDLE_CRON_START_MINUTE, CANDLE_CRON_END_MINUTE);
}

export function candleCronDecision(now: Date, manual: boolean): { run: boolean; reason: string | null } {
  if (!isMarketDay(now)) return { run: false, reason: "market holiday" };
  if (manual) return { run: true, reason: null };
  if (!isAfterCloseCandleSlot(now)) {
    return { run: false, reason: "Outside the 3:30pm America/Chicago candle window" };
  }
  return { run: true, reason: null };
}

export function dailyCandleTargets(input: {
  alerts: readonly StoredAlert[];
  shadows: readonly ShadowTrade[];
  research: readonly ResearchTrack[];
  now: Date;
}): CandleTarget[] {
  const out = new Map<string, CandleTarget>();
  // input.research stays in Blob. The 3:30 cron does not fetch those C and D tracks.
  for (let i = 0; i < input.shadows.length; i++) {
    const row = input.shadows[i];
    if (row.status !== "open" && !trackWindowOpen(row.openedAt, row.expiration, input.now)) continue;
    addTarget(out, targetFromParts(row.id, row.ticker, row.expiration, row.strike, row.putCall, row.openedAt));
  }
  for (let i = 0; i < input.alerts.length; i++) {
    const row = input.alerts[i];
    if (row.grade === "C" || row.grade === "D") continue;
    if (!trackWindowOpen(row.sentAt, row.expiration, input.now)) continue;
    addTarget(out, targetFromParts(row.id, row.ticker, row.expiration, row.strike, row.putCall, row.sentAt));
  }
  return Array.from(out.values());
}

export function backfillCandleTargets(input: {
  alerts: readonly StoredAlert[];
  shadows: readonly ShadowTrade[];
  research: readonly ResearchTrack[];
}): CandleTarget[] {
  const out = new Map<string, CandleTarget>();
  for (let i = 0; i < input.alerts.length; i++) {
    const row = input.alerts[i];
    addTarget(out, targetFromParts(row.id, row.ticker, row.expiration, row.strike, row.putCall, row.sentAt));
  }
  for (let i = 0; i < input.shadows.length; i++) {
    const row = input.shadows[i];
    addTarget(out, targetFromParts(row.id, row.ticker, row.expiration, row.strike, row.putCall, row.openedAt));
  }
  for (let i = 0; i < input.research.length; i++) {
    const row = input.research[i];
    addTarget(out, targetFromParts(row.id, row.ticker, row.expiration, row.strike, row.putCall, row.openedAt));
  }
  return Array.from(out.values());
}

export function needsDailyFetch(meta: CandleContractMeta | undefined, today: string): boolean {
  const day = meta?.days[today];
  if (!day) return true;
  return day.closed !== true;
}

export function needsBackfillFetch(meta: CandleContractMeta | undefined): boolean {
  if (!meta?.backfillFrom) return true;
  return meta.backfillFrom > CANDLE_BACKFILL_FROM;
}

export function candleFromTime(mode: "daily" | "backfill", now: Date): number | null {
  if (mode === "backfill") return chicagoWallTimeMs(CANDLE_BACKFILL_FROM, 0, 0);
  const day = chicagoDate(now);
  if (!day) return null;
  return chicagoWallTimeMs(day, 0, 0);
}

function targetFromParts(
  id: string,
  ticker: string,
  expiration: string,
  strike: number,
  putCall: "call" | "put",
  openedAt: number,
): CandleTarget | null {
  const streamer = tastytradeStreamerSymbol({ ticker, expiration, strike, putCall });
  if (!streamer) return null;
  if (!Number.isFinite(openedAt)) return null;
  return {
    contractKey: `${ticker}|${expiration}|${strike}|${putCall}`,
    id,
    streamer,
    openedAt,
  };
}

function addTarget(into: Map<string, CandleTarget>, target: CandleTarget | null): void {
  if (!target) return;
  const prior = into.get(target.contractKey);
  if (!prior) {
    into.set(target.contractKey, target);
    return;
  }
  if (target.openedAt < prior.openedAt) prior.openedAt = target.openedAt;
  const ids = prior.id.split(",");
  if (ids.indexOf(target.id) === -1) prior.id = `${prior.id},${target.id}`;
}
