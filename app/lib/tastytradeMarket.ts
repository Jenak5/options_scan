import type { ChainParseResult, PriceCandle, ParsedQuote } from "@/app/lib/schwabParse";
import { QUOTE_EMPTY, QUOTE_REJECTED } from "@/app/lib/schwabParse";
import {
  connectNodeWebSocket,
  dxlinkErrorIsAuth,
  dxlinkOpening,
  formatDxlinkError,
  openCandleAccess,
  openQuoteSession,
  TastytradeDxlinkError,
  TASTYTRADE_REST_TIMEOUT_MS,
  type CandleTransport,
  type QuoteSession,
} from "@/app/lib/tastytradeCandles";
import {
  applyDxlinkOverlay,
  collectDxlinkFeed,
  noteDxlinkTradeSide,
  tradePrintWindowMs,
  type DxlinkSnapshot,
} from "@/app/lib/tastytradeDxlink";
import {
  clearStoredTastytradeAccess,
  dropMemoryAccessIf,
  readStoredTastytradeAccess,
  resetTastytradeStoreForTests,
  writeStoredTastytradeAccess,
} from "@/app/lib/tastytradeStore";
import {
  buildChainResult,
  historyCandleSymbol,
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
/** Pause before rotating after a 401, and before retrying a token that is already in use. */
const AUTH_RETRY_DELAY_MS = 250;
/**
 * Tastytrade rejects a market-data call that goes out in the same instant as
 * the refresh that minted the token. Hold a replacement until it is this old.
 * A token older than this that 401s is tried once more before that refresh,
 * because the token just served other calls and the 401 is not expiry.
 */
const FRESH_TOKEN_GRACE_MS = 2_000;
/**
 * Tastytrade requests in flight at once per instance (one scan).
 * Two, so a burst right after login does not come back as 401.
 */
export const TT_MAX_CONCURRENT = 2;
/** Tastytrade requests in flight at once for one ticker's chain. */
export const TT_MAX_PER_TICKER = 2;
/**
 * DXLink sockets open at once in this process. One, so the next socket is
 * opened only after the previous one has closed.
 */
export const DXLINK_MAX_SOCKETS = 1;
/** A quote token inside this window of expires-at is not used. */
const QUOTE_EXPIRY_SKEW_MS = 5_000;

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

/** Small counting semaphore. */
export class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  peak = 0;
  constructor(readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

let globalLimiter = new Limiter(TT_MAX_CONCURRENT);
let dxlinkLimiter = new Limiter(DXLINK_MAX_SOCKETS);
let dxlinkConnect: ((url: string) => Promise<CandleTransport>) | null = null;

/** Run tasks with at most `limit` at once, keeping result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const lim = new Limiter(limit);
  return Promise.all(items.map((item) => lim.run(() => fn(item))));
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
        const stored = await readStoredTastytradeAccess();
        if (stored && tokenUsable(stored, Date.now())) {
          cachedToken = stored;
          return stored;
        }
        const opened = await openCandleAccess({ fetchImpl });
        if (!opened.access) throw new TastytradeDataError(opened.errorSample);
        const now = Date.now();
        const ttl = opened.access.expiresInMs ?? TOKEN_FALLBACK_TTL_MS;
        cachedToken = { access: opened.access.access, mintedAt: now, expiresAt: now + ttl };
        await writeStoredTastytradeAccess(cachedToken);
        return cachedToken;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/**
 * Drop the cached token only if it is still the one that got the 401.
 * Another caller in this process may already have stored a newer access
 * token in memory. Keep that one instead of minting again.
 */
async function invalidateToken(access: string): Promise<void> {
  if (cachedToken?.access === access) cachedToken = null;
  dropMemoryAccessIf(access);
  const stored = await readStoredTastytradeAccess();
  if (stored && stored.access !== access) {
    cachedToken = stored;
    return;
  }
  await clearStoredTastytradeAccess(access);
}

/**
 * Run an authorized call. A 401 on a token that is already a couple of seconds
 * old is retried once on that same token: quotes were failing this way while
 * the token was still serving chains and candles. Only then do we refresh
 * once. The replacement is held until it is {@link FRESH_TOKEN_GRACE_MS} old,
 * because a call in the same instant as the refresh comes back 401 and the
 * next call a few seconds later succeeds. A further 401 is returned so the
 * caller can fall back to Schwab. Do not loop the token endpoint: repeated
 * failures can get the address blocked. The token value is never logged.
 * Age is, so a 401 on a new token can be told apart from expiry.
 */
export async function withTastytradeAuth<T>(
  label: string,
  fetchImpl: typeof fetch,
  call: (access: string) => Promise<{ status: number; value?: T }>,
): Promise<T> {
  let refreshed = false;
  let matureRetried = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await currentToken(fetchImpl);
    if (refreshed) {
      const wait = token.mintedAt + FRESH_TOKEN_GRACE_MS - Date.now();
      if (wait > 0) await sleepImpl(wait);
    }
    const result = await globalLimiter.run(() => call(token.access));
    if (result.status !== 401) {
      if (refreshed) console.info(`[tastytrade-auth] ${label} ok after refresh`);
      return result.value as T;
    }
    const ageMs = Date.now() - token.mintedAt;
    const age = Math.round(ageMs / 1000);
    console.warn(`[tastytrade-auth] ${label} 401 on attempt ${attempt + 1} (token age ${age}s)`);
    if (!matureRetried && ageMs >= FRESH_TOKEN_GRACE_MS) {
      matureRetried = true;
      await sleepImpl(AUTH_RETRY_DELAY_MS);
      continue;
    }
    if (refreshed) break;
    refreshed = true;
    await invalidateToken(token.access);
    await sleepImpl(AUTH_RETRY_DELAY_MS);
  }
  console.warn(`[tastytrade-auth] ${label} still 401 after one refresh, giving up`);
  throw new TastytradeDataError(label === "quote token" ? "Tastytrade quote token failed (401)" : `Tastytrade ${label} failed (401)`);
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) return true;
  return err instanceof Error && /timed out|TimeoutError/i.test(err.message);
}

