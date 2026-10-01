import { LEVEL_RULES } from "@/app/lib/alertConfig";
import type { PutCall } from "@/app/lib/contract";
import type { PriceCandle } from "@/app/lib/schwabParse";

/**
 * Support and resistance from candles and the option chain already in hand.
 * No network. A missing history does not invent levels from round numbers alone.
 * VWAP uses the candle typical price, because the history payload has no ticks.
 */

export interface LevelPoint {
  price: number;
  label: string;
  /** Fraction of the underlying. 0.01 means 1% away. */
  distance: number;
}

export interface KeyLevels {
  checked: boolean;
  spot: number | null;
  support: LevelPoint | null;
  resistance: LevelPoint | null;
  vwap: number | null;
  priorClose: number | null;
  callWall: number | null;
  putWall: number | null;
}

/** Compact snapshot stored on a sent alert. */
export interface StoredPriceLevels {
  supportPrice: number;
  supportLabel: string;
  supportDistance: number;
  resistancePrice: number;
  resistanceLabel: string;
  resistanceDistance: number;
}

export interface WallContract {
  strike: number;
  putCall: PutCall;
  openInterest: number;
}

interface Candidate {
  price: number;
  label: string;
  source: "history" | "wall" | "round";
}

const SOURCE_RANK: Record<Candidate["source"], number> = {
  history: 0,
  wall: 1,
  round: 2,
};

const RTH_OPEN_MINUTES = 9 * 60 + 30;
const RTH_CLOSE_MINUTES = 16 * 60;

export function emptyLevels(spot: number | null = null): KeyLevels {
  return {
    checked: false,
    spot: spot != null && spot > 0 ? spot : null,
    support: null,
    resistance: null,
    vwap: null,
    priorClose: null,
    callWall: null,
    putWall: null,
  };
}

export function computeKeyLevels(input: {
  spot: number | null;
  daily: PriceCandle[];
  intraday: PriceCandle[];
  now: Date;
  contracts?: WallContract[];
}): KeyLevels {
  const spot = input.spot != null && input.spot > 0 && Number.isFinite(input.spot) ? input.spot : null;
  const base = emptyLevels(spot);
  if (spot == null) return base;

  const today = newYorkDate(input.now);
  const daily = sortedCandles(input.daily);
  const intraday = sortedCandles(input.intraday);
  const prior = priorDay(daily, today);
  const todayParts = splitSession(intraday, today);
  const swings = swingPoints(daily.filter((candle) => newYorkDate(new Date(candle.datetime)) <= today));

  const candidates: Candidate[] = [];
  if (prior) {
    push(candidates, prior.low, "prior day low");
    push(candidates, prior.high, "prior day high");
    push(candidates, prior.close, "prior close");
    base.priorClose = prior.close;
  }
  const preHigh = extreme(todayParts.premarket, "high");
  const preLow = extreme(todayParts.premarket, "low");
  push(candidates, preLow, "pre-market low");
  push(candidates, preHigh, "pre-market high");

  const open = todayParts.regular[0]?.open;
  push(candidates, open, "open");
  const openRange = todayParts.regular.filter((candle) => {
    return nyMinutes(candle.datetime) < RTH_OPEN_MINUTES + LEVEL_RULES.openRangeMinutes;
  });
  push(candidates, extreme(openRange, "low"), "open range low");
  push(candidates, extreme(openRange, "high"), "open range high");
  push(candidates, extreme(todayParts.regular, "low"), "session low");
  push(candidates, extreme(todayParts.regular, "high"), "session high");

  const vwapSource = todayParts.regular.length > 0 ? todayParts.regular : todayParts.premarket;
  const vwap = typicalVwap(vwapSource);
  base.vwap = vwap;
  push(candidates, vwap, "VWAP");

  for (let i = 0; i < swings.lows.length; i++) push(candidates, swings.lows[i], "swing low");
  for (let i = 0; i < swings.highs.length; i++) push(candidates, swings.highs[i], "swing high");

  const historyCount = candidates.length;
  const walls = optionWalls(input.contracts ?? [], spot);
  base.callWall = walls.call;
  base.putWall = walls.put;
  push(candidates, walls.put, "put wall", "wall");
  push(candidates, walls.call, "call wall", "wall");

  const step = roundStep(spot);
  const belowRound = Math.floor((spot - step * 1e-9) / step) * step;
  const aboveRound = Math.ceil((spot + step * 1e-9) / step) * step;
  push(candidates, roundCents(belowRound), "round number", "round");
  push(candidates, roundCents(aboveRound), "round number", "round");

  const unique = dedupe(candidates);
  let support: Candidate | null = null;
  let resistance: Candidate | null = null;
  for (let i = 0; i < unique.length; i++) {
    const level = unique[i];
    if (!(level.price > 0)) continue;
    if (level.price < spot) {
      if (!support || level.price > support.price) support = level;
    } else if (level.price > spot) {
      if (!resistance || level.price < resistance.price) resistance = level;
    }
  }

  const checked = historyCount > 0 && support != null && resistance != null;
  return {
    ...base,
    checked,
    support: support ? point(support, spot) : null,
    resistance: resistance ? point(resistance, spot) : null,
  };
}

