import {
  DXLINK_OPEN_TIMEOUT_MS,
  dxlinkOpening,
  type CandleTransport,
} from "@/app/lib/tastytradeCandles";
import { streamerFromOcc, type TtLastTrade, type TtQuoteItem } from "@/app/lib/tastytradeMarketParse";
import { setTradeSideDataAvailable, type TradeSideAvailability } from "@/app/lib/marketDataHealth";

/**
 * DXLink feed for one chain: Quote, Greeks, Summary (open interest), and
 * TimeAndSale (price, size, aggressor side). Candle history stays on the
 * candle client. Read-only. The quote token is sent on the socket and is
 * never logged.
 *
 * Vercel functions die when the response ends, so TimeAndSale is collected
 * for one bounded window per symbol batch (one option chain), then the
 * socket closes. This is not a full-session tape.
 */

/** Default TimeAndSale window for one chain. A few seconds, then close. */
export const TRADE_PRINT_WINDOW_MS = 3_000;
/** Hard cap so a bad env value cannot hold the function open. */
export const TRADE_PRINT_WINDOW_MAX_MS = 8_000;
/** One FEED_SUBSCRIPTION add list. Further symbols are another message in the same window. */
export const DXLINK_SYMBOL_BATCH = 100;

export const QUOTE_FIELDS = ["eventSymbol", "bidPrice", "askPrice", "bidSize", "askSize"] as const;
export const GREEKS_FIELDS = ["eventSymbol", "volatility", "delta", "gamma", "theta", "vega", "rho"] as const;
export const SUMMARY_FIELDS = ["eventSymbol", "openInterest"] as const;
export const TIME_AND_SALE_FIELDS = ["eventSymbol", "time", "price", "size", "aggressorSide"] as const;

export interface DxQuote {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export interface DxGreeks {
  volatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
}

export interface DxSummary {
  openInterest: number | null;
}

export interface DxPrint {
  price: number | null;
  size: number | null;
  time: number | null;
  aggressorSide: "buy" | "sell" | "unknown" | null;
}

export interface DxlinkSnapshot {
  quotes: Map<string, DxQuote>;
  greeks: Map<string, DxGreeks>;
  summaries: Map<string, DxSummary>;
  prints: Map<string, DxPrint>;
  tradeSideDataAvailable: TradeSideAvailability;
}

export function tradePrintWindowMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TT_TRADE_WINDOW_MS;
  if (raw == null || raw.trim() === "") return TRADE_PRINT_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return TRADE_PRINT_WINDOW_MS;
  if (n <= 0) return 0;
  return Math.min(TRADE_PRINT_WINDOW_MAX_MS, Math.floor(n));
}

export function chainFeedMessages(symbols: readonly string[]): object[] {
  const unique = symbols.filter((symbol, index) => symbol.length > 0 && symbols.indexOf(symbol) === index);
  const messages: object[] = [
    { type: "CHANNEL_REQUEST", channel: 1, service: "FEED", parameters: { contract: "AUTO" } },
    {
      type: "FEED_SETUP",
      channel: 1,
      acceptAggregationPeriod: 0.1,
      acceptDataFormat: "COMPACT",
      acceptEventFields: {
        Quote: [...QUOTE_FIELDS],
        Greeks: [...GREEKS_FIELDS],
        Summary: [...SUMMARY_FIELDS],
        TimeAndSale: [...TIME_AND_SALE_FIELDS],
      },
    },
  ];
  for (let i = 0; i < unique.length; i += DXLINK_SYMBOL_BATCH) {
    const batch = unique.slice(i, i + DXLINK_SYMBOL_BATCH);
    const add: { type: string; symbol: string }[] = [];
    for (let j = 0; j < batch.length; j++) {
      const symbol = batch[j];
      add.push({ type: "Quote", symbol }, { type: "Greeks", symbol }, { type: "Summary", symbol }, { type: "TimeAndSale", symbol });
    }
    messages.push({ type: "FEED_SUBSCRIPTION", channel: 1, add });
  }
  return messages;
}

export function emptyDxlinkSnapshot(): DxlinkSnapshot {
  return {
    quotes: new Map(),
    greeks: new Map(),
    summaries: new Map(),
    prints: new Map(),
    tradeSideDataAvailable: "no",
  };
}

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "nan") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseAggressorSide(value: unknown): "buy" | "sell" | "unknown" | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "buy" || text === "b") return "buy";
  if (text === "sell" || text === "s") return "sell";
  if (text.length === 0) return null;
  return "unknown";
}

function symbolAt(values: unknown[], index: number): string {
  return typeof values[index] === "string" ? (values[index] as string).trim() : "";
}

function readRows(data: unknown[], eventName: string, width: number, onRow: (values: unknown[], index: number) => void): void {
  for (let i = 0; i + 1 < data.length; i += 2) {
    if (data[i] !== eventName || !Array.isArray(data[i + 1])) continue;
    const values = data[i + 1] as unknown[];
    for (let j = 0; j + width <= values.length; j += width) onRow(values, j);
  }
}

