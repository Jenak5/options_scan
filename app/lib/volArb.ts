import type { OptionContract, PutCall } from "@/app/lib/contract";

/**
 * Vol arb from a Schwab chain and Schwab daily closes.
 * No network. IV on contracts is a decimal (0.25 = 25%). Readings are percent.
 * This is not a 52-week IV rank — Schwab does not send that history.
 */

export const VOL_DISCLAIMER =
  "Research view only, from Schwab market data. The app does not place orders. Cards are sorted by IV minus 20-day realized vol, cheapest first. CHEAP means ATM implied vol is at least 5 percentage points below that realized vol. RICH means it is at least 8 points above. A small positive gap is normal. This is not a 52-week IV rank.";

export const VOL_DEFINITIONS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "ATM IV (~30d)",
    text: "Schwab implied vol of the at-the-money call and put, averaged, on the expiration closest to 30 days.",
  },
  {
    label: "RV 20d",
    text: "Close-to-close realized vol from the last 20 sessions of Schwab daily prices, annualized with 252 trading days.",
  },
  {
    label: "RV 10d",
    text: "The same realized-vol calculation over the last 10 sessions.",
  },
  {
    label: "IV − RV",
    text: "ATM IV minus RV 20d, in percentage points. Negative means the option market is pricing less movement than the stock just made.",
  },
  {
    label: "Term",
    text: "Later ATM IV minus front ATM IV, in percentage points. The front is the nearest expiration at least 7 days out. Positive means later expirations are richer.",
  },
  {
    label: "Skew",
    text: "Put IV minus call IV, in percentage points, near 25 delta when the chain has it, otherwise about 5% from the stock. Positive means downside options are richer.",
  },
  {
    label: "Cheap / rich strikes",
    text: "Same-expiration contracts whose Schwab IV sits below or above that expiration's ATM IV. A two-sided quote with some open interest or volume is required. Research only.",
  },
];

/** ATM IV at least this far under RV 20d (percentage points) is CHEAP. */
export const CHEAP_SPREAD_POINTS = -5;
/** ATM IV at least this far over RV 20d (percentage points) is RICH. */
export const RICH_SPREAD_POINTS = 8;

const RV_10 = 10;
const RV_20 = 20;
const TRADING_DAYS = 252;
const TARGET_DTE = 30;
const MIN_DTE = 7;
const TERM_BACK_DTE = 60;
/** Ignore a Schwab IV above 500%. The chain field is a decimal. */
const MAX_IV_DECIMAL = 5;
const NOTABLE_CHEAP_POINTS = -4;
const NOTABLE_RICH_POINTS = 6;
const NOTABLE_LIMIT = 4;
/** Display filter only. Not the trade gate. */
const NOTABLE_MIN_OPEN_INTEREST = 50;
const NOTABLE_MIN_VOLUME = 10;
const NOTABLE_MAX_SPREAD_OF_MID = 0.5;

export type VolSignal = "CHEAP" | "RICH" | "NEUTRAL" | "NO_READ";
export type VolStatus = "ok" | "delayed" | "missing";
export type SkewMethod = "25-delta" | "otm";

export interface NotableContract {
  expiration: string;
  strike: number;
  putCall: PutCall;
  /** Percent. */
  ivPercent: number;
  /** This contract's IV minus the expiration's ATM IV, percentage points. */
  versusAtm: number;
  label: "CHEAP" | "RICH";
}

export interface VolArbReading {
  symbol: string;
  status: VolStatus;
  message: string | null;
  underlyingPrice: number | null;
  /** Percent. */
  atmIv30: number | null;
  atmExpiration: string | null;
  atmDte: number | null;
  /** Percent. */
  rv20: number | null;
  /** Percent. */
  rv10: number | null;
  /** atmIv30 − rv20, percentage points. */
  ivRvSpread: number | null;
  /** Back ATM IV minus front ATM IV, percentage points. */
  termSlope: number | null;
  frontExpiration: string | null;
  frontDte: number | null;
  frontAtmIv: number | null;
  backExpiration: string | null;
  backDte: number | null;
  backAtmIv: number | null;
  /** Put IV minus call IV, percentage points. */
  skew: number | null;
  skewMethod: SkewMethod | null;
  skewPutStrike: number | null;
  skewCallStrike: number | null;
  skewPutIv: number | null;
  skewCallIv: number | null;
  signal: VolSignal;
  signalNote: string;
  notable: NotableContract[];
}

