import { TRADE_RULES, VWAP_PUT_TEST } from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import type { FlowRow } from "@/app/lib/flow";
import { addCalendarDays, newYorkDate } from "@/app/lib/flow";
import { nyMinutes } from "@/app/lib/featureBackfill";
import {
  chicagoClock,
  chicagoDate,
  chicagoWallTimeMs,
  isChicagoMarketHours,
  isMarketDay,
  previousChicagoTradingDay,
} from "@/app/lib/marketHours";
import { tastytradeStreamerSymbol } from "@/app/lib/optionStreamer";
import type { ShadowTrade, VwapVariantResult } from "@/app/lib/shadow";

/**
 * Paper log for the backtested VWAP rejection put.
 * Nothing here sends a Telegram alert, changes an A or B grade, or places an order.
 *
 * Session VWAP matches the backtest: 1-minute regular-hours candles, anchored at
 * 9:30 ET, typical price (H+L+C)/3, volume floored at 1, cumulative through the
 * current bar. A signal is the first bar of the day, at or before 2:30 PM CT,
 * that follows at least 15 closes below that VWAP, trades up to VWAP, and
 * closes back below it. Entry is the next minute's open. One signal per ticker
 * per day.
 *
 * SPX and XSP use SPY's signal. SPX contracts use the SPXW root. Their spot
 * for the strike walk is the chain's underlying price, because SPX has no
 * volume and its price is not SPY's.
 */

const MINUTE_MS = 60_000;
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const PREMARKET_OPEN = 4 * 60;
const LAST_SIGNAL_CT = 14 * 60 + 30;
const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;

export const VWAP_PAPER_RULE = 2;
export const VWAP_BELOW_BARS = 15;
export const VWAP_PREMIUM_MAX = 8.75;
export const VWAP_PREMIUM_MIN = 0.2;
export const VWAP_SPREAD = 0.036;
export const VWAP_FEE = 0.65;
export const VWAP_LEVEL_BAND = 0.0015;
/** Chain reads per cron run. Tickers left out are logged on a later run the same day. */
export const VWAP_SIGNALS_PER_RUN = 6;
/** ATM plus this many further-OTM strikes are priced from 1-minute candles. */
export const VWAP_STRIKE_WALK = 20;
export const VWAP_PAPER_ROW_CAP = 1_500;

export const VWAP_PAPER_TICKERS = [
  "SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMD", "TSLA", "META", "AMZN",
  "GOOGL", "PLTR", "SOFI", "JPM", "XOM", "BA", "UBER", "DIA", "SPX", "XSP",
] as const;

export const VWAP_PAPER_SOURCES = VWAP_PAPER_TICKERS.filter((ticker) => ticker !== "SPX" && ticker !== "XSP");

export type VwapExpiryType = "0DTE" | "1DTE" | "weekly";
export type VwapEntryWindow = "9:30-10" | "10-11:30" | "11:30-2" | "2-close";
export type SpyDayFlag = "up" | "down" | "flat";

export const VWAP_PUT_SECTION_NOTE =
  `${VWAP_PUT_TEST.label}. These are not A or B grades, they are not sent, and they are left out of the totals above. A name is paper-logged once a day when at least 15 completed 1-minute closes sit below session VWAP and the next bar trades up to VWAP and closes back below it. Session VWAP is the regular-hours typical price, volume-weighted, with volume floored at 1, from Tastytrade 1-minute candles anchored at 9:30 ET. Entry is the next minute's open. The stored price is that open, and the spread and fees are applied in the P/L. Each signal logs a 0DTE put, a 1DTE put, and the nearest put on the first Friday at least 7 days out. The strike starts at the money and steps further out of the money until the premium is $${VWAP_PREMIUM_MAX} or less and at least $${VWAP_PREMIUM_MIN}. If none exists, the row says no contract. Exits are a minus 25% stop and a plus 40% target, scored twice on the same row: a 60-minute exit and a flat exit at 3:00 PM Central. Prices are that contract's own 1-minute candles, with a ${VWAP_SPREAD * 100}% spread proxy and $${VWAP_FEE} each way. The headline totals are the flat exit. Older cross-down paper rows stay stored and are left out of these totals. No order is placed.`;