/** COMPACT FEED_DATA for Quote, Greeks, Summary, and TimeAndSale. */
export function parseDxlinkFeedData(data: unknown, into: DxlinkSnapshot = emptyDxlinkSnapshot()): DxlinkSnapshot {
  if (!Array.isArray(data)) return into;
  readRows(data, "Quote", QUOTE_FIELDS.length, (values, j) => {
    const symbol = symbolAt(values, j);
    if (!symbol) return;
    into.quotes.set(symbol, {
      bid: finite(values[j + 1]),
      ask: finite(values[j + 2]),
      bidSize: finite(values[j + 3]),
      askSize: finite(values[j + 4]),
    });
  });
  readRows(data, "Greeks", GREEKS_FIELDS.length, (values, j) => {
    const symbol = symbolAt(values, j);
    if (!symbol) return;
    into.greeks.set(symbol, {
      volatility: finite(values[j + 1]),
      delta: finite(values[j + 2]),
      gamma: finite(values[j + 3]),
      theta: finite(values[j + 4]),
      vega: finite(values[j + 5]),
      rho: finite(values[j + 6]),
    });
  });
  readRows(data, "Summary", SUMMARY_FIELDS.length, (values, j) => {
    const symbol = symbolAt(values, j);
    if (!symbol) return;
    into.summaries.set(symbol, { openInterest: finite(values[j + 1]) });
  });
  readRows(data, "TimeAndSale", TIME_AND_SALE_FIELDS.length, (values, j) => {
    const symbol = symbolAt(values, j);
    if (!symbol) return;
    into.prints.set(symbol, {
      time: finite(values[j + 1]),
      price: finite(values[j + 2]),
      size: finite(values[j + 3]),
      aggressorSide: parseAggressorSide(values[j + 4]),
    });
  });
  return into;
}

function errorText(message: Record<string, unknown>): string {
  const raw = message.message ?? message.error ?? message.description ?? "";
  const text = typeof raw === "string" ? raw : "";
  return text.replace(/bearer\s+\S+/gi, "bearer [redacted]").slice(0, 180);
}

/**
 * Drive one DXLink socket until the TimeAndSale window ends.
 * `windowMs` of 0 subscribes and returns as soon as the feed is authorized,
 * which still reports trade-side availability without waiting for prints.
 */
export async function collectDxlinkFeed(
  transport: CandleTransport,
  token: string,
  symbols: readonly string[],
  windowMs: number,
): Promise<DxlinkSnapshot> {
  const snap = emptyDxlinkSnapshot();
  if (symbols.length === 0) return snap;
  const opening = dxlinkOpening(token);
  for (let i = 0; i < opening.length; i++) transport.send(JSON.stringify(opening[i]));
  const overall = Date.now() + DXLINK_OPEN_TIMEOUT_MS + Math.max(windowMs, 0);
  let streaming = false;
  let rejected = false;
  let subscribedAt = 0;
  while (Date.now() < overall) {
    if (subscribedAt > 0 && Date.now() - subscribedAt >= windowMs) break;
    const remaining = subscribedAt > 0 ? windowMs - (Date.now() - subscribedAt) : Math.min(3_000, overall - Date.now());
    const incoming = await transport.next(Math.max(1, remaining));
    if (incoming === "timeout") {
      if (subscribedAt > 0) break;
      continue;
    }
    if (incoming == null) break;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(incoming) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (msg.type === "KEEPALIVE") {
      transport.send(JSON.stringify({ type: "KEEPALIVE", channel: 0 }));
    } else if (msg.type === "ERROR") {
      if (/timeandsale/i.test(errorText(msg))) rejected = true;
    } else if (msg.type === "AUTH_STATE" && msg.state === "AUTHORIZED" && !streaming) {
      streaming = true;
      const feed = chainFeedMessages(symbols);
      for (let i = 0; i < feed.length; i++) transport.send(JSON.stringify(feed[i]));
      subscribedAt = Date.now();
      if (windowMs <= 0) break;
    } else if (msg.type === "FEED_DATA") {
      parseDxlinkFeedData(msg.data, snap);
    }
  }
  snap.tradeSideDataAvailable = streaming && !rejected ? "yes" : "no";
  return snap;
}

export function noteDxlinkTradeSide(value: TradeSideAvailability): void {
  setTradeSideDataAvailable(value);
}

/**
 * REST quote rows stay the base. DXLink fills bid, ask, greeks, open interest,
 * and the latest TimeAndSale print when the feed sent them.
 */
export function applyDxlinkOverlay(
  items: readonly TtQuoteItem[],
  snap: DxlinkSnapshot,
): { items: TtQuoteItem[]; trades: Map<string, TtLastTrade> } {
  const trades = new Map<string, TtLastTrade>();
  const next = items.map((item) => ({ ...item }));
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    const streamer = streamerFromOcc(item.symbol);
    if (!streamer) continue;
    const quote = snap.quotes.get(streamer);
    if (quote) {
      if (quote.bid != null && quote.bid > 0) item.bid = quote.bid;
      if (quote.ask != null && quote.ask > 0) item.ask = quote.ask;
      if (quote.bidSize != null) item.bidSize = quote.bidSize;
      if (quote.askSize != null) item.askSize = quote.askSize;
    }
    const greeks = snap.greeks.get(streamer);
    if (greeks) {
      if (greeks.delta != null) item.delta = greeks.delta;
      if (greeks.volatility != null && greeks.volatility >= 0) item.volatility = greeks.volatility;
      item.gamma = greeks.gamma;
      item.theta = greeks.theta;
      item.vega = greeks.vega;
      item.rho = greeks.rho;
    }
    const summary = snap.summaries.get(streamer);
    if (summary?.openInterest != null && summary.openInterest >= 0) item.openInterest = summary.openInterest;
    const print = snap.prints.get(streamer);
    if (print) {
      item.aggressorSide = print.aggressorSide;
      trades.set(streamer, {
        price: print.price,
        size: print.size,
        time: print.time,
        dayVolume: null,
      });
    }
  }
  return { items: next, trades };
}