export interface VolArbInput {
  symbol: string;
  /** Calendar date YYYY-MM-DD. DTE is measured from this date. */
  asOf: string;
  underlyingPrice: number | null;
  delayed: boolean;
  contracts: OptionContract[];
  /** Daily closes, oldest first. */
  closes: number[];
  /** True when the price-history request failed and closes is empty because of that. */
  priceHistoryFailed?: boolean;
}

export function signalFromSpread(spread: number | null): VolSignal {
  if (spread == null || !Number.isFinite(spread)) return "NO_READ";
  if (spread <= CHEAP_SPREAD_POINTS) return "CHEAP";
  if (spread >= RICH_SPREAD_POINTS) return "RICH";
  return "NEUTRAL";
}

/**
 * Close-to-close realized vol, in percent.
 * Uses the last `window` log returns and the sample standard deviation (n − 1),
 * then annualizes with 252 trading days.
 */
export function realizedVol(closes: number[], window: number, tradingDays: number = TRADING_DAYS): number | null {
  if (!Number.isInteger(window) || window < 2) return null;
  if (!Number.isFinite(tradingDays) || tradingDays <= 0) return null;
  if (closes.length < window + 1) return null;
  const slice = closes.slice(closes.length - (window + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const next = slice[i];
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) return null;
    returns.push(Math.log(next / prev));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const square = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const variance = square / (returns.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return null;
  return Math.sqrt(variance) * Math.sqrt(tradingDays) * 100;
}

/** One alert line. Same signal and numbers as the Vol Arb tab. */
export function formatVolArbSummary(reading: VolArbReading): string {
  if (reading.atmIv30 == null || reading.rv20 == null || reading.ivRvSpread == null || reading.signal === "NO_READ") {
    return reading.message ?? "Schwab did not return ATM IV and 20-day realized vol.";
  }
  const spread = `${reading.ivRvSpread > 0 ? "+" : ""}${reading.ivRvSpread.toFixed(1)}`;
  return `${reading.signal} — ATM IV ${reading.atmIv30.toFixed(1)}% vs RV 20d ${reading.rv20.toFixed(1)}% (${spread})`;
}

export function compareVolReadings(a: VolArbReading, b: VolArbReading): number {
  if (a.ivRvSpread == null && b.ivRvSpread == null) return a.symbol.localeCompare(b.symbol);
  if (a.ivRvSpread == null) return 1;
  if (b.ivRvSpread == null) return -1;
  if (a.ivRvSpread !== b.ivRvSpread) return a.ivRvSpread - b.ivRvSpread;
  return a.symbol.localeCompare(b.symbol);
}

export function buildVolArbReading(input: VolArbInput): VolArbReading {
  const symbol = input.symbol.trim().toUpperCase();
  const spot = input.underlyingPrice != null && input.underlyingPrice > 0 ? input.underlyingPrice : null;
  if (input.delayed) {
    return emptyReading(symbol, null, {
      status: "delayed",
      message: "Schwab marked this chain delayed. Real-time implied vol is required, so these numbers are withheld.",
    });
  }
  if (!symbol) {
    return emptyReading("", null, { status: "missing", message: "Enter a ticker." });
  }

  const groups = expirationSlices(input.contracts, input.asOf, spot);
  const mature = groups.filter((group) => group.atmIv != null && group.dte >= MIN_DTE);
  const any = groups.filter((group) => group.atmIv != null && group.dte >= 0);
  const target = closestDte(mature, TARGET_DTE) ?? closestDte(any, TARGET_DTE);
  const front = mature.slice().sort((a, b) => a.dte - b.dte)[0] ?? any.slice().sort((a, b) => a.dte - b.dte)[0] ?? null;
  const later = front ? mature.filter((group) => group.dte > front.dte) : [];
  const back = closestDte(later, TERM_BACK_DTE);
  const skew = target ? skewQuote(target.contracts, spot) : null;
  const rv20Raw = realizedVol(input.closes, RV_20);
  const rv10Raw = realizedVol(input.closes, RV_10);
  const atmIv30 = target?.atmIv ?? null;
  const rv20 = rv20Raw == null ? null : round1(rv20Raw);
  const rv10 = rv10Raw == null ? null : round1(rv10Raw);
  const ivRvSpread = atmIv30 != null && rv20 != null ? round1(atmIv30 - rv20) : null;
  const termSlope = front?.atmIv != null && back?.atmIv != null ? round1(back.atmIv - front.atmIv) : null;
  const signal = signalFromSpread(ivRvSpread);
  const notable = target?.atmIv != null && target.atmStrike != null
    ? notableContracts(target.contracts, target.expiration, target.atmIv, target.atmStrike)
    : [];

  let status: VolStatus = "ok";
  let message: string | null = null;
  if (atmIv30 == null && rv20 == null) {
    status = "missing";
    message = "Schwab did not return implied vol or enough daily prices for this symbol.";
  } else if (atmIv30 == null) {
    status = "missing";
    message = "Schwab chain had no usable at-the-money implied vol. Realized vol is from Schwab daily prices.";
  } else if (rv20 == null) {
    status = "missing";
    message = input.priceHistoryFailed
      ? "Schwab daily prices did not load, so realized vol is missing. Implied vol is from the chain."
      : "Not enough Schwab daily prices to compute 20-day realized vol. Implied vol is from the chain.";
  }

  const signalNote = status === "ok" && ivRvSpread != null
    ? describeSignal(signal, ivRvSpread)
    : (message ?? "No vol reading.");

  return {
    symbol,
    status,
    message,
    underlyingPrice: spot,
    atmIv30,
    atmExpiration: target?.expiration ?? null,
    atmDte: target?.dte ?? null,
    rv20,
    rv10,
    ivRvSpread,
    termSlope,
    frontExpiration: front?.expiration ?? null,
    frontDte: front?.dte ?? null,
    frontAtmIv: front?.atmIv ?? null,
    backExpiration: back?.expiration ?? null,
    backDte: back?.dte ?? null,
    backAtmIv: back?.atmIv ?? null,
    skew: skew ? round1(skew.skew) : null,
    skewMethod: skew?.method ?? null,
    skewPutStrike: skew?.putStrike ?? null,
    skewCallStrike: skew?.callStrike ?? null,
    skewPutIv: skew ? round1(skew.putIv) : null,
    skewCallIv: skew ? round1(skew.callIv) : null,
    signal: status === "ok" ? signal : "NO_READ",
    signalNote,
    notable,
  };
}

function describeSignal(signal: VolSignal, spread: number): string {
  const gap = Math.abs(spread).toFixed(1);
  if (signal === "CHEAP") {
    return `ATM implied vol is ${gap} points below 20-day realized vol. Long premium is priced under recent movement. Research only.`;
  }
  if (signal === "RICH") {
    return `ATM implied vol is ${gap} points above 20-day realized vol. Long premium is priced over recent movement. Research only.`;
  }
  return "ATM implied vol is close to 20-day realized vol. No cheap or rich reading versus recent movement.";
}

interface ExpirationSlice {
  expiration: string;
  dte: number;
  atmIv: number | null;
  atmStrike: number | null;
  contracts: OptionContract[];
}

function expirationSlices(contracts: OptionContract[], asOf: string, spot: number | null): ExpirationSlice[] {
  const byExpiration = new Map<string, OptionContract[]>();
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    if (!usableContract(contract)) continue;
    const list = byExpiration.get(contract.expiration);
    if (list) list.push(contract);
    else byExpiration.set(contract.expiration, [contract]);
  }
  const groups: ExpirationSlice[] = [];
  byExpiration.forEach((list, expiration) => {
    const dte = calendarDte(asOf, expiration);
    if (dte == null) return;
    const atm = atmQuote(list, spot);
    groups.push({
      expiration,
      dte,
      atmIv: atm?.iv ?? null,
      atmStrike: atm?.strike ?? null,
      contracts: list,
    });
  });
  groups.sort((a, b) => a.dte - b.dte);
  return groups;
}

function atmQuote(list: OptionContract[], spot: number | null): { iv: number; strike: number } | null {
  let strike: number | null = null;
  if (spot != null) {
    strike = closestStrike(list, spot);
  } else {
    const calls = list.filter((contract) => contract.putCall === "call" && contract.delta != null && Number.isFinite(contract.delta));
    if (calls.length === 0) return null;
    let best = calls[0];
    for (let i = 1; i < calls.length; i++) {
      if (Math.abs((calls[i].delta ?? 0) - 0.5) < Math.abs((best.delta ?? 0) - 0.5)) best = calls[i];
    }
    strike = best.strike;
  }
  if (strike == null) return null;
  const sides = dedupeSides(list.filter((contract) => contract.strike === strike));
  if (sides.length === 0) return null;
  return { iv: round1(sides.reduce((sum, value) => sum + value, 0) / sides.length), strike };
}

/** Average one IV per side so a duplicated Schwab row does not weigh that side twice. */
function dedupeSides(atStrike: OptionContract[]): number[] {
  const call = atStrike.find((contract) => contract.putCall === "call" && contract.iv != null && usableIv(contract.iv));
  const put = atStrike.find((contract) => contract.putCall === "put" && contract.iv != null && usableIv(contract.iv));
  const sides: number[] = [];
  if (call?.iv != null) sides.push(percent(call.iv));
  if (put?.iv != null) sides.push(percent(put.iv));
  return sides;
}

interface SkewQuote {
  skew: number;
  method: SkewMethod;
  putStrike: number;
  callStrike: number;
  putIv: number;
  callIv: number;
}

function skewQuote(list: OptionContract[], spot: number | null): SkewQuote | null {
  const putDelta = nearestDelta(list, "put", -0.25, -0.4, -0.15);
  const callDelta = nearestDelta(list, "call", 0.25, 0.15, 0.4);
  if (putDelta?.iv != null && callDelta?.iv != null) {
    return quoteSkew(putDelta, callDelta, "25-delta");
  }
  if (spot == null) return null;
  const puts = list.filter((contract) => contract.putCall === "put" && contract.strike <= spot * 0.98);
  const calls = list.filter((contract) => contract.putCall === "call" && contract.strike >= spot * 1.02);
  const put = closestToStrike(puts, spot * 0.95);
  const call = closestToStrike(calls, spot * 1.05);
  if (!put?.iv || !call?.iv) return null;
  return quoteSkew(put, call, "otm");
}

function quoteSkew(put: OptionContract, call: OptionContract, method: SkewMethod): SkewQuote | null {
  if (put.iv == null || call.iv == null) return null;
  return {
    skew: percent(put.iv) - percent(call.iv),
    method,
    putStrike: put.strike,
    callStrike: call.strike,
    putIv: percent(put.iv),
    callIv: percent(call.iv),
  };
}

function nearestDelta(
  list: OptionContract[],
  putCall: PutCall,
  target: number,
  lo: number,
  hi: number,
): OptionContract | null {
  let best: OptionContract | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    const contract = list[i];
    if (contract.putCall !== putCall) continue;
    if (contract.delta == null || !Number.isFinite(contract.delta)) continue;
    if (contract.delta < lo || contract.delta > hi) continue;
    const dist = Math.abs(contract.delta - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = contract;
    }
  }
  return best;
}

