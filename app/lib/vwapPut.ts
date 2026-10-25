import { VWAP_PUT_TEST } from "@/app/lib/alertConfig";
import { snapshotFromFlow } from "@/app/lib/alertFeatures";
import type { CandleBar } from "@/app/lib/candleTypes";
import { nyMinutes, sessionVwap } from "@/app/lib/featureBackfill";
import { CORE_FLOW_WATCHLIST, type FlowRow } from "@/app/lib/flow";
import { chicagoDate, chicagoWallTimeMs, isChicagoMarketHours } from "@/app/lib/marketHours";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import type { ShadowTrade } from "@/app/lib/shadow";

/**
 * Paper puts on the core names when a 1-minute bar closes back under session VWAP.
 * VWAP is the volume-weighted typical price of Tastytrade 1-minute underlying candles.
 * Nothing here sends a Telegram alert or places an order.
 */

const MINUTE_MS = 60_000;
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;
const CORE = new Set<string>(CORE_FLOW_WATCHLIST);

export const VWAP_PUT_SECTION_NOTE =
  `${VWAP_PUT_TEST.label}. These are not A or B grades, they are not sent, and they are left out of the totals above. During the Central session, a core ticker that has traded above its session VWAP and then closes a 1-minute bar back below it is paper-bought as one put at the ask. The put is the strike nearest the stock, 7 or more days out, with an ask of at least $0.50 and a cost of $${MAX_LOSS_DOLLARS} or less. Session VWAP uses Tastytrade 1-minute underlying candles. Exits: plus 40%, minus 25%, and flat by the 3:00 PM Central close the same day. At most ${VWAP_PUT_TEST.opensPerRun} on a run and ${VWAP_PUT_TEST.opensPerDay} on a Chicago day, and one per ticker that day. The live alert rules are unchanged. No order is placed. Estimates from quotes, not fills.`;

export function vwapPutTrustNote(resolved: number): string {
  if (resolved < VWAP_PUT_TEST.minTrust) {
    return `${resolved} resolved paper puts. Fewer than ${VWAP_PUT_TEST.minTrust} is too few to read as a result.`;
  }
  return `${resolved} resolved paper puts. That is enough to describe. It does not change a live alert or an exit.`;
}

/** Completed regular-session minutes. The bar still forming, and anything outside 9:30–16:00 New York, is left out. */
export function completedSessionMinutes(bars: readonly CandleBar[], now: number): CandleBar[] {
  const out: CandleBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!(bar.t > 0) || bar.t + MINUTE_MS > now) continue;
    const minutes = nyMinutes(bar.t);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    const prev = out[out.length - 1];
    if (prev && prev.t === bar.t) out[out.length - 1] = bar;
    else out.push(bar);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * True when the latest completed minute closed under session VWAP
 * and the minute before it closed above the VWAP as of that minute.
 */
export function vwapRejection(bars: readonly CandleBar[], now: number): boolean {
  const closed = completedSessionMinutes(bars, now);
  if (closed.length < 2) return false;
  const prev = closed[closed.length - 2];
  const last = closed[closed.length - 1];
  if (!((prev.v ?? 0) > 0) || !((last.v ?? 0) > 0)) return false;
  const prevVwap = sessionVwap(closed.slice(0, -1));
  const vwap = sessionVwap(closed);
  if (prevVwap == null || vwap == null) return false;
  return prev.c > prevVwap && last.c < vwap;
}

