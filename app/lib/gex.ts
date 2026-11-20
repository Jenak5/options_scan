import { isMarketDay, isNewYorkMinuteWindow } from "@/app/lib/marketHours";

/**
 * Gamma exposure from a Tastytrade chain.
 * Per contract: gamma × open interest × 100 × spot² × 0.01.
 * Calls add. Puts subtract. This is the dealer convention in gex.py.
 * A missing input stays null. Nothing here is filled in.
 */

export const GEX_UNDERLYINGS = ["QQQ", "SPY"] as const;
export type GexUnderlying = (typeof GEX_UNDERLYINGS)[number];

/** Strikes farther than this fraction from spot are left out. Same band as gex.py. */
export const GEX_STRIKE_BAND = 0.12;
export const GEX_MAX_DTE = 45;
/** Spot grid from 90% to 110% of spot. Same count as gex.py. */
export const GEX_GRID_POINTS = 401;

/**
 * 9:05 AM America/New_York is 8:05 AM Chicago.
 * The second window continues a pass that hit the time budget.
 * Each window is a few minutes wide. Vercel fires both UTC twins.
 */
export const GEX_COLLECT_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60 + 5, 9 * 60 + 10],
  [9 * 60 + 15, 9 * 60 + 20],
];

const ROW_CAP = 800;

export interface GexContract {
  expiration: string;
  dte: number;
  strike: number;
  putCall: "call" | "put";
  gamma: number | null;
  /** Decimal. 0.2 means 20%. */
  iv: number | null;
  openInterest: number | null;
}

export interface GexRow {
  date: string;
  runTimeCt: string | null;
  underlying: GexUnderlying;
  spot: number | null;
  dataTimestamp: string | null;
  totalGex: number | null;
  flip: number | null;
  flipFutures: number | null;
  callWall1: number | null;
  callWall2: number | null;
  callWall3: number | null;
  callWall1Futures: number | null;
  callWall2Futures: number | null;
  callWall3Futures: number | null;
  putWall1: number | null;
  putWall2: number | null;
  putWall3: number | null;
  putWall1Futures: number | null;
  putWall2Futures: number | null;
  putWall3Futures: number | null;
  nearExpiry: string | null;
  nearGex: number | null;
  nearFlip: number | null;
  nearFlipFutures: number | null;
  futuresSymbol: string | null;
  futuresPrice: number | null;
  ratio: number | null;
  gammaCoverage: number | null;
  source: string | null;
}

export function gexCronDecision(now: Date, manual: boolean): { run: boolean; reason: string | null } {
  if (!isMarketDay(now)) return { run: false, reason: "market holiday" };
  if (manual) return { run: true, reason: null };
  for (let i = 0; i < GEX_COLLECT_WINDOWS.length; i++) {
    const window = GEX_COLLECT_WINDOWS[i];
    if (isNewYorkMinuteWindow(now, window[0], window[1])) return { run: true, reason: null };
  }
  return { run: false, reason: "Outside the 8:05am America/Chicago gamma window" };
}

/** gamma × open interest × 100 × spot² × 0.01, with the call/put sign. */
export function contractGex(input: { gamma: number; openInterest: number; spot: number; putCall: "call" | "put" }): number | null {
  const { gamma, openInterest, spot, putCall } = input;
  if (!Number.isFinite(gamma) || !Number.isFinite(openInterest) || !Number.isFinite(spot) || !(spot > 0)) return null;
  if (openInterest < 0) return null;
  const sign = putCall === "call" ? 1 : putCall === "put" ? -1 : null;
  if (sign == null) return null;
  return sign * gamma * openInterest * 100 * spot * spot * 0.01;
}

/**
 * Black-Scholes gamma. Time is floored at a quarter day, matching gex.py.
 * Spot, strike, and iv must be positive.
 */
export function bsGamma(spot: number, strike: number, iv: number, tYears: number): number | null {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !Number.isFinite(tYears)) return null;
  const t = Math.max(tYears, 0.25 / 365);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * t) / (iv * sqrtT);
  const gamma = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI) / (spot * iv * sqrtT);
  return Number.isFinite(gamma) ? gamma : null;
}

export interface GexLevels {
  totalGex: number | null;
  flip: number | null;
  callWalls: Array<number | null>;
  putWalls: Array<number | null>;
  nearExpiry: string | null;
  nearGex: number | null;
  nearFlip: number | null;
  used: number;
  inBand: number;
  gammaCoverage: number | null;
}

/**
 * Levels for one underlying. Contracts outside 0–45 DTE or the 12% band are ignored.
 * Walls are strikes: calls by the largest (most positive) gamma, puts by the most negative.
 * The flip is the zero crossing of the repriced book nearest spot.
 */