async function ttGet(path: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<unknown> {
  return withTastytradeAuth("market data request", fetchImpl, async (token) => {
    const timeout = AbortSignal.timeout(TASTYTRADE_REST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(`${TASTYTRADE_LIVE_ORIGIN}${path}`, {
        headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (isTimeoutError(err)) throw new TastytradeDataError("Tastytrade market data request timed out");
      throw err;
    }
    if (res.status === 401) return { status: 401 };
    if (!res.ok) throw new TastytradeDataError(`Tastytrade market data request failed (${res.status})`);
    return { status: res.status, value: await res.json() };
  });
}

interface QuotePair {
  access: string;
  session: QuoteSession;
}

export function setDxlinkConnectForTests(connect: ((url: string) => Promise<CandleTransport>) | null): void {
  dxlinkConnect = connect;
}

/** Highest number of DXLink sockets seen in flight at once (tests/diagnostics). */
export function dxlinkPeakSockets(): number {
  return dxlinkLimiter.peak;
}

function connector(): (url: string) => Promise<CandleTransport> {
  return dxlinkConnect ?? connectNodeWebSocket;
}

/**
 * A new OAuth access token for the quote-token call that follows immediately.
 * Does not reuse the in-memory REST token. One request, not a retry loop.
 */
async function mintFreshAccess(fetchImpl: typeof fetch): Promise<CachedToken> {
  const opened = await openCandleAccess({ fetchImpl });
  if (!opened.access) throw new TastytradeDataError(opened.errorSample);
  const now = Date.now();
  const ttl = opened.access.expiresInMs ?? TOKEN_FALLBACK_TTL_MS;
  const token: CachedToken = { access: opened.access.access, mintedAt: now, expiresAt: now + ttl };
  cachedToken = token;
  await writeStoredTastytradeAccess(token);
  return token;
}

function quoteStillValid(session: QuoteSession, now: number): boolean {
  return session.expiresAt == null || session.expiresAt - now > QUOTE_EXPIRY_SKEW_MS;
}

function isQuoteUnauthorized(err: unknown): boolean {
  if (err instanceof TastytradeDxlinkError && err.authRelated) return true;
  return err instanceof Error && /\((401|403)\)/.test(err.message);
}

/**
 * Fresh access token, then one /api-quote-tokens call. A 401 or an already
 * expired quote token mints one replacement and holds it for the same grace
 * the REST client uses after a refresh. The quote token is not cached.
 */
async function mintQuotePair(fetchImpl: typeof fetch, hold: boolean): Promise<QuotePair> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await mintFreshAccess(fetchImpl);
    if (hold || attempt > 0) {
      const wait = token.mintedAt + FRESH_TOKEN_GRACE_MS - Date.now();
      if (wait > 0) await sleepImpl(wait);
    }
    try {
      const session = await openQuoteSession(fetchImpl, token.access);
      if (!quoteStillValid(session, Date.now())) {
        const when = session.expiresAt == null ? "unknown" : new Date(session.expiresAt).toISOString();
        throw new TastytradeDxlinkError(
          `DXLink error=UNAUTHORIZED; message=quote token expired (expires-at ${when})`,
          true,
        );
      }
      return { access: token.access, session };
    } catch (err) {
      lastError = err;
      await invalidateToken(token.access);
      if (attempt === 0 && isQuoteUnauthorized(err)) {
        await sleepImpl(AUTH_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new TastytradeDataError("Tastytrade quote token failed (401)");
}

/** One socket at a time. An auth-related DXLink error refreshes the access and quote tokens once. */
async function withFreshDxlink<T>(
  fetchImpl: typeof fetch,
  run: (session: QuoteSession) => Promise<T>,
): Promise<T> {
  return dxlinkLimiter.run(async () => {
    let retried = false;
    for (;;) {
      const pair = await mintQuotePair(fetchImpl, retried);
      try {
        return await run(pair.session);
      } catch (err) {
        if (!retried && err instanceof TastytradeDxlinkError && err.authRelated) {
          retried = true;
          await invalidateToken(pair.access);
          console.warn(`[tastytrade-dxlink] auth error, refreshing once: ${err.message}`);
          await sleepImpl(AUTH_RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
  });
}

function dxlinkFailure(msg: Record<string, unknown>, secrets: readonly string[]): TastytradeDxlinkError {
  if (msg.type === "AUTH_STATE" && msg.state !== "AUTHORIZED") {
    const state = typeof msg.state === "string" ? msg.state : "rejected";
    return new TastytradeDxlinkError(
      formatDxlinkError({ error: "UNAUTHORIZED", message: `AUTH_STATE ${state}` }, secrets),
      true,
    );
  }
  return new TastytradeDxlinkError(formatDxlinkError(msg, secrets), dxlinkErrorIsAuth(msg));
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
  const results = await mapLimit(batches, TT_MAX_PER_TICKER, (q) => ttGet(`/market-data/by-type?${q}`, fetchImpl, signal));
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
  const [quotes, feed] = await Promise.all([
    ttQuotes({ options: symbols }, fetchImpl),
    dxlinkEnrichSafe(symbols, fetchImpl),
  ]);
  if (!feed) return buildChainResult(selected, quotes, spot);
  const overlaid = applyDxlinkOverlay(quotes, feed);
  return buildChainResult(selected, overlaid.items, spot, overlaid.trades);
}

/**
 * Quote, Greeks, Summary, and TimeAndSale for this chain.
 * A feed failure leaves the REST quote in place and reports trade-side data as no.
 * The socket stays open only for the bounded print window.
 */
async function dxlinkEnrichSafe(occSymbols: string[], fetchImpl: typeof fetch): Promise<DxlinkSnapshot | null> {
  const windowMs = tradePrintWindowMs();
  if (windowMs <= 0) {
    noteDxlinkTradeSide("no");
    return null;
  }
  try {
    const streamers = Array.from(new Set(occSymbols.map(streamerFromOcc).filter((s): s is string => s != null)));
    if (streamers.length === 0) {
      noteDxlinkTradeSide("no");
      return null;
    }
    const snap = await withFreshDxlink(fetchImpl, async (session) => {
      const transport = await connector()(session.url);
      try {
        return await collectDxlinkFeed(transport, session.token, streamers, windowMs);
      } finally {
        transport.close();
      }
    });
    noteDxlinkTradeSide(snap.tradeSideDataAvailable);
    return snap;
  } catch (err) {
    noteDxlinkTradeSide("no");
    const text = err instanceof Error ? err.message : "unknown";
    const safe = text.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/\s+/g, " ").slice(0, 160);
    console.warn(`[market-data] DXLink feed unavailable: ${safe}`);
    return null;
  }
}

/**
 * Last trade per option from DXLink Trade events. The chain path uses
 * TimeAndSale instead, which also carries aggressor side. This stays for a
 * one-shot Trade snapshot. DXLink answers with the latest trade right away,
 * so this waits until every symbol answered, the feed goes quiet, or the timeout.
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
  await withFreshDxlink(fetchImpl, async (session) => {
    const transport = await connector()(session.url);
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
        } else if (msg.type === "ERROR" || (msg.type === "AUTH_STATE" && msg.state !== "AUTHORIZED")) {
          throw dxlinkFailure(msg, [session.token]);
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
  });
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
  const subSymbol = historyCandleSymbol(input);
  if (!subSymbol) throw new TastytradeDataError("Tastytrade candle request failed");
  const now = Date.now();
  const fromTime = historyFromTime(input, now);
  const rows = await withFreshDxlink(fetchImpl, (session) => streamCandles(
    session,
    subSymbol,
    fromTime,
    deps?.timeoutMs ?? 15_000,
    deps?.quietMs ?? 1200,
  ));
  const candles = toPriceCandles(rows.filter((r) => r.t >= fromTime - 864e5), input.endDate, input.frequencyType === "daily");
  if (candles.length === 0) throw new TastytradeDataError("Tastytrade returned no candles");
  return candles;
}

async function streamCandles(
  session: QuoteSession,
  subSymbol: string,
  fromTime: number,
  timeoutMs: number,
  quietMs: number,
): Promise<RawEquityCandle[]> {
  const transport = await connector()(session.url);
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
      } else if (msg.type === "ERROR" || (msg.type === "AUTH_STATE" && msg.state !== "AUTHORIZED")) {
        throw dxlinkFailure(msg, [session.token]);
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

export function resetTastytradeMarketForTests(options?: {
  sleep?: (ms: number) => Promise<void>;
  maxConcurrent?: number;
}): void {
  cachedToken = null;
  globalLimiter = new Limiter(options?.maxConcurrent ?? TT_MAX_CONCURRENT);
  dxlinkLimiter = new Limiter(DXLINK_MAX_SOCKETS);
  dxlinkConnect = null;
  refreshing = null;
  sleepImpl = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  resetTastytradeStoreForTests();
}

/** Highest number of Tastytrade requests seen in flight at once (tests/diagnostics). */
export function tastytradePeakConcurrency(): number {
  return globalLimiter.peak;
}