export function chooseVwapPuts(input: {
  rows: readonly FlowRow[];
  candles: ReadonlyMap<string, readonly CandleBar[]>;
  now: Date;
  existing: readonly Pick<ShadowTrade, "ticker" | "expiration" | "strike" | "putCall" | "cohort" | "openedAt">[];
}): FlowRow[] {
  if (!isChicagoMarketHours(input.now)) return [];
  const day = chicagoDate(input.now);
  const openedToday = new Set<string>();
  const contracts = new Set<string>();
  for (let i = 0; i < input.existing.length; i++) {
    const row = input.existing[i];
    if (row.cohort !== "vwap-put") continue;
    contracts.add(contractKey(row));
    if (chicagoDate(new Date(row.openedAt)) === day) openedToday.add(row.ticker);
  }
  const room = Math.max(0, VWAP_PUT_TEST.opensPerDay - openedToday.size);
  const cap = Math.min(VWAP_PUT_TEST.opensPerRun, room);
  if (cap <= 0) return [];

  const byTicker = new Map<string, FlowRow[]>();
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    if (!CORE.has(row.ticker)) continue;
    let list = byTicker.get(row.ticker);
    if (!list) {
      list = [];
      byTicker.set(row.ticker, list);
    }
    list.push(row);
  }

  const picked: FlowRow[] = [];
  for (let i = 0; i < CORE_FLOW_WATCHLIST.length && picked.length < cap; i++) {
    const ticker = CORE_FLOW_WATCHLIST[i];
    if (openedToday.has(ticker)) continue;
    const rows = byTicker.get(ticker);
    if (!rows || rows.length === 0) continue;
    const bars = input.candles.get(ticker);
    if (!bars || !vwapRejection(bars, input.now.getTime())) continue;
    const put = nearestPut(rows);
    if (!put || contracts.has(contractKey(put))) continue;
    contracts.add(contractKey(put));
    openedToday.add(ticker);
    picked.push(put);
  }
  return picked;
}

export function vwapPutShadow(row: FlowRow, now: Date): ShadowTrade | null {
  if (row.putCall !== "put") return null;
  if (!putEligible(row)) return null;
  const id = vwapPutId(row, now);
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    alertId: id,
    openedAt: now.getTime(),
    ticker: row.ticker,
    putCall: "put",
    strike: row.strike,
    expiration: row.expiration,
    grade: "test",
    cohort: "vwap-put",
    experimentLabel: VWAP_PUT_TEST.label,
    probeGrade: null,
    contracts: 1,
    entryPrice: row.ask,
    entryPriceSource: "ask",
    status: "open",
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    exitQuote: null,
    exitStale: false,
    pnlDollars: null,
    pnlFraction: null,
    tradingDaysHeld: null,
    lastMark: null,
    lastMarkSource: null,
    lastMarkedAt: null,
    features: snapshotFromFlow(row, now),
    rulesVersion: RULES_VERSION,
    marks: [],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
  };
}

/** 3:00 PM America/Chicago on the Chicago day the paper put was opened. */
export function vwapSameDayCloseMs(openedAt: number): number | null {
  const day = chicagoDate(new Date(openedAt));
  if (!day) return null;
  return chicagoWallTimeMs(day, 15, 0);
}

function nearestPut(rows: readonly FlowRow[]): FlowRow | null {
  let best: FlowRow | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!putEligible(row)) continue;
    const spot = row.underlyingPrice;
    if (spot == null || !(spot > 0)) continue;
    const distance = Math.abs(row.strike - spot);
    if (!best || distance < bestDistance - 1e-9) {
      best = row;
      bestDistance = distance;
      continue;
    }
    if (Math.abs(distance - bestDistance) > 1e-9) continue;
    const dte = row.dte ?? 9999;
    const bestDte = best.dte ?? 9999;
    if (dte < bestDte || (dte === bestDte && (row.ask < best.ask || (row.ask === best.ask && row.id < best.id)))) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

function putEligible(row: FlowRow): boolean {
  if (row.putCall !== "put") return false;
  if (row.dte == null || row.dte < VWAP_PUT_TEST.minDte) return false;
  if (!Number.isFinite(row.ask) || row.ask < VWAP_PUT_TEST.minAsk) return false;
  if (row.ask * 100 > MAX_LOSS_DOLLARS + 1e-6) return false;
  if (row.underlyingPrice == null || !(row.underlyingPrice > 0)) return false;
  return true;
}

function vwapPutId(row: Pick<FlowRow, "id">, now: Date): string {
  const day = chicagoDate(now).replace(/-/g, "");
  return `vwap${day}-${row.id}`.slice(0, 180);
}

function contractKey(row: { ticker: string; expiration: string; strike: number; putCall: string }): string {
  return `${row.ticker}|${row.expiration}|${row.strike}|${row.putCall}`;
}