export function vwapPutTrustNote(resolved: number): string {
  if (resolved < VWAP_PUT_TEST.minTrust) {
    return `${resolved} resolved paper puts. Fewer than ${VWAP_PUT_TEST.minTrust} is too few to read as a result.`;
  }
  return `${resolved} resolved paper puts. That is enough to describe. It does not change a live alert or an exit.`;
}

/** New paper rows are allowed only on a market day, before 3:00 PM Central. */
export function vwapPaperEntriesOpen(now: Date): boolean {
  return isMarketDay(now) && isChicagoMarketHours(now);
}

export function optionRoot(ticker: string): string {
  return ticker === "SPX" ? "SPXW" : ticker;
}

export function entryWindowOf(at: number): VwapEntryWindow {
  const minutes = nyMinutes(at);
  if (minutes < 10 * 60) return "9:30-10";
  if (minutes < 11 * 60 + 30) return "10-11:30";
  if (minutes < 14 * 60) return "11:30-2";
  return "2-close";
}

/** First Friday on or after 7 calendar days from `today`. */
export function weeklyFriday(today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const start = addCalendarDays(today, 7);
  for (let i = 0; i < 7; i++) {
    const ymd = addCalendarDays(start, i);
    const parts = ymd.split("-");
    const dow = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
    if (dow === 5) return ymd;
  }
  return null;
}

export interface VwapReject {
  signalAt: number;
  entryAt: number;
  vwap: number;
  window: VwapEntryWindow;
  /** True once the entry minute has completed, even if that bar did not print. */
  ready: boolean;
  /** Next minute's open, when that bar printed. */
  entryOpen: number | null;
  signalClose: number;
}

/**
 * First rejection of the New York day that `nowMs` falls on.
 * Bars from other days are ignored so a prior session in the same fetch cannot fire.
 */
export function firstVwapReject(bars: readonly CandleBar[], nowMs: number): VwapReject | null {
  if (!Number.isFinite(nowMs)) return null;
  const today = newYorkDate(new Date(nowMs));
  const session = completedSessionMinutes(bars, nowMs).filter((bar) => newYorkDate(new Date(bar.t)) === today);
  let weighted = 0;
  let volume = 0;
  let below = 0;
  for (let i = 0; i < session.length; i++) {
    const bar = session[i];
    const typical = (bar.h + bar.l + bar.c) / 3;
    const weight = barWeight(bar);
    weighted += typical * weight;
    volume += weight;
    const vwap = weighted / volume;
    const clock = chicagoClock(new Date(bar.t));
    const inWindow = clock != null && clock.minutes <= LAST_SIGNAL_CT;
    if (below >= VWAP_BELOW_BARS && bar.h >= vwap && bar.c < vwap && inWindow) {
      const entryAt = bar.t + MINUTE_MS;
      const entry = session.find((item) => item.t === entryAt);
      return {
        signalAt: bar.t,
        entryAt,
        vwap,
        window: entryWindowOf(bar.t),
        ready: nowMs >= entryAt + MINUTE_MS,
        entryOpen: entry && entry.o > 0 ? entry.o : null,
        signalClose: bar.c,
      };
    }
    below = bar.c < vwap ? below + 1 : 0;
  }
  return null;
}

/** Completed regular-session minutes. The bar still forming, and anything outside 9:30–16:00 New York, is left out. */
export function completedSessionMinutes(bars: readonly CandleBar[], now: number): CandleBar[] {
  const out: CandleBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!usableBar(bar) || bar.t + MINUTE_MS > now) continue;
    const minutes = nyMinutes(bar.t);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    const prev = out[out.length - 1];
    if (prev && prev.t === bar.t) out[out.length - 1] = bar;
    else out.push(bar);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function levelLinesUp(vwap: number, priorHigh: number | null, premarketHigh: number | null): boolean {
  if (!(vwap > 0)) return false;
  const band = vwap * VWAP_LEVEL_BAND;
  const near = (level: number | null) => level != null && Number.isFinite(level) && Math.abs(level - vwap) <= band + 1e-9;
  return near(priorHigh) || near(premarketHigh);
}