export function computeGexLevels(input: {
  spot: number;
  contracts: readonly GexContract[];
}): GexLevels {
  const spot = input.spot;
  const empty: GexLevels = {
    totalGex: null,
    flip: null,
    callWalls: [null, null, null],
    putWalls: [null, null, null],
    nearExpiry: null,
    nearGex: null,
    nearFlip: null,
    used: 0,
    inBand: 0,
    gammaCoverage: null,
  };
  if (!(spot > 0) || !Number.isFinite(spot)) return empty;
  const band = input.contracts.filter((contract) => inGexWindow(contract, spot));
  const usable = band.filter((contract) => contractGex({
    gamma: contract.gamma ?? Number.NaN,
    openInterest: contract.openInterest ?? Number.NaN,
    spot,
    putCall: contract.putCall,
  }) != null);
  const withGex = usable.map((contract) => ({
    ...contract,
    gex: contractGex({
      gamma: contract.gamma as number,
      openInterest: contract.openInterest as number,
      spot,
      putCall: contract.putCall,
    }) as number,
  }));
  if (band.length === 0) return empty;
  const coverage = (withGex.length / band.length) * 100;
  if (withGex.length === 0) {
    return { ...empty, inBand: band.length, gammaCoverage: coverage };
  }
  const all = levelSide(withGex, spot);
  const nearExpiry = withGex.reduce((min, contract) => contract.expiration < min ? contract.expiration : min, withGex[0].expiration);
  const near = levelSide(withGex.filter((contract) => contract.expiration === nearExpiry), spot);
  return {
    totalGex: all.total,
    flip: all.flip,
    callWalls: pad3(all.callWalls),
    putWalls: pad3(all.putWalls),
    nearExpiry,
    nearGex: near.total,
    nearFlip: near.flip,
    used: withGex.length,
    inBand: band.length,
    gammaCoverage: coverage,
  };
}

export function futuresPrice(level: number | null, ratio: number | null): number | null {
  if (level == null || ratio == null || !Number.isFinite(level) || !Number.isFinite(ratio) || !(ratio > 0) || !(level > 0)) return null;
  return pythonRound(level * ratio, 2);
}

export function inGexWindow(contract: { strike: number; dte: number }, spot: number): boolean {
  if (!(contract.strike > 0) || !(spot > 0)) return false;
  if (!Number.isFinite(contract.dte) || contract.dte < 0 || contract.dte > GEX_MAX_DTE) return false;
  return Math.abs(contract.strike / spot - 1) <= GEX_STRIKE_BAND;
}

/** Replace the row with the same date and underlying. Newest date first. */
export function upsertGexRow(rows: readonly GexRow[], next: GexRow): GexRow[] {
  const kept = rows.filter((row) => !(row.date === next.date && row.underlying === next.underlying));
  kept.push(next);
  kept.sort((a, b) => b.date.localeCompare(a.date) || a.underlying.localeCompare(b.underlying));
  return kept.slice(0, ROW_CAP);
}

/** A stored row wins. The seed fills only a missing date and underlying. */
export function mergeGexSeed(stored: readonly GexRow[], seed: readonly GexRow[]): GexRow[] {
  const out = stored.slice();
  for (let i = 0; i < seed.length; i++) {
    const row = seed[i];
    if (out.some((item) => item.date === row.date && item.underlying === row.underlying)) continue;
    out.push(row);
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || a.underlying.localeCompare(b.underlying));
  return out;
}

export interface GexBook {
  version: 1;
  rows: GexRow[];
  pending: GexUnderlying | null;
  lockUntil: number | null;
}

export function emptyGexBook(): GexBook {
  return { version: 1, rows: [], pending: null, lockUntil: null };
}

export function parseGexBook(text: string | null): GexBook | null {
  if (text == null || text.trim() === "") return emptyGexBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.rows)) return null;
  const rows: GexRow[] = [];
  for (let i = 0; i < record.rows.length; i++) {
    const row = parseGexRow(record.rows[i]);
    if (row) rows.push(row);
  }
  const pending = record.pending === "QQQ" || record.pending === "SPY" ? record.pending : null;
  const lockUntil = typeof record.lockUntil === "number" && Number.isFinite(record.lockUntil) ? record.lockUntil : null;
  return { version: 1, rows, pending, lockUntil };
}

export function formatGex(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function formatGexPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatGexCoverage(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export interface GexChartPoint {
  date: string;
  spot: number | null;
  flip: number | null;
  callWall1: number | null;
  putWall1: number | null;
}

/** Oldest first. A missing level stays null. */
export function gexChartSeries(rows: readonly GexRow[], underlying: GexUnderlying): GexChartPoint[] {
  return rows
    .filter((row) => row.underlying === underlying)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => ({
      date: row.date,
      spot: row.spot,
      flip: row.flip,
      callWall1: row.callWall1,
      putWall1: row.putWall1,
    }));
}

function levelSide(contracts: ReadonlyArray<GexContract & { gex: number }>, spot: number): {
  total: number;
  flip: number | null;
  callWalls: number[];
  putWalls: number[];
} {
  let total = 0;
  const calls = new Map<number, number>();
  const puts = new Map<number, number>();
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    total += contract.gex;
    const book = contract.putCall === "call" ? calls : puts;
    book.set(contract.strike, (book.get(contract.strike) ?? 0) + contract.gex);
  }
  return {
    total,
    flip: flipFromBook(contracts, spot),
    callWalls: topStrikes(calls, "call"),
    putWalls: topStrikes(puts, "put"),
  };
}

