import { tastytradeStreamerSymbol } from "@/app/lib/optionStreamer";
import type { OptionContract, PutCall } from "@/app/lib/contract";
import type { ChainParseResult, ParsedQuote, PriceCandle } from "@/app/lib/schwabParse";

/**
 * Pure parsers for Tastytrade market data. No network, no secrets.
 * Output matches the Schwab parsers so callers do not care which source answered.
 */

export interface NestedStrike {
  strike: number;
  call: string | null;
  put: string | null;
}

export interface NestedExpiration {
  expiration: string;
  strikes: NestedStrike[];
}

/** /option-chains/{symbol}/nested → expirations with OCC symbols per strike. */
export function parseNestedChain(payload: unknown): NestedExpiration[] {
  const items = asArray(asRecord(asRecord(payload)?.data)?.items);
  const out: NestedExpiration[] = [];
  for (let i = 0; i < items.length; i++) {
    const exps = asArray(asRecord(items[i])?.expirations);
    for (let j = 0; j < exps.length; j++) {
      const exp = asRecord(exps[j]);
      const date = typeof exp?.["expiration-date"] === "string" ? exp["expiration-date"] as string : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const strikes: NestedStrike[] = [];
      const rows = asArray(exp?.strikes);
      for (let k = 0; k < rows.length; k++) {
        const row = asRecord(rows[k]);
        const strike = num(row?.["strike-price"]);
        if (strike == null || !(strike > 0)) continue;
        strikes.push({
          strike,
          call: typeof row?.call === "string" ? row.call as string : null,
          put: typeof row?.put === "string" ? row.put as string : null,
        });
      }
      out.push({ expiration: date, strikes });
    }
  }
  return out;
}

export interface ChainSelection {
  contractType?: "CALL" | "PUT" | "ALL";
  strike?: number;
  fromDate?: string;
  toDate?: string;
  strikeCount?: number;
}

export interface SelectedSymbol {
  symbol: string;
  expiration: string;
  strike: number;
  putCall: PutCall;
}

/**
 * Same filters the Schwab chains call applies server side: date window, side,
 * an exact strike, or the strikeCount strikes nearest the underlying per expiration.
 */
export function selectChainSymbols(
  expirations: readonly NestedExpiration[],
  input: ChainSelection,
  spot: number | null,
): SelectedSymbol[] {
  const type = input.contractType ?? "ALL";
  const out: SelectedSymbol[] = [];
  for (let i = 0; i < expirations.length; i++) {
    const exp = expirations[i];
    if (input.fromDate && exp.expiration < input.fromDate) continue;
    if (input.toDate && exp.expiration > input.toDate) continue;
    let strikes = exp.strikes.slice();
    if (input.strike != null) {
      strikes = strikes.filter((row) => Math.abs(row.strike - (input.strike as number)) < 1e-6);
    } else if (input.strikeCount != null && input.strikeCount > 0 && spot != null && spot > 0) {
      strikes = nearestStrikes(strikes, spot, input.strikeCount);
    }
    for (let k = 0; k < strikes.length; k++) {
      const row = strikes[k];
      if (type !== "PUT" && row.call) out.push({ symbol: row.call, expiration: exp.expiration, strike: row.strike, putCall: "call" });
      if (type !== "CALL" && row.put) out.push({ symbol: row.put, expiration: exp.expiration, strike: row.strike, putCall: "put" });
    }
  }
  return out;
}

/** The count strikes closest to spot, returned in strike order. */
export function nearestStrikes<T extends { strike: number }>(rows: readonly T[], spot: number, count: number): T[] {
  const ranked = rows.slice().sort((a, b) => {
    const d = Math.abs(a.strike - spot) - Math.abs(b.strike - spot);
    return d !== 0 ? d : a.strike - b.strike;
  });
  return ranked.slice(0, count).sort((a, b) => a.strike - b.strike);
}

export interface TtQuoteItem {
  symbol: string;
  instrumentType: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
  /** TimeAndSale aggressor for the latest print in the collection window. */
  aggressorSide?: "buy" | "sell" | "unknown" | null;
  /** Decimal, 0.25 = 25%. */
  volatility: number | null;
  bidSize: number | null;
  askSize: number | null;
  updatedAt: number | null;
  prevClose: number | null;
}