function notableContracts(
  list: OptionContract[],
  expiration: string,
  atmIv: number,
  atmStrike: number,
): NotableContract[] {
  const rows: NotableContract[] = [];
  for (let i = 0; i < list.length; i++) {
    const contract = list[i];
    if (contract.expiration !== expiration || contract.strike === atmStrike) continue;
    if (contract.iv == null || !usableIv(contract.iv) || !liquidEnough(contract)) continue;
    const ivPercent = percent(contract.iv);
    const versusAtm = round1(ivPercent - atmIv);
    if (versusAtm <= NOTABLE_CHEAP_POINTS) {
      rows.push({ expiration, strike: contract.strike, putCall: contract.putCall, ivPercent, versusAtm, label: "CHEAP" });
    } else if (versusAtm >= NOTABLE_RICH_POINTS) {
      rows.push({ expiration, strike: contract.strike, putCall: contract.putCall, ivPercent, versusAtm, label: "RICH" });
    }
  }
  rows.sort((a, b) => {
    const gap = Math.abs(b.versusAtm) - Math.abs(a.versusAtm);
    if (gap !== 0) return gap;
    if (a.strike !== b.strike) return a.strike - b.strike;
    return a.putCall.localeCompare(b.putCall);
  });
  return rows.slice(0, NOTABLE_LIMIT);
}

