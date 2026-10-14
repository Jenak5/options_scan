import type { ChainParseResult, PriceCandle, ParsedQuote } from "@/app/lib/schwabParse";
import { QUOTE_EMPTY, QUOTE_REJECTED } from "@/app/lib/schwabParse";
import {
  connectNodeWebSocket,
  dxlinkOpening,
  openCandleAccess,
  openQuoteSession,
} from "@/app/lib/tastytradeCandles";
import {
  buildChainResult,
  candlePeriod,
  historyFromTime,
  parseEquityCandles,
  parseMarketDataItems,
  parseCompactTrades,
  parseNestedChain,
  streamerFromOcc,
  TRADE_FIELDS,
  type TtLastTrade,
  quoteEntriesFromItems,
  selectChainSymbols,
  toPriceCandles,
  underlyingFromItems,
  type ChainSelection,
  type RawEquityCandle,
  type TtQuoteItem,
} from "@/app/lib/tastytradeMarketParse";

/**
 * Read-only Tastytrade market data: chains, quotes, and equity candles.
 * Always the live API (api.tastyworks.com), never the cert sandbox.
 * GET requests and the DXLink quote feed only. No account calls, no orders.
 * Tokens are never logged or returned.
 */

if (typeof window !== "undefined") {
  throw new Error("The Tastytrade market data client is server-only.");
}

export const TASTYTRADE_LIVE_ORIGIN = "https://api.tastyworks.com";
const USER_AGENT = "options-scan/1.0";
/** /market-data/by-type takes up to 100 symbols per request. */
export const QUOTE_BATCH = 100;
/** Tastytrade access tokens last 15 minutes. Refresh a minute early. */
const TOKEN_FALLBACK_TTL_MS = 15 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
/** Waits before retry 1 and 2 after a 401. */
const AUTH_RETRY_DELAYS_MS = [250, 750];

interface CachedToken {
  access: string;
  mintedAt: number;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let refreshing: Promise<CachedToken> | null = null;
let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TastytradeDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TastytradeDataError";
  }
}