/** Highest regular-session high on the last New York day before `today`. */
export function priorSessionHigh(bars: readonly CandleBar[], today: string): number | null {
  let day = "";
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!usableBar(bar)) continue;
    const minutes = nyMinutes(bar.t);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    const date = newYorkDate(new Date(bar.t));
    if (!date || date >= today) continue;
    if (date > day) day = date;
  }
  if (!day) return null;
  let high: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!usableBar(bar) || newYorkDate(new Date(bar.t)) !== day) continue;
    const minutes = nyMinutes(bar.t);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    if (high == null || bar.h > high) high = bar.h;
  }
  return high;
}

/** Highest 4:00–9:30 ET print on `today`. Used on 5-minute extended-hours bars. */
export function premarketHighFromBars(bars: readonly CandleBar[], today: string): number | null {
  let high: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!usableBar(bar) || newYorkDate(new Date(bar.t)) !== today) continue;
    const minutes = nyMinutes(bar.t);
    if (minutes < PREMARKET_OPEN || minutes >= RTH_OPEN) continue;
    if (high == null || bar.h > high) high = bar.h;
  }
  return high;
}

export interface VwapPaperSignal {
  ticker: string;
  root: string;
  source: string;
  signalAt: number;
  entryAt: number;
  vwap: number;
  /** Equity entry open. Null for SPX and XSP until the chain supplies a spot. */
  spot: number | null;
  window: VwapEntryWindow;
  levelLinedUp: boolean;
  sessionDay: string;
}

export function collectSignals(input: {
  candles: ReadonlyMap<string, readonly CandleBar[]>;
  now: Date;
  existing: readonly { ticker: string; cohort?: string | null; paperRuleVersion?: number | null; signalAt?: number | null; openedAt: number }[];
  premarketHigh?: ReadonlyMap<string, number>;
}): VwapPaperSignal[] {
  const nowMs = input.now.getTime();
  const today = newYorkDate(input.now);
  const logged = new Set<string>();
  for (let i = 0; i < input.existing.length; i++) {
    const row = input.existing[i];
    if (row.cohort !== "vwap-put" || row.paperRuleVersion !== VWAP_PAPER_RULE) continue;
    const when = row.signalAt ?? row.openedAt;
    if (newYorkDate(new Date(when)) === today) logged.add(row.ticker);
  }
  const found = new Map<string, VwapReject | null>();
  const out: VwapPaperSignal[] = [];
  for (let i = 0; i < VWAP_PAPER_TICKERS.length; i++) {
    const ticker = VWAP_PAPER_TICKERS[i];
    if (logged.has(ticker)) continue;
    const source = ticker === "SPX" || ticker === "XSP" ? "SPY" : ticker;
    let reject = found.get(source);
    if (reject === undefined) {
      reject = firstVwapReject(input.candles.get(source) ?? [], nowMs);
      found.set(source, reject);
    }
    if (!reject || !reject.ready) continue;
    const indexVehicle = ticker === "SPX" || ticker === "XSP";
    const spot = indexVehicle ? null : (reject.entryOpen ?? reject.signalClose);
    if (!indexVehicle && (spot == null || !(spot > 0))) continue;
    const bars = input.candles.get(source) ?? [];
    const prior = priorSessionHigh(bars, today);
    const pre = input.premarketHigh?.get(source) ?? null;
    out.push({
      ticker,
      root: optionRoot(ticker),
      source,
      signalAt: reject.signalAt,
      entryAt: reject.entryAt,
      vwap: reject.vwap,
      spot: indexVehicle ? null : spot,
      window: reject.window,
      levelLinedUp: levelLinesUp(reject.vwap, prior, pre),
      sessionDay: today,
    });
  }
  return out;
}

export interface ChainPut {
  root: string;
  expiration: string;
  strike: number;
}

/** Puts already on the scan, used when a fresh chain is not requested. */
export function chainPutsFromRows(rows: readonly FlowRow[], root: string): ChainPut[] {
  const out: ChainPut[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.putCall !== "put") continue;
    const rowRoot = row.ticker === "SPX" || row.ticker === "SPXW" ? "SPXW" : row.ticker;
    if (rowRoot !== root) continue;
    if (!(row.strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiration)) continue;
    out.push({ root, expiration: row.expiration, strike: row.strike });
  }
  return out;
}