function liquidEnough(contract: OptionContract): boolean {
  const openInterest = Number.isFinite(contract.openInterest) ? contract.openInterest : 0;
  const volume = Number.isFinite(contract.volume) ? contract.volume : 0;
  if (openInterest < NOTABLE_MIN_OPEN_INTEREST && volume < NOTABLE_MIN_VOLUME) return false;
  if (!(contract.bid > 0) || !(contract.ask > 0) || contract.ask < contract.bid) return false;
  const mid = (contract.bid + contract.ask) / 2;
  if (!(mid > 0)) return false;
  return (contract.ask - contract.bid) / mid <= NOTABLE_MAX_SPREAD_OF_MID;
}

function closestDte(pool: ExpirationSlice[], target: number): ExpirationSlice | null {
  if (pool.length === 0) return null;
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    const dist = Math.abs(pool[i].dte - target);
    const bestDist = Math.abs(best.dte - target);
    if (dist < bestDist || (dist === bestDist && pool[i].dte < best.dte)) best = pool[i];
  }
  return best;
}

function closestStrike(list: OptionContract[], spot: number): number | null {
  const found = closestToStrike(list, spot);
  return found ? found.strike : null;
}

function closestToStrike(list: OptionContract[], target: number): OptionContract | null {
  let best: OptionContract | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    const dist = Math.abs(list[i].strike - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = list[i];
    }
  }
  return best;
}