function tokenUsable(token: CachedToken | null, now: number): token is CachedToken {
  return token != null && now < token.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * One refresh at a time per instance. Concurrent callers share the same
 * in-flight refresh instead of each minting a token.
 */
async function currentToken(fetchImpl: typeof fetch): Promise<CachedToken> {
  if (tokenUsable(cachedToken, Date.now())) return cachedToken;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const opened = await openCandleAccess({ fetchImpl });
        if (!opened.access) throw new TastytradeDataError(opened.errorSample);
        const now = Date.now();
        const ttl = opened.access.expiresInMs ?? TOKEN_FALLBACK_TTL_MS;
        cachedToken = { access: opened.access.access, mintedAt: now, expiresAt: now + ttl };
        return cachedToken;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** Drop the cached token only if it is still the one that got the 401. */
function invalidateToken(access: string): void {
  if (cachedToken?.access === access) cachedToken = null;
}

/**
 * Run an authorized call. On a 401, drop that token, wait briefly, and try
 * again with a fresh one, up to two retries. The token age is logged (never
 * the token) so repeated 401s on new tokens can be told apart from expiry.
 */
export async function withTastytradeAuth<T>(
  label: string,
  fetchImpl: typeof fetch,
  call: (access: string) => Promise<{ status: number; value?: T }>,
): Promise<T> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= AUTH_RETRY_DELAYS_MS.length; attempt++) {
    const token = await currentToken(fetchImpl);
    const result = await call(token.access);
    if (result.status !== 401) {
      if (attempt > 0) console.info(`[tastytrade-auth] ${label} ok after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
      return result.value as T;
    }
    lastStatus = 401;
    const age = Math.round((Date.now() - token.mintedAt) / 1000);
    console.warn(`[tastytrade-auth] ${label} 401 on attempt ${attempt + 1} (token age ${age}s)`);
    invalidateToken(token.access);
    if (attempt < AUTH_RETRY_DELAYS_MS.length) await sleepImpl(AUTH_RETRY_DELAYS_MS[attempt]);
  }
  throw new TastytradeDataError(label === "quote token" ? `Tastytrade quote token failed (${lastStatus})` : `Tastytrade ${label} failed (${lastStatus})`);
}

async function ttGet(path: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<unknown> {
  return withTastytradeAuth("market data request", fetchImpl, async (token) => {
    const res = await fetchImpl(`${TASTYTRADE_LIVE_ORIGIN}${path}`, {
      headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal,
    });
    if (res.status === 401) return { status: 401 };
    if (!res.ok) throw new TastytradeDataError(`Tastytrade market data request failed (${res.status})`);
    return { status: res.status, value: await res.json() };
  });
}

/** DXLink quote token with the same 401 retry as REST. */
async function quoteSession(fetchImpl: typeof fetch): Promise<{ url: string; token: string }> {
  return withTastytradeAuth("quote token", fetchImpl, async (access) => {
    try {
      return { status: 200, value: await openQuoteSession(fetchImpl, access) };
    } catch (err) {
      if (err instanceof Error && /\(401\)/.test(err.message)) return { status: 401 };
      throw err;
    }
  });
}

export async function ttQuotes(
  input: { equity?: string[]; options?: string[] },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TtQuoteItem[]> {
  const out: TtQuoteItem[] = [];
  const equity = (input.equity ?? []).filter(Boolean);
  const options = (input.options ?? []).filter(Boolean);
  const batches: string[] = [];
  if (equity.length > 0) batches.push(`equity=${equity.map(encodeURIComponent).join(",")}`);
  for (let i = 0; i < options.length; i += QUOTE_BATCH) {
    batches.push(`equity-option=${options.slice(i, i + QUOTE_BATCH).map(encodeURIComponent).join(",")}`);
  }
  const results = await Promise.all(batches.map((q) => ttGet(`/market-data/by-type?${q}`, fetchImpl, signal)));
  for (let i = 0; i < results.length; i++) out.push(...parseMarketDataItems(results[i]));
  return out;
}

export async function ttOptionChain(
  input: ChainSelection & { symbol: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ChainParseResult> {
  const symbol = input.symbol.trim().toUpperCase();
  const [nested, underlyingItems] = await Promise.all([
    ttGet(`/option-chains/${encodeURIComponent(symbol)}/nested`, fetchImpl),
    ttQuotes({ equity: [symbol] }, fetchImpl),
  ]);
  const spot = underlyingFromItems(underlyingItems, symbol);
  const selected = selectChainSymbols(parseNestedChain(nested), input, spot);
  if (selected.length === 0) return { contracts: [], delayed: false, underlyingPrice: spot };
  const symbols = selected.map((s) => s.symbol);
  const [quotes, trades] = await Promise.all([
    ttQuotes({ options: symbols }, fetchImpl),
    ttLastTradesSafe(symbols, fetchImpl),
  ]);
  return buildChainResult(selected, quotes, spot, trades);
}

/** Last trades never block a chain. Any DXLink problem leaves size and time empty, as before. */
async function ttLastTradesSafe(occSymbols: string[], fetchImpl: typeof fetch): Promise<Map<string, TtLastTrade>> {
  try {
    return await ttLastTrades(occSymbols, { fetchImpl });
  } catch (err) {
    console.warn(`[market-data] last trades unavailable: ${err instanceof Error ? err.message : "unknown"}`);
    return new Map();
  }
}

/**
 * Last trade per option from DXLink Trade events. DXLink answers a Trade
 * subscription with the latest trade right away, so this waits until every
 * symbol answered, the feed goes quiet, or the timeout.
 */
export async function ttLastTrades(
  occSymbols: string[],
  deps?: { fetchImpl?: typeof fetch; timeoutMs?: number; quietMs?: number },
): Promise<Map<string, TtLastTrade>> {
  const streamers = Array.from(new Set(occSymbols.map(streamerFromOcc).filter((s): s is string => s != null)));
  const out = new Map<string, TtLastTrade>();
  if (streamers.length === 0) return out;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? 6000;
  const quietMs = deps?.quietMs ?? 800;
  const session = await quoteSession(fetchImpl);
  const transport = await connectNodeWebSocket(session.url);
  const deadline = Date.now() + timeoutMs;
  let streaming = false;
  let lastDataAt = 0;
  try {
    const opening = dxlinkOpening(session.token);
    for (let i = 0; i < opening.length; i++) transport.send(JSON.stringify(opening[i]));
    while (Date.now() < deadline && out.size < streamers.length) {
      if (lastDataAt > 0 && Date.now() - lastDataAt >= quietMs) break;
      const incoming = await transport.next(Math.max(1, Math.min(lastDataAt > 0 ? quietMs : 3000, deadline - Date.now())));
      if (incoming === "timeout") continue;
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
        throw new TastytradeDataError("DXLink error");
      } else if (msg.type === "AUTH_STATE" && msg.state === "AUTHORIZED" && !streaming) {
        streaming = true;
        transport.send(JSON.stringify({ type: "CHANNEL_REQUEST", channel: 1, service: "FEED", parameters: { contract: "AUTO" } }));
        transport.send(JSON.stringify({
          type: "FEED_SETUP",
          channel: 1,
          acceptAggregationPeriod: 0.1,
          acceptDataFormat: "COMPACT",
          acceptEventFields: { Trade: [...TRADE_FIELDS] },
        }));
        for (let i = 0; i < streamers.length; i += QUOTE_BATCH) {
          transport.send(JSON.stringify({
            type: "FEED_SUBSCRIPTION",
            channel: 1,
            add: streamers.slice(i, i + QUOTE_BATCH).map((symbol) => ({ type: "Trade", symbol })),
          }));
        }
      } else if (msg.type === "FEED_DATA") {
        const before = out.size;
        parseCompactTrades(msg.data, out);
        if (out.size > before || lastDataAt === 0) lastDataAt = Date.now();
      }
    }
  } finally {
    transport.close();
  }
  return out;
}

export async function ttQuoteEntries(
  symbols: string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: ParsedQuote[]; problem: string | null }> {
  const cleaned = symbols.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return { entries: [], problem: null };
  const items = await ttQuotes({ options: cleaned }, fetchImpl, signal);
  const entries = quoteEntriesFromItems(items);
  return { entries, problem: entries.length > 0 ? null : items.length === 0 ? QUOTE_EMPTY : QUOTE_REJECTED };
}

/** Same request shape as Schwab getPriceHistory, served from DXLink candles. */
export async function ttPriceHistory(input: {
  symbol: string;
  periodType: "day" | "month";
  period: number;
  frequencyType: "minute" | "daily";
  frequency: number;
  needExtendedHoursData?: boolean;
  startDate?: number;
  endDate?: number;
}, deps?: { fetchImpl?: typeof fetch; timeoutMs?: number; quietMs?: number }): Promise<PriceCandle[]> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const symbol = input.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) throw new TastytradeDataError("Tastytrade candle request failed");
  const now = Date.now();
  const fromTime = historyFromTime(input, now);
  const period = candlePeriod(input.frequencyType, input.frequency);
  // dxFeed "tho=true" keeps regular trading hours only, matching Schwab's needExtendedHoursData=false.
  const attrs = input.frequencyType === "daily" || input.needExtendedHoursData ? `=${period}` : `=${period},tho=true`;
  const subSymbol = `${symbol}{${attrs}}`;
  const session = await quoteSession(fetchImpl);
  const rows = await streamCandles(session, subSymbol, fromTime, deps?.timeoutMs ?? 15_000, deps?.quietMs ?? 1200);
  const candles = toPriceCandles(rows.filter((r) => r.t >= fromTime - 864e5), input.endDate, input.frequencyType === "daily");
  if (candles.length === 0) throw new TastytradeDataError("Tastytrade returned no candles");
  return candles;
}

async function streamCandles(
  session: { url: string; token: string },
  subSymbol: string,
  fromTime: number,
  timeoutMs: number,
  quietMs: number,
): Promise<RawEquityCandle[]> {
  const transport = await connectNodeWebSocket(session.url);
  const rows: RawEquityCandle[] = [];
  let streaming = false;
  let lastDataAt = 0;
  const seen = new Set<number>();
  const deadline = Date.now() + timeoutMs;
  try {
    const opening = dxlinkOpening(session.token);
    for (let i = 0; i < opening.length; i++) transport.send(JSON.stringify(opening[i]));
    while (Date.now() < deadline) {
      if (lastDataAt > 0 && Date.now() - lastDataAt >= quietMs) break;
      const incoming = await transport.next(Math.max(1, Math.min(lastDataAt > 0 ? quietMs : 3000, deadline - Date.now())));
      if (incoming === "timeout") continue;
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
        throw new TastytradeDataError("DXLink error");
      } else if (msg.type === "AUTH_STATE" && msg.state === "AUTHORIZED" && !streaming) {
        streaming = true;
        const feed = [
          { type: "CHANNEL_REQUEST", channel: 1, service: "FEED", parameters: { contract: "AUTO" } },
          {
            type: "FEED_SETUP",
            channel: 1,
            acceptAggregationPeriod: 0.1,
            acceptDataFormat: "COMPACT",
            acceptEventFields: { Candle: ["eventSymbol", "time", "open", "high", "low", "close", "volume"] },
          },
          { type: "FEED_SUBSCRIPTION", channel: 1, add: [{ type: "Candle", symbol: subSymbol, fromTime: Math.floor(fromTime) }] },
        ];
        for (let i = 0; i < feed.length; i++) transport.send(JSON.stringify(feed[i]));
      } else if (msg.type === "FEED_DATA") {
        const parsed = parseEquityCandles(msg.data);
        if (parsed.length > 0) {
          rows.push(...parsed);
          // The live bar keeps updating. Only a new bar time counts as more history.
          let fresh = false;
          for (let i = 0; i < parsed.length; i++) {
            if (!seen.has(parsed[i].t)) {
              seen.add(parsed[i].t);
              fresh = true;
            }
          }
          if (fresh || lastDataAt === 0) lastDataAt = Date.now();
        }
      }
    }
  } finally {
    transport.close();
  }
  return rows;
}

export function resetTastytradeMarketForTests(options?: { sleep?: (ms: number) => Promise<void> }): void {
  cachedToken = null;
  refreshing = null;
  sleepImpl = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}
