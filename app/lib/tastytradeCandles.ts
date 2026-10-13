import type { CandleBar } from "@/app/lib/candleTypes";
import { candleSubscriptionSymbol, streamerSymbolKey } from "@/app/lib/optionStreamer";

/**
 * Server-only DXLink candle client.
 * Reads TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, and TASTYTRADE_REFRESH_TOKEN.
 * This does not place orders and it does not use the account-tab login flag.
 * One session subscribes to at most CANDLE_SUBSCRIPTION_LIMIT candles.
 */

if (typeof window !== "undefined") {
  throw new Error("The Tastytrade candle client is server-only.");
}

const TOKEN_URL = "https://api.tastyworks.com/oauth/token";
const QUOTE_URL = "https://api.tastyworks.com/api-quote-tokens";
const USER_AGENT = "options-scan/1.0";

/** DXLink allows 100 Candle subscriptions on one session. Further symbols use another session. */
export const CANDLE_SUBSCRIPTION_LIMIT = 100;

const CANDLE_FIELDS = ["eventSymbol", "time", "open", "high", "low", "close", "volume"] as const;

export interface CandleSubscription {
  /** Streamer symbol without the candle suffix, for example .TLT261113P77.5 */
  streamer: string;
  /** Epoch milliseconds. DXLink fromTime. */
  fromTime: number;
}

export interface DxlinkState {
  phase: "auth" | "streaming";
  subs: CandleSubscription[];
}

export interface DxlinkStep {
  state: DxlinkState;
  send: object[];
  candles: ParsedCandle[];
  error: string | null;
}

export interface ParsedCandle extends CandleBar {
  symbol: string;
}

export interface CandleFetchResult {
  /** Keyed by streamer symbol, without "{=1m}". */
  candles: Map<string, CandleBar[]>;
  /** Streamer symbols whose session finished. An empty list means no trades, not a failure. */
  completed: string[];
  errors: string[];
}

interface QuoteSession {
  url: string;
  token: string;
}

interface CandleTransport {
  send(data: string): void;
  close(): void;
  next(waitMs: number): Promise<string | null | "timeout">;
}

type Connect = (url: string) => Promise<CandleTransport>;

export function tastytradeCandleConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return present(env.TASTYTRADE_CLIENT_ID)
    && present(env.TASTYTRADE_CLIENT_SECRET)
    && present(env.TASTYTRADE_REFRESH_TOKEN);
}

export function chunkCandleSubs<T>(items: readonly T[], limit: number = CANDLE_SUBSCRIPTION_LIMIT): T[][] {
  if (limit < 1) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += limit) out.push(items.slice(i, i + limit));
  return out;
}

export function dxlinkOpening(token: string): object[] {
  return [
    {
      type: "SETUP",
      channel: 0,
      version: "0.1",
      keepaliveTimeout: 60,
      acceptKeepaliveTimeout: 60,
    },
    { type: "AUTH", channel: 0, token },
  ];
}

/**
 * CHANNEL_REQUEST, FEED_SETUP, and the Candle subscription are returned only
 * after AUTH_STATE AUTHORIZED. A KEEPALIVE before that is answered and does
 * not open the feed.
 */
export function handleDxlinkMessage(state: DxlinkState, message: unknown): DxlinkStep {
  const row = asRecord(message);
  const type = typeof row?.type === "string" ? row.type : "";
  if (type === "KEEPALIVE") {
    return { state, send: [{ type: "KEEPALIVE", channel: 0 }], candles: [], error: null };
  }
  if (type === "ERROR") {
    return { state, send: [], candles: [], error: clip(dxErrorText(row)) };
  }
  if (type === "AUTH_STATE") {
    if (row?.state !== "AUTHORIZED" || state.phase === "streaming") {
      return { state, send: [], candles: [], error: null };
    }
    return {
      state: { ...state, phase: "streaming" },
      send: feedMessages(state.subs),
      candles: [],
      error: null,
    };
  }
  if (type === "FEED_DATA" && state.phase === "streaming") {
    return { state, send: [], candles: parseCompactCandles(row?.data), error: null };
  }
  return { state, send: [], candles: [], error: null };
}