function topStrikes(book: Map<number, number>, side: "call" | "put"): number[] {
  const entries = Array.from(book.entries());
  entries.sort((a, b) => side === "call" ? b[1] - a[1] || a[0] - b[0] : a[1] - b[1] || a[0] - b[0]);
  return entries.slice(0, 3).map((entry) => entry[0]);
}

function flipFromBook(contracts: ReadonlyArray<GexContract & { gex: number }>, spot: number): number | null {
  const ok = contracts.filter((contract) => contract.iv != null && contract.iv > 0 && contract.openInterest != null && contract.openInterest >= 0);
  if (ok.length === 0) return null;
  const grid = linspace(spot * 0.9, spot * 1.1, GEX_GRID_POINTS);
  const profile = grid.map((price) => profileAt(ok, price));
  const crossings: number[] = [];
  for (let i = 0; i + 1 < profile.length; i++) {
    if (Math.sign(profile[i]) !== Math.sign(profile[i + 1])) crossings.push(i);
  }
  if (crossings.length === 0) return null;
  let best = crossings[0];
  let bestDistance = Math.abs(grid[best] - spot);
  for (let i = 1; i < crossings.length; i++) {
    const distance = Math.abs(grid[crossings[i]] - spot);
    if (distance < bestDistance) {
      best = crossings[i];
      bestDistance = distance;
    }
  }
  const left = profile[best];
  const right = profile[best + 1];
  if (right === left) return grid[best];
  return grid[best] - left * (grid[best + 1] - grid[best]) / (right - left);
}

function profileAt(contracts: ReadonlyArray<GexContract & { gex: number }>, price: number): number {
  let total = 0;
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const iv = contract.iv as number;
    const oi = contract.openInterest as number;
    const gamma = bsGamma(price, contract.strike, iv, Math.max(contract.dte, 0) / 365);
    if (gamma == null) continue;
    const sign = contract.putCall === "call" ? 1 : -1;
    total += sign * gamma * oi * 100 * price * price * 0.01;
  }
  return total;
}

function linspace(start: number, end: number, count: number): number[] {
  if (count <= 1) return [start];
  const out: number[] = [];
  const step = (end - start) / (count - 1);
  for (let i = 0; i < count; i++) out.push(start + step * i);
  return out;
}

function pad3(values: number[]): Array<number | null> {
  return [values[0] ?? null, values[1] ?? null, values[2] ?? null];
}

/** Python 3 round: halves go to the even digit. Prices here are positive. */
function pythonRound(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-8) {
    const even = floor % 2 === 0 ? floor : floor + 1;
    return even / factor;
  }
  return Math.round(scaled) / factor;
}

function parseGexRow(value: unknown): GexRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  if (row.underlying !== "QQQ" && row.underlying !== "SPY") return null;
  return {
    date: row.date,
    runTimeCt: textOrNull(row.runTimeCt),
    underlying: row.underlying,
    spot: numOrNull(row.spot),
    dataTimestamp: textOrNull(row.dataTimestamp),
    totalGex: numOrNull(row.totalGex),
    flip: numOrNull(row.flip),
    flipFutures: numOrNull(row.flipFutures),
    callWall1: numOrNull(row.callWall1),
    callWall2: numOrNull(row.callWall2),
    callWall3: numOrNull(row.callWall3),
    callWall1Futures: numOrNull(row.callWall1Futures),
    callWall2Futures: numOrNull(row.callWall2Futures),
    callWall3Futures: numOrNull(row.callWall3Futures),
    putWall1: numOrNull(row.putWall1),
    putWall2: numOrNull(row.putWall2),
    putWall3: numOrNull(row.putWall3),
    putWall1Futures: numOrNull(row.putWall1Futures),
    putWall2Futures: numOrNull(row.putWall2Futures),
    putWall3Futures: numOrNull(row.putWall3Futures),
    nearExpiry: textOrNull(row.nearExpiry),
    nearGex: numOrNull(row.nearGex),
    nearFlip: numOrNull(row.nearFlip),
    nearFlipFutures: numOrNull(row.nearFlipFutures),
    futuresSymbol: textOrNull(row.futuresSymbol),
    futuresPrice: numOrNull(row.futuresPrice),
    ratio: numOrNull(row.ratio),
    gammaCoverage: numOrNull(row.gammaCoverage),
    source: textOrNull(row.source),
  };
}

function numOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}