/** ATM first, then further OTM (lower strikes), capped. Ties go to the higher strike so the walk can step down. */
export function walkStrikes(strikes: readonly number[], spot: number, limit: number = VWAP_STRIKE_WALK): number[] {
  const unique: number[] = [];
  for (let i = 0; i < strikes.length; i++) {
    const strike = strikes[i];
    if (!(strike > 0) || unique.some((item) => Math.abs(item - strike) < 1e-6)) continue;
    unique.push(strike);
  }
  if (unique.length === 0 || !(spot > 0)) return [];
  let atm = unique[0];
  let best = Math.abs(atm - spot);
  for (let i = 1; i < unique.length; i++) {
    const strike = unique[i];
    const distance = Math.abs(strike - spot);
    if (distance < best - 1e-9 || (Math.abs(distance - best) <= 1e-9 && strike > atm)) {
      atm = strike;
      best = distance;
    }
  }
  const lower = unique.filter((strike) => strike < atm - 1e-9).sort((a, b) => b - a);
  return [atm].concat(lower).slice(0, Math.max(0, limit));
}

/**
 * Start at the money and step further OTM until the premium is inside the band.
 * A missing print is skipped. A print under the floor stops the walk.
 */
export function selectPut(
  strikes: readonly number[],
  spot: number,
  premiumOf: (strike: number) => number | null,
  limit: number = VWAP_STRIKE_WALK,
): { strike: number; premium: number } | null {
  const walk = walkStrikes(strikes, spot, limit);
  for (let i = 0; i < walk.length; i++) {
    const premium = premiumOf(walk[i]);
    if (premium == null || !Number.isFinite(premium) || premium <= 0) continue;
    if (premium > VWAP_PREMIUM_MAX + 1e-9) continue;
    if (premium < VWAP_PREMIUM_MIN - 1e-9) return null;
    return { strike: walk[i], premium };
  }
  return null;
}

export function optionOpenAt(bars: readonly CandleBar[] | undefined, entryAt: number): number | null {
  if (!bars) return null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.t === entryAt && bar.o > 0 && Number.isFinite(bar.o)) return bar.o;
  }
  return null;
}

/** Dollar P/L for one contract after the spread proxy and both fees. */
export function paperPnl(entry: number, exitRaw: number): number {
  const half = VWAP_SPREAD / 2;
  const debit = entry * (1 + half);
  const credit = Math.max(0, exitRaw) * (1 - half);
  return (credit - debit) * 100 - VWAP_FEE * 2;
}

export function scorePaperExits(input: {
  entryAt: number;
  entry: number;
  bars: readonly CandleBar[];
  now: number;
  flatAt: number;
}): { exit60: VwapVariantResult | null; exitFlat: VwapVariantResult | null } {
  const entry = input.entry;
  if (!(entry > 0) || !Number.isFinite(entry)) return { exit60: null, exitFlat: null };
  const stop = entry * (1 - TRADE_RULES.stopLossFraction);
  const target = entry * (1 + TRADE_RULES.profitTargetFraction);
  const bars = input.bars.filter((bar) => usableBar(bar) && bar.t + MINUTE_MS <= input.now).sort((a, b) => a.t - b.t);
  return {
    exit60: resolveExit(bars, input.entryAt, input.entryAt + 60 * MINUTE_MS, input.now, entry, stop, target, "time"),
    exitFlat: resolveExit(bars, input.entryAt, input.flatAt, input.now, entry, stop, target, "flat"),
  };
}

export interface PaperBuildInput {
  signals: readonly VwapPaperSignal[];
  puts: readonly ChainPut[];
  optionBars: ReadonlyMap<string, readonly CandleBar[]>;
  /** Roots whose chain or candle read failed. Those signals wait for the next run. */
  retryRoots?: ReadonlySet<string>;
  now: Date;
}