export function parseCompactCandles(data: unknown): ParsedCandle[] {
  if (!Array.isArray(data)) return [];
  const out: ParsedCandle[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== "Candle") continue;
    const values = data[i + 1];
    if (!Array.isArray(values)) continue;
    for (let j = 0; j + 6 < values.length; j += CANDLE_FIELDS.length) {
      const parsed = parseCompactRow(values, j);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

export async function fetchOptionCandles(
  subs: readonly CandleSubscription[],
  deps?: {
    fetchImpl?: typeof fetch;
    connect?: Connect;
    timeoutMs?: number;
    quietMs?: number;
    emptyWaitMs?: number;
    env?: Record<string, string | undefined>;
  },
): Promise<CandleFetchResult> {
  const candles = new Map<string, CandleBar[]>();
  const completed: string[] = [];
  const errors: string[] = [];
  const usable = subs.filter((sub) => sub.streamer.startsWith(".") && Number.isFinite(sub.fromTime));
  const batches = chunkCandleSubs(usable, CANDLE_SUBSCRIPTION_LIMIT);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const connect = deps?.connect ?? connectNodeWebSocket;
  const timeoutMs = deps?.timeoutMs ?? 25_000;
  const quietMs = deps?.quietMs ?? 2500;
  const emptyWaitMs = deps?.emptyWaitMs ?? 8000;
  const env = deps?.env ?? process.env;
  if (!tastytradeCandleConfigured(env)) {
    return {
      candles,
      completed,
      errors: ["Tastytrade candles are not configured."],
    };
  }
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const session = await openQuoteSession(fetchImpl, env);
      const result = await runDxlinkBatch(session, batch, connect, timeoutMs, quietMs, emptyWaitMs);
      result.candles.forEach((bars, symbol) => {
        candles.set(symbol, bars);
      });
      if (result.completed) {
        for (let j = 0; j < batch.length; j++) completed.push(batch[j].streamer);
      } else if (result.error) {
        errors.push(result.error);
      }
    } catch (err) {
      errors.push(clip(err instanceof Error ? err.message : "Candle fetch failed"));
    }
  }
  return { candles, completed, errors: errors.slice(0, 8) };
}

export function feedMessages(subs: readonly CandleSubscription[]): object[] {
  return [
    {
      type: "CHANNEL_REQUEST",
      channel: 1,
      service: "FEED",
      parameters: { contract: "AUTO" },
    },
    {
      type: "FEED_SETUP",
      channel: 1,
      acceptAggregationPeriod: 0.1,
      acceptDataFormat: "COMPACT",
      acceptEventFields: { Candle: [...CANDLE_FIELDS] },
    },
    {
      type: "FEED_SUBSCRIPTION",
      channel: 1,
      add: subs.map((sub) => ({
        type: "Candle",
        symbol: candleSubscriptionSymbol(sub.streamer),
        fromTime: Math.floor(sub.fromTime),
      })),
    },
  ];
}

async function openQuoteSession(
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined>,
): Promise<QuoteSession> {
  const clientId = env.TASTYTRADE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.TASTYTRADE_CLIENT_SECRET?.trim() ?? "";
  const refreshToken = env.TASTYTRADE_REFRESH_TOKEN?.trim() ?? "";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const oauth = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!oauth.ok) {
    throw new Error(`Tastytrade OAuth failed (${oauth.status})`);
  }
  const oauthJson = await oauth.json() as Record<string, unknown>;
  const access = typeof oauthJson.access_token === "string" ? oauthJson.access_token : "";
  if (!access) throw new Error("Tastytrade OAuth did not return an access token");
  const quote = await fetchImpl(QUOTE_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
    },
  });
  if (!quote.ok) throw new Error(`Tastytrade quote token failed (${quote.status})`);
  const quoteJson = await quote.json() as { data?: Record<string, unknown> };
  const data = quoteJson.data ?? {};
  const url = typeof data["dxlink-url"] === "string" ? data["dxlink-url"] : "";
  const token = typeof data.token === "string" ? data.token : "";
  if (!url || !token) throw new Error("Tastytrade quote token did not include a DXLink URL and token");
  return { url, token };
}

async function runDxlinkBatch(
  session: QuoteSession,
  subs: readonly CandleSubscription[],
  connect: Connect,
  timeoutMs: number,
  quietMs: number,
  emptyWaitMs: number,
): Promise<{ candles: Map<string, CandleBar[]>; completed: boolean; error: string | null }> {
  const transport = await connect(session.url);
  const byTime = new Map<string, Map<number, CandleBar>>();
  let state: DxlinkState = { phase: "auth", subs: subs.slice() };
  let error: string | null = null;
  const deadline = Date.now() + timeoutMs;
  let lastDataAt = 0;
  let subscribedAt = 0;
  let sawHeartbeat = false;
  try {
    const opening = dxlinkOpening(session.token);
    for (let i = 0; i < opening.length; i++) transport.send(JSON.stringify(opening[i]));
    while (Date.now() < deadline) {
      if (historySettled(lastDataAt, sawHeartbeat, subscribedAt, quietMs, emptyWaitMs)) break;
      const wait = lastDataAt > 0
        ? Math.min(2500, deadline - Date.now())
        : Math.min(5000, deadline - Date.now());
      const incoming = await transport.next(Math.max(1, wait));
      if (incoming === "timeout") continue;
      if (incoming == null) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(incoming);
      } catch {
        continue;
      }
      const step = handleDxlinkMessage(state, parsed);
      state = step.state;
      if (state.phase === "streaming" && subscribedAt === 0) subscribedAt = Date.now();
      for (let i = 0; i < step.send.length; i++) transport.send(JSON.stringify(step.send[i]));
      if (step.error && !error) error = step.error;
      if (step.candles.length > 0) {
        lastDataAt = Date.now();
        absorb(byTime, step.candles);
      } else if (state.phase === "streaming" && isKeepalive(parsed)) {
        sawHeartbeat = true;
      }
    }
  } finally {
    transport.close();
  }
  const candles = new Map<string, CandleBar[]>();
  byTime.forEach((times, symbol) => {
    const bars = Array.from(times.values()).sort((a, b) => a.t - b.t);
    if (bars.length > 0) candles.set(symbol, bars);
  });
  const settled = historySettled(lastDataAt, sawHeartbeat, subscribedAt, quietMs, emptyWaitMs);
  const completed = state.phase === "streaming" && error == null && settled;
  if (!completed && !error) {
    error = state.phase === "auth"
      ? "DXLink did not authorize the quote session."
      : "DXLink returned no candles before the timeout.";
  }
  return { candles, completed, error };
}