function usableContract(contract: OptionContract): boolean {
  if (!(contract.strike > 0) || !contract.expiration) return false;
  if (contract.putCall !== "call" && contract.putCall !== "put") return false;
  return contract.iv != null && usableIv(contract.iv);
}

function usableIv(iv: number): boolean {
  return Number.isFinite(iv) && iv > 0 && iv <= MAX_IV_DECIMAL;
}

function calendarDte(asOf: string, expiration: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  const from = Date.parse(`${asOf}T00:00:00Z`);
  const to = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** One decimal. The card and the cheap/rich rule use the same rounded number. */
function percent(decimal: number): number {
  return round1(decimal * 100);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function emptyReading(
  symbol: string,
  underlyingPrice: number | null,
  input: { status: VolStatus; message: string },
): VolArbReading {
  return {
    symbol,
    status: input.status,
    message: input.message,
    underlyingPrice,
    atmIv30: null,
    atmExpiration: null,
    atmDte: null,
    rv20: null,
    rv10: null,
    ivRvSpread: null,
    termSlope: null,
    frontExpiration: null,
    frontDte: null,
    frontAtmIv: null,
    backExpiration: null,
    backDte: null,
    backAtmIv: null,
    skew: null,
    skewMethod: null,
    skewPutStrike: null,
    skewCallStrike: null,
    skewPutIv: null,
    skewCallIv: null,
    signal: "NO_READ",
    signalNote: input.message,
    notable: [],
  };
}