export function buildPaperRows(input: PaperBuildInput): ShadowTrade[] {
  const rows: ShadowTrade[] = [];
  for (let i = 0; i < input.signals.length; i++) {
    const signal = input.signals[i];
    if (input.retryRoots?.has(signal.root)) continue;
    const expirations = expirationPlan(signal.sessionDay);
    for (let j = 0; j < expirations.length; j++) {
      const plan = expirations[j];
      const row = plan == null
        ? noContractRow(signal, "1DTE", signal.sessionDay, input.now)
        : contractRow(signal, plan, input);
      if (row) rows.push(row);
    }
  }
  return rows;
}

export interface VwapPaperBucket {
  key: string;
  label: string;
  trades: number;
  open: number;
  noContract: number;
  closed60: number;
  wins60: number;
  losses60: number;
  winRate60: number | null;
  totalPnl60: number;
  closedFlat: number;
  winsFlat: number;
  lossesFlat: number;
  winRateFlat: number | null;
  totalPnlFlat: number;
}

export function vwapPaperBuckets(rows: readonly {
  expiryType?: VwapExpiryType | null;
  levelLinedUp?: boolean | null;
  noContract?: boolean;
  status: "open" | "closed";
  exit60?: VwapVariantResult | null;
  exitFlat?: VwapVariantResult | null;
}[]): { byExpiry: VwapPaperBucket[]; byLevel: VwapPaperBucket[] } {
  const expiry = [
    emptyPaperBucket("0DTE", "0DTE"),
    emptyPaperBucket("1DTE", "1DTE"),
    emptyPaperBucket("weekly", "Weekly 7d+"),
  ];
  const level = [
    emptyPaperBucket("lined", "Level lined up"),
    emptyPaperBucket("open", "No level"),
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expiryBucket = expiry.find((bucket) => bucket.key === (row.expiryType ?? ""));
    const levelBucket = row.levelLinedUp ? level[0] : level[1];
    if (expiryBucket) addPaperBucket(expiryBucket, row);
    addPaperBucket(levelBucket, row);
  }
  return { byExpiry: expiry.map(publishPaperBucket), byLevel: level.map(publishPaperBucket) };
}

/** SPY close versus the prior regular close, once 3:00 PM Central has passed. */
export function spySessionDay(bars: readonly CandleBar[], day: string, nowMs: number): SpyDayFlag | null {
  const flatAt = chicagoWallTimeMs(day, 15, 0);
  if (flatAt == null || nowMs < flatAt) return null;
  const prior = previousChicagoTradingDay(day);
  if (!prior) return null;
  const close = lastRthClose(bars, day);
  const prev = lastRthClose(bars, prior);
  if (close == null || prev == null) return null;
  if (close > prev) return "up";
  if (close < prev) return "down";
  return "flat";
}

export function advancePaperRows(
  records: readonly ShadowTrade[],
  optionBars: ReadonlyMap<string, readonly CandleBar[]>,
  spyBars: readonly CandleBar[],
  now: Date,
): { records: ShadowTrade[]; updated: number } {
  let updated = 0;
  const next = records.map((row) => {
    if (row.cohort !== "vwap-put" || row.paperRuleVersion !== VWAP_PAPER_RULE) return row;
    let current = row;
    const day = newYorkDate(new Date(row.signalAt ?? row.openedAt));
    if (row.spyDay == null && day) {
      const flag = spySessionDay(spyBars, day, now.getTime());
      if (flag) {
        current = { ...current, spyDay: flag };
      }
    }
    if (!current.noContract && current.exitFlat == null && current.optionStreamer) {
      const bars = optionBars.get(current.optionStreamer) ?? [];
      const flatAt = vwapSameDayCloseMs(current.entryAt ?? current.openedAt);
      const entryAt = current.entryAt ?? current.openedAt;
      if (flatAt != null && current.entryPrice > 0 && bars.length > 0) {
        const scored = scorePaperExits({
          entryAt,
          entry: current.entryPrice,
          bars,
          now: now.getTime(),
          flatAt,
        });
        const exit60 = current.exit60 ?? scored.exit60;
        const exitFlat = scored.exitFlat;
        if (exit60 !== current.exit60 || exitFlat) {
          current = applyScored(current, exit60, exitFlat);
        }
      }
    }
    if (current !== row) updated += 1;
    return current;
  });
  return { records: updated > 0 ? next : records.slice(), updated };
}