/** Data went quiet, or the feed stayed up and simply had no trades. A hard timeout is not settled. */
function historySettled(
  lastDataAt: number,
  sawHeartbeat: boolean,
  subscribedAt: number,
  quietMs: number,
  emptyWaitMs: number,
): boolean {
  if (lastDataAt > 0) return Date.now() - lastDataAt >= quietMs;
  return sawHeartbeat && subscribedAt > 0 && Date.now() - subscribedAt >= emptyWaitMs;
}

function isKeepalive(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as { type?: unknown }).type === "KEEPALIVE");
}

function absorb(into: Map<string, Map<number, CandleBar>>, candles: readonly ParsedCandle[]): void {
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    let times = into.get(candle.symbol);
    if (!times) {
      times = new Map();
      into.set(candle.symbol, times);
    }
    times.set(candle.t, { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
  }
}

function parseCompactRow(values: unknown[], offset: number): ParsedCandle | null {
  const symbol = streamerSymbolKey(typeof values[offset] === "string" ? values[offset] as string : "");
  const t = epochMs(values[offset + 1]);
  const o = positive(values[offset + 2]);
  const h = positive(values[offset + 3]);
  const l = positive(values[offset + 4]);
  const c = positive(values[offset + 5]);
  if (!symbol.startsWith(".") || t == null || o == null || h == null || l == null || c == null) return null;
  if (h + 1e-9 < l) return null;
  return { symbol, t, o, h, l, c };
}

function epochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1_000_000_000_000) return null;
  return value;
}

function positive(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dxErrorText(row: Record<string, unknown> | null): string {
  const message = row && typeof row.message === "string" ? row.message : "DXLink error";
  return message;
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function clip(value: string): string {
  return value.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/\s+/g, " ").slice(0, 180);
}

function connectNodeWebSocket(url: string): Promise<CandleTransport> {
  if (typeof globalThis.WebSocket === "function") {
    return openDomSocket(url, globalThis.WebSocket);
  }
  return import("ws").then((mod) => openEmitterSocket(url, mod.WebSocket));
}

function openDomSocket(url: string, WS: typeof WebSocket): Promise<CandleTransport> {
  return openQueuedSocket(url, (onOpen, onFail, onText, onClose) => {
    const ws = new WS(url);
    ws.addEventListener("error", onFail);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", (event) => {
      onText(typeof event.data === "string" ? event.data : "");
    });
    ws.addEventListener("close", onClose);
    return {
      send(data: string) {
        ws.send(data);
      },
      close() {
        ws.close();
      },
    };
  });
}

function openEmitterSocket(
  url: string,
  WS: new (address: string) => {
    send(data: string): void;
    close(): void;
    on(event: "open" | "error" | "close", listener: () => void): void;
    on(event: "message", listener: (data: unknown) => void): void;
  },
): Promise<CandleTransport> {
  return openQueuedSocket(url, (onOpen, onFail, onText, onClose) => {
    const ws = new WS(url);
    ws.on("error", onFail);
    ws.on("open", onOpen);
    ws.on("message", (data) => onText(wsDataToString(data)));
    ws.on("close", onClose);
    return {
      send(data: string) {
        ws.send(data);
      },
      close() {
        ws.close();
      },
    };
  });
}

function openQueuedSocket(
  _url: string,
  attach: (
    onOpen: () => void,
    onFail: () => void,
    onText: (text: string) => void,
    onClose: () => void,
  ) => { send(data: string): void; close(): void },
): Promise<CandleTransport> {
  return new Promise((resolve, reject) => {
    const queue: string[] = [];
    let waiter: ((value: string | null) => void) | null = null;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("DXLink connection failed"));
    };
    const socket = attach(
      () => {
        if (settled) return;
        settled = true;
        resolve({
          send(data: string) {
            socket.send(data);
          },
          close() {
            socket.close();
          },
          next(waitMs: number) {
            if (queue.length > 0) return Promise.resolve(queue.shift() ?? null);
            return new Promise((done) => {
              const timer = setTimeout(() => {
                if (waiter) waiter = null;
                done("timeout");
              }, waitMs);
              waiter = (value) => {
                clearTimeout(timer);
                done(value);
              };
            });
          },
        });
      },
      fail,
      (text) => {
        if (!text) return;
        if (waiter) {
          const pending = waiter;
          waiter = null;
          pending(text);
        } else {
          queue.push(text);
        }
      },
      () => {
        if (!settled) {
          fail();
          return;
        }
        if (waiter) {
          const pending = waiter;
          waiter = null;
          pending(null);
        }
      },
    );
  });
}

function wsDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  return "";
}