/** /market-data/by-type items. Prices arrive as strings. */
export function parseMarketDataItems(payload: unknown): TtQuoteItem[] {
  const items = asArray(asRecord(asRecord(payload)?.data)?.items);
  const out: TtQuoteItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const row = asRecord(items[i]);
    if (!row || typeof row.symbol !== "string") continue;
    const updated = typeof row["updated-at"] === "string" ? Date.parse(row["updated-at"] as string) : NaN;
    out.push({
      symbol: row.symbol,
      instrumentType: typeof row["instrument-type"] === "string" ? row["instrument-type"] as string : "",
      bid: num(row.bid),
      ask: num(row.ask),
      last: num(row.last),
      mark: num(row.mark),
      volume: num(row.volume),
      openInterest: num(row["open-interest"]),
      delta: num(row.delta),
      volatility: num(row.volatility),
      bidSize: num(row["bid-size"]),
      askSize: num(row["ask-size"]),
      updatedAt: Number.isFinite(updated) ? updated : null,
      prevClose: num(row["prev-close"]),
    });
  }
  return out;
}

/** OCC symbol "SPY   261016C00740000" → expiration, side, strike. */
export function parseOccSymbol(symbol: string): { root: string; expiration: string; putCall: PutCall; strike: number } | null {
  const m = /^([A-Z][A-Z0-9.]{0,5})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  return {
    root: m[1],
    expiration: `20${m[2]}-${m[3]}-${m[4]}`,
    putCall: m[5] === "C" ? "call" : "put",
    strike: Number(m[6]) / 1000,
  };
}

/** Last trade from a DXLink Trade event: price, contracts, exchange time (ms), day volume. */
export interface TtLastTrade {
  price: number | null;
  size: number | null;
  time: number | null;
  dayVolume: number | null;
}

/** Field order the Trade FEED_SETUP asks for. */
export const TRADE_FIELDS = ["eventSymbol", "price", "size", "time", "dayVolume"] as const;

function finitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** COMPACT FEED_DATA ["Trade", [sym, price, size, time, dayVolume, sym, ...]] → map by streamer symbol. */
export function parseCompactTrades(data: unknown, into: Map<string, TtLastTrade> = new Map()): Map<string, TtLastTrade> {
  if (!Array.isArray(data)) return into;
  for (let i = 0; i + 1 < data.length; i += 2) {
    if (data[i] !== "Trade" || !Array.isArray(data[i + 1])) continue;
    const values = data[i + 1] as unknown[];
    const width = TRADE_FIELDS.length;
    for (let j = 0; j + width <= values.length; j += width) {
      const symbol = typeof values[j] === "string" ? (values[j] as string).trim() : "";
      if (!symbol) continue;
      into.set(symbol, {
        price: finitePositive(values[j + 1]),
        size: finitePositive(values[j + 2]),
        time: finitePositive(values[j + 3]),
        dayVolume: finitePositive(values[j + 4]),
      });
    }
  }
  return into;
}

/** DXLink streamer symbol for an OCC chain symbol: "SPY   261030C00670000" → ".SPY261030C670". */
export function streamerFromOcc(symbol: string): string | null {
  const occ = parseOccSymbol(symbol);
  if (!occ) return null;
  return tastytradeStreamerSymbol({ ticker: occ.root, expiration: occ.expiration, strike: occ.strike, putCall: occ.putCall });
}

/**
 * Fill last-trade size and time from a DXLink Trade event. The REST snapshot has
 * neither. The trade price replaces the snapshot last only when the trade has a time;
 * day volume never lowers the snapshot volume.
 */
export function applyLastTrade(contract: OptionContract, trade: TtLastTrade | undefined): OptionContract {
  if (!trade || trade.time == null) return contract;
  return {
    ...contract,
    last: trade.price ?? contract.last,
    lastSize: trade.size,
    tradeTime: trade.time,
    volume: trade.dayVolume != null && trade.dayVolume > contract.volume ? trade.dayVolume : contract.volume,
  };
}

export function contractFromQuote(item: TtQuoteItem, meta?: { expiration: string; strike: number; putCall: PutCall }): OptionContract | null {
  const occ = meta ?? parseOccSymbol(item.symbol);
  if (!occ) return null;
  return {
    bid: item.bid ?? 0,
    ask: item.ask ?? 0,
    last: item.last ?? 0,
    volume: item.volume ?? 0,
    openInterest: item.openInterest ?? 0,
    delta: item.delta,
    gamma: item.gamma ?? null,
    theta: item.theta ?? null,
    vega: item.vega ?? null,
    rho: item.rho ?? null,
    aggressorSide: item.aggressorSide ?? null,
    iv: item.volatility != null && item.volatility >= 0 ? item.volatility : null,
    strike: occ.strike,
    expiration: occ.expiration,
    putCall: occ.putCall,
    lastSize: null,
    bidSize: item.bidSize,
    askSize: item.askSize,
    // Tastytrade's snapshot has no last-trade time. Leave it null rather than guess.
    tradeTime: null,
    quoteTime: item.updatedAt,
  };
}