export function paperRowDue(row: ShadowTrade, now: Date): boolean {
  if (row.cohort !== "vwap-put" || row.paperRuleVersion !== VWAP_PAPER_RULE) return false;
  const day = newYorkDate(new Date(row.signalAt ?? row.openedAt));
  const flatAt = day ? chicagoWallTimeMs(day, 15, 0) : null;
  if (row.spyDay == null && flatAt != null && now.getTime() >= flatAt) return true;
  if (row.noContract || row.status !== "open" || !row.optionStreamer) return false;
  return row.exit60 == null || row.exitFlat == null;
}

/** 3:00 PM America/Chicago on the Chicago day the paper put was opened. */
export function vwapSameDayCloseMs(openedAt: number): number | null {
  const day = chicagoDate(new Date(openedAt));
  if (!day) return null;
  return chicagoWallTimeMs(day, 15, 0);
}

function applyScored(
  row: ShadowTrade,
  exit60: VwapVariantResult | null,
  exitFlat: VwapVariantResult | null,
): ShadowTrade {
  const next: ShadowTrade = { ...row, exit60: exit60 ?? row.exit60 ?? null };
  if (!exitFlat) return next;
  const fraction = row.entryPrice > 0 ? exitFlat.pnlDollars / (row.entryPrice * 100) : null;
  return {
    ...next,
    exitFlat,
    status: "closed",
    closedAt: exitFlat.at,
    exitPrice: exitFlat.price,
    exitReason: exitFlat.reason === "profit" ? "profit" : exitFlat.reason === "stop" ? "stop" : "flat",
    exitQuote: null,
    exitStale: false,
    pnlDollars: exitFlat.pnlDollars,
    pnlFraction: fraction,
    tradingDaysHeld: 0,
    lastMark: exitFlat.price,
    lastMarkedAt: exitFlat.at,
  };
}

function resolveExit(
  bars: readonly CandleBar[],
  entryAt: number,
  deadline: number,
  now: number,
  entry: number,
  stop: number,
  target: number,
  timeReason: "time" | "flat",
): VwapVariantResult | null {
  const path = bars.filter((bar) => bar.t >= entryAt && bar.t < deadline);
  for (let i = 0; i < path.length; i++) {
    const hit = bracketHit(path[i], stop, target);
    if (!hit) continue;
    return variant(hit.reason, path[i].t + MINUTE_MS, hit.price, entry);
  }
  if (now < deadline || path.length === 0) return null;
  const last = path[path.length - 1];
  return variant(timeReason, Math.min(deadline, last.t + MINUTE_MS), last.c, entry);
}

function bracketHit(bar: CandleBar, stop: number, target: number): { reason: "profit" | "stop"; price: number } | null {
  const throughStop = bar.o <= stop || bar.l <= stop;
  const throughTarget = bar.o >= target || bar.h >= target;
  if (bar.o <= stop) return { reason: "stop", price: bar.o };
  if (bar.o >= target) return { reason: "profit", price: bar.o };
  if (throughStop && throughTarget) return { reason: "stop", price: stop };
  if (throughStop) return { reason: "stop", price: stop };
  if (throughTarget) return { reason: "profit", price: target };
  return null;
}

function variant(
  reason: VwapVariantResult["reason"],
  at: number,
  price: number,
  entry: number,
): VwapVariantResult {
  return { reason, at, price, pnlDollars: paperPnl(entry, price) };
}

/** Expirations that can be priced. A missing 1DTE or weekly date is left out. */
export function paperExpirations(day: string): { type: VwapExpiryType; expiration: string }[] {
  return expirationPlan(day).filter((item): item is { type: VwapExpiryType; expiration: string } => item != null);
}

function expirationPlan(day: string): ({ type: VwapExpiryType; expiration: string } | null)[] {
  const one = nextTradingDay(day);
  const weekly = weeklyFriday(day);
  return [
    { type: "0DTE", expiration: day },
    one ? { type: "1DTE", expiration: one } : null,
    weekly ? { type: "weekly", expiration: weekly } : null,
  ];
}