export function toStoredLevels(levels: KeyLevels | null | undefined): StoredPriceLevels | null {
  if (!levels?.checked || !levels.support || !levels.resistance) return null;
  return {
    supportPrice: levels.support.price,
    supportLabel: levels.support.label,
    supportDistance: levels.support.distance,
    resistancePrice: levels.resistance.price,
    resistanceLabel: levels.resistance.label,
    resistanceDistance: levels.resistance.distance,
  };
}

export function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

export function formatLevelDistance(distance: number): string {
  const pct = distance * 100;
  if (!Number.isFinite(pct)) return "an unknown distance";
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

export function formatLevelsSummary(levels: StoredPriceLevels): string {
  return `Support ${formatPrice(levels.supportPrice)} (${levels.supportLabel}), ${formatLevelDistance(levels.supportDistance)} below. Resistance ${formatPrice(levels.resistancePrice)} (${levels.resistanceLabel}), ${formatLevelDistance(levels.resistanceDistance)} above.`;
}

function point(level: Candidate, spot: number): LevelPoint {
  return {
    price: level.price,
    label: level.label,
    distance: Math.abs(level.price - spot) / spot,
  };
}

function push(
  into: Candidate[],
  price: number | null | undefined,
  label: string,
  source: Candidate["source"] = "history",
): void {
  if (price == null || !Number.isFinite(price) || price <= 0) return;
  into.push({ price: roundCents(price), label, source });
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const byCent = new Map<number, Candidate>();
  for (let i = 0; i < candidates.length; i++) {
    const level = candidates[i];
    const key = Math.round(level.price * 100);
    const prior = byCent.get(key);
    if (!prior || SOURCE_RANK[level.source] < SOURCE_RANK[prior.source]) byCent.set(key, level);
  }
  return Array.from(byCent.values());
}

function priorDay(daily: PriceCandle[], today: string): PriceCandle | null {
  let prior: PriceCandle | null = null;
  for (let i = 0; i < daily.length; i++) {
    const candle = daily[i];
    if (newYorkDate(new Date(candle.datetime)) < today) prior = candle;
  }
  return prior;
}

function splitSession(candles: PriceCandle[], today: string): { premarket: PriceCandle[]; regular: PriceCandle[] } {
  const premarket: PriceCandle[] = [];
  const regular: PriceCandle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (newYorkDate(new Date(candle.datetime)) !== today) continue;
    const minutes = nyMinutes(candle.datetime);
    if (minutes < RTH_OPEN_MINUTES) premarket.push(candle);
    else if (minutes < RTH_CLOSE_MINUTES) regular.push(candle);
  }
  return { premarket, regular };
}

function extreme(candles: PriceCandle[], side: "high" | "low"): number | null {
  let value: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const price = candles[i][side];
    if (!Number.isFinite(price) || price <= 0) continue;
    if (value == null || (side === "high" ? price > value : price < value)) value = price;
  }
  return value;
}

/** Volume-weighted typical price. Null when the candles have no volume. */
function typicalVwap(candles: PriceCandle[]): number | null {
  let weighted = 0;
  let volume = 0;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!(candle.volume > 0)) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    if (!Number.isFinite(typical)) continue;
    weighted += typical * candle.volume;
    volume += candle.volume;
  }
  if (!(volume > 0)) return null;
  return weighted / volume;
}

function swingPoints(daily: PriceCandle[]): { highs: number[]; lows: number[] } {
  const bars = daily.slice(-LEVEL_RULES.dailyBars);
  const wing = LEVEL_RULES.swingWing;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = wing; i < bars.length - wing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let w = 1; w <= wing; w++) {
      if (!(bars[i].high > bars[i - w].high && bars[i].high > bars[i + w].high)) isHigh = false;
      if (!(bars[i].low < bars[i - w].low && bars[i].low < bars[i + w].low)) isLow = false;
    }
    if (isHigh) highs.push(bars[i].high);
    if (isLow) lows.push(bars[i].low);
  }
  return { highs, lows };
}

function optionWalls(contracts: WallContract[], spot: number): { call: number | null; put: number | null } {
  let call: { strike: number; oi: number } | null = null;
  let put: { strike: number; oi: number } | null = null;
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    if (!(contract.openInterest > 0) || !(contract.strike > 0)) continue;
    const current = contract.putCall === "call" ? call : put;
    const closer = current != null && contract.openInterest === current.oi
      && Math.abs(contract.strike - spot) < Math.abs(current.strike - spot);
    if (!current || contract.openInterest > current.oi || closer) {
      const next = { strike: contract.strike, oi: contract.openInterest };
      if (contract.putCall === "call") call = next;
      else put = next;
    }
  }
  return { call: call?.strike ?? null, put: put?.strike ?? null };
}

function roundStep(spot: number): number {
  if (spot < 10) return 0.5;
  if (spot < 50) return 1;
  if (spot < 200) return 5;
  if (spot < 1000) return 10;
  return 25;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function sortedCandles(candles: PriceCandle[]): PriceCandle[] {
  return candles.filter((candle) => candle.low > 0 && candle.high >= candle.low && candle.datetime > 0)
    .slice()
    .sort((a, b) => a.datetime - b.datetime);
}

function newYorkDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function nyMinutes(epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return (hour === 24 ? 0 : hour) * 60 + minute;
}