export function buildChainResult(
  selected: readonly SelectedSymbol[],
  quotes: readonly TtQuoteItem[],
  underlyingPrice: number | null,
  trades?: ReadonlyMap<string, TtLastTrade>,
): ChainParseResult {
  const byKey = new Map<string, TtQuoteItem>();
  for (let i = 0; i < quotes.length; i++) byKey.set(squash(quotes[i].symbol), quotes[i]);
  const contracts: OptionContract[] = [];
  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i];
    const item = byKey.get(squash(sel.symbol));
    if (!item) continue;
    const contract = contractFromQuote(item, sel);
    if (!contract) continue;
    const streamer = trades && trades.size > 0 ? streamerFromOcc(sel.symbol) : null;
    contracts.push(streamer ? applyLastTrade(contract, trades?.get(streamer)) : contract);
  }
  return { contracts, delayed: false, underlyingPrice };
}

export function quoteEntriesFromItems(items: readonly TtQuoteItem[]): ParsedQuote[] {
  const out: ParsedQuote[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].instrumentType && items[i].instrumentType !== "Equity Option") continue;
    const contract = contractFromQuote(items[i]);
    if (contract) out.push({ symbol: items[i].symbol, contract });
  }
  return out;
}

export function underlyingFromItems(items: readonly TtQuoteItem[], symbol: string): number | null {
  const want = symbol.trim().toUpperCase();
  const row = items.find((item) => item.symbol.toUpperCase() === want);
  if (!row) return null;
  if (row.last != null && row.last > 0) return row.last;
  if (row.mark != null && row.mark > 0) return row.mark;
  return null;
}

/** DXLink candle period for a Schwab-style price-history request. */
export function candlePeriod(frequencyType: "minute" | "daily", frequency: number): string {
  return frequencyType === "daily" ? "1d" : `${frequency}m`;
}

/** Schwab price-history window: an explicit startDate, otherwise period days or months back. */
export function historyFromTime(input: {
  periodType: "day" | "month";
  period: number;
  startDate?: number;
}, now: number): number {
  if (input.startDate != null && Number.isFinite(input.startDate) && input.startDate > 0) return input.startDate;
  const day = 24 * 60 * 60 * 1000;
  // Calendar days, padded so weekends do not cut the window short.
  const days = input.periodType === "month" ? input.period * 31 : input.period + 4;
  return now - days * day;
}

export interface RawEquityCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

/** Compact DXLink Candle rows: eventSymbol, time, open, high, low, close, volume. */
export function parseEquityCandles(data: unknown): Array<RawEquityCandle & { symbol: string }> {
  if (!Array.isArray(data)) return [];
  const out: Array<RawEquityCandle & { symbol: string }> = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== "Candle") continue;
    const values = data[i + 1];
    if (!Array.isArray(values)) continue;
    for (let j = 0; j + 6 < values.length; j += 7) {
      const symbol = typeof values[j] === "string" ? values[j] as string : "";
      const t = values[j + 1];
      const o = values[j + 2];
      const h = values[j + 3];
      const l = values[j + 4];
      const c = values[j + 5];
      const v = values[j + 6];
      if (!symbol || typeof t !== "number" || !(t > 1_000_000_000_000)) continue;
      if (!isPos(o) || !isPos(h) || !isPos(l) || !isPos(c)) continue;
      out.push({ symbol, t, o, h, l, c, v: typeof v === "number" && Number.isFinite(v) ? v : null });
    }
  }
  return out;
}

/**
 * daily: DXLink stamps a day bar at 00:00 UTC. Schwab stamps it at midnight
 * America/Chicago, and levels.ts reads the New York date, so re-stamp to match.
 */
export function toPriceCandles(rows: readonly RawEquityCandle[], endDate?: number, daily = false): PriceCandle[] {
  const byTime = new Map<number, PriceCandle>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t = daily ? chicagoMidnight(new Date(r.t).toISOString().slice(0, 10)) : r.t;
    if (endDate != null && t > endDate) continue;
    byTime.set(t, { open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v ?? 0, datetime: t });
  }
  return Array.from(byTime.values()).sort((a, b) => a.datetime - b.datetime);
}

/** Epoch ms of 00:00 in America/Chicago on a YYYY-MM-DD date. */
export function chicagoMidnight(date: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  for (const hours of [5, 6]) {
    const guess = utc + hours * 3600_000;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    if (get("hour") === "00" && `${get("year")}-${get("month")}-${get("day")}` === date) return guess;
  }
  return utc + 6 * 3600_000;
}

function isPos(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function squash(symbol: string): string {
  return symbol.toUpperCase().replace(/\s+/g, "");
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