function contractRow(signal: VwapPaperSignal, plan: { type: VwapExpiryType; expiration: string }, input: PaperBuildInput): ShadowTrade | null {
  const spot = signal.spot;
  const strikes = input.puts.filter((put) => put.root === signal.root && put.expiration === plan.expiration).map((put) => put.strike);
  if (spot == null || !(spot > 0) || strikes.length === 0) return noContractRow(signal, plan.type, plan.expiration, input.now);
  const picked = selectPut(strikes, spot, (strike) => {
    const symbol = streamerFor(signal.root, plan.expiration, strike);
    return symbol ? optionOpenAt(input.optionBars.get(symbol), signal.entryAt) : null;
  });
  if (!picked) return noContractRow(signal, plan.type, plan.expiration, input.now);
  const streamer = streamerFor(signal.root, plan.expiration, picked.strike);
  return baseRow(signal, plan.type, plan.expiration, input.now, {
    strike: picked.strike,
    entryPrice: picked.premium,
    noContract: false,
    optionStreamer: streamer,
  });
}

function noContractRow(signal: VwapPaperSignal, type: VwapExpiryType, expiration: string, now: Date): ShadowTrade | null {
  return baseRow(signal, type, expiration, now, {
    strike: 0,
    entryPrice: 0,
    noContract: true,
    optionStreamer: null,
  });
}

function baseRow(
  signal: VwapPaperSignal,
  type: VwapExpiryType,
  expiration: string,
  now: Date,
  contract: { strike: number; entryPrice: number; noContract: boolean; optionStreamer: string | null },
): ShadowTrade | null {
  const id = paperId(signal, type);
  if (!ID_PATTERN.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  const openedAt = signal.entryAt;
  return {
    id,
    alertId: id,
    openedAt,
    ticker: signal.ticker,
    putCall: "put",
    strike: contract.noContract ? 0 : contract.strike,
    expiration,
    grade: "test",
    cohort: "vwap-put",
    experimentLabel: VWAP_PUT_TEST.label,
    probeGrade: null,
    contracts: 1,
    entryPrice: contract.noContract ? 0 : contract.entryPrice,
    entryPriceSource: "ask",
    status: contract.noContract ? "closed" : "open",
    closedAt: contract.noContract ? openedAt : null,
    exitPrice: null,
    exitReason: contract.noContract ? "flat" : null,
    exitQuote: null,
    exitStale: false,
    pnlDollars: null,
    pnlFraction: null,
    tradingDaysHeld: contract.noContract ? 0 : null,
    lastMark: null,
    lastMarkSource: null,
    lastMarkedAt: null,
    features: null,
    rulesVersion: null,
    marks: [],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
    paperRuleVersion: VWAP_PAPER_RULE,
    expiryType: type,
    levelLinedUp: signal.levelLinedUp,
    entryWindow: signal.window,
    spyDay: null,
    signalAt: signal.signalAt,
    entryAt: signal.entryAt,
    signalVwap: signal.vwap,
    noContract: contract.noContract,
    optionStreamer: contract.optionStreamer,
    entryUnderlying: signal.spot,
    exit60: null,
    exitFlat: null,
  };
}

function paperId(signal: VwapPaperSignal, type: VwapExpiryType): string {
  const day = signal.sessionDay.replace(/-/g, "");
  const exp = type === "weekly" ? "W7" : type;
  return `vw2-${day}-${signal.ticker}-${exp}`.slice(0, 180);
}

function streamerFor(root: string, expiration: string, strike: number): string | null {
  return tastytradeStreamerSymbol({ ticker: root, expiration, strike, putCall: "put" });
}

function nextTradingDay(ymd: string): string | null {
  const cursor = addCalendarDays(ymd, 1);
  for (let i = 0; i < 10; i++) {
    const day = addCalendarDays(ymd, i + 1);
    if (day < cursor) return null;
    const parts = day.split("-");
    const dow = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
    if (dow !== 0 && dow !== 6 && !isHolidayYmd(day)) return day;
  }
  return null;
}

function isHolidayYmd(ymd: string): boolean {
  const noon = Date.parse(`${ymd}T17:00:00Z`);
  if (!Number.isFinite(noon)) return false;
  return !isMarketDay(new Date(noon));
}

function lastRthClose(bars: readonly CandleBar[], day: string): number | null {
  let close: number | null = null;
  let at = -1;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!usableBar(bar) || newYorkDate(new Date(bar.t)) !== day) continue;
    const minutes = nyMinutes(bar.t);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    if (bar.t >= at) {
      at = bar.t;
      close = bar.c;
    }
  }
  return close;
}

function barWeight(bar: CandleBar): number {
  const volume = bar.v;
  if (volume == null || !Number.isFinite(volume) || volume < 1) return 1;
  return volume;
}

function usableBar(bar: CandleBar): boolean {
  return bar.t > 0
    && Number.isFinite(bar.o) && bar.o > 0
    && Number.isFinite(bar.h) && bar.h > 0
    && Number.isFinite(bar.l) && bar.l > 0
    && Number.isFinite(bar.c) && bar.c > 0
    && bar.h + 1e-9 >= bar.l;
}

interface PaperBucketDraft extends VwapPaperBucket {
  winDollars60: number;
  lossDollars60: number;
  winDollarsFlat: number;
  lossDollarsFlat: number;
}

function emptyPaperBucket(key: string, label: string): PaperBucketDraft {
  return {
    key,
    label,
    trades: 0,
    open: 0,
    noContract: 0,
    closed60: 0,
    wins60: 0,
    losses60: 0,
    winRate60: null,
    totalPnl60: 0,
    closedFlat: 0,
    winsFlat: 0,
    lossesFlat: 0,
    winRateFlat: null,
    totalPnlFlat: 0,
    winDollars60: 0,
    lossDollars60: 0,
    winDollarsFlat: 0,
    lossDollarsFlat: 0,
  };
}

function addPaperBucket(bucket: PaperBucketDraft, row: {
  noContract?: boolean;
  status: "open" | "closed";
  exit60?: VwapVariantResult | null;
  exitFlat?: VwapVariantResult | null;
}): void {
  if (row.noContract) {
    bucket.noContract += 1;
    return;
  }
  bucket.trades += 1;
  if (row.status === "open" && row.exitFlat == null) bucket.open += 1;
  addVariant(bucket, row.exit60, "60");
  addVariant(bucket, row.exitFlat, "flat");
}

function addVariant(bucket: PaperBucketDraft, exit: VwapVariantResult | null | undefined, which: "60" | "flat"): void {
  if (!exit || !Number.isFinite(exit.pnlDollars)) return;
  const pnl = exit.pnlDollars;
  const result = Math.abs(pnl) < TRADE_RULES.flatAbsDollars ? "flat" : pnl > 0 ? "win" : "loss";
  if (which === "60") {
    bucket.closed60 += 1;
    bucket.totalPnl60 += pnl;
    if (result === "win") {
      bucket.wins60 += 1;
      bucket.winDollars60 += pnl;
    } else if (result === "loss") {
      bucket.losses60 += 1;
      bucket.lossDollars60 += Math.abs(pnl);
    }
    const decided = bucket.wins60 + bucket.losses60;
    bucket.winRate60 = decided > 0 ? bucket.wins60 / decided : null;
    return;
  }
  bucket.closedFlat += 1;
  bucket.totalPnlFlat += pnl;
  if (result === "win") {
    bucket.winsFlat += 1;
    bucket.winDollarsFlat += pnl;
  } else if (result === "loss") {
    bucket.lossesFlat += 1;
    bucket.lossDollarsFlat += Math.abs(pnl);
  }
  const decided = bucket.winsFlat + bucket.lossesFlat;
  bucket.winRateFlat = decided > 0 ? bucket.winsFlat / decided : null;
}

function publishPaperBucket(bucket: PaperBucketDraft): VwapPaperBucket {
  return {
    key: bucket.key,
    label: bucket.label,
    trades: bucket.trades,
    open: bucket.open,
    noContract: bucket.noContract,
    closed60: bucket.closed60,
    wins60: bucket.wins60,
    losses60: bucket.losses60,
    winRate60: bucket.winRate60,
    totalPnl60: bucket.totalPnl60,
    closedFlat: bucket.closedFlat,
    winsFlat: bucket.winsFlat,
    lossesFlat: bucket.lossesFlat,
    winRateFlat: bucket.winRateFlat,
    totalPnlFlat: bucket.totalPnlFlat,
  };
}
