import type { CandleBar } from "@/app/lib/candleTypes";
import { candleSubscriptionSymbol, streamerSymbolKey, type CandlePeriod } from "@/app/lib/optionStreamer";

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

/** A DXLink socket that has not opened by then is closed and reported as failed. */
export const DXLINK_OPEN_TIMEOUT_MS = 10_000;

/** Every REST call to Tastytrade gives up after this. */
export const TASTYTRADE_REST_TIMEOUT_MS = 15_000;

const CANDLE_FIELDS = ["eventSymbol", "time", "open", "high", "low", "close", "volume"] as const;

export interface CandleSubscription {
  /** Streamer symbol without the candle suffix, for example .TLT261113P77.5 */
  streamer: string;
  /** Epoch milliseconds. DXLink fromTime. */
  fromTime: number;
  /** Defaults to 1m. Underlying (non-option) symbols must set a period. */
  period?: CandlePeriod;
  /** Regular session only (`tho=true`). Off leaves the feed's default, which includes extended hours. */
  regularHours?: boolean;
  /**
   * Optional. When every subscription in a batch has a bar at or before coverFrom and a bar at or
   * after coverUntil, the batch stops at once instead of waiting for the feed to go quiet.
   * During market hours live bars keep arriving, so without this the fetch runs to its timeout.
   */
  coverFrom?: number;
  coverUntil?: number;
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
  /**
   * Tastytrade OAuth `error` and `error_description` from this run.
   * Null when the token request succeeded. Never includes secrets.
   */
  errorSample: string | null;
}

export interface TastytradeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface TastytradeTokenRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** JSON body. A string, so fetch does not add a charset. */
  body: string;
}

export interface QuoteSession {
  url: string;
  token: string;
}

export interface CandleTransport {
  send(data: string): void;
  close(): void;
  next(waitMs: number): Promise<string | null | "timeout">;
}

type Connect = (url: string) => Promise<CandleTransport>;

/** One OAuth access token, reused for every quote session in a run. */
export interface CandleAccess {
  access: string;
  /** From the OAuth expires_in, when present. */
  expiresInMs?: number | null;
}

export function tastytradeCandleConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readTastytradeCredentials(env) != null;
}

/** Drop CR/LF anywhere, then trim. Vercel values are sometimes pasted with a trailing newline. */
export function cleanTastytradeEnv(value: string | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, "").trim();
}

export function readTastytradeCredentials(
  env: Record<string, string | undefined> = process.env,
): TastytradeCredentials | null {
  const clientId = cleanTastytradeEnv(env.TASTYTRADE_CLIENT_ID);
  const clientSecret = cleanTastytradeEnv(env.TASTYTRADE_CLIENT_SECRET);
  const refreshToken = cleanTastytradeEnv(env.TASTYTRADE_REFRESH_TOKEN);
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/**
 * Documented Tastytrade refresh (OAuth2, current guide):
 * POST https://api.tastyworks.com/oauth/token
 * Content-Type: application/json
 * grant_type, refresh_token, and client_secret. client_id is optional and must match if sent.
 * User-Agent is required. A missing User-Agent is rejected with 401.
 * The body is a string so the content type stays without ";charset".
 * Username login was removed on 2026-02-11. This client only refreshes an OAuth access token.
 * Refreshing does not return a new refresh token. Do not overwrite the one in the environment.
 */
export function tastytradeTokenRequest(creds: TastytradeCredentials): TastytradeTokenRequest {
  const payload: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_secret: creds.clientSecret,
  };
  if (creds.clientId) payload.client_id = creds.clientId;
  return {
    url: TOKEN_URL,
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  };
}

/**
 * Keep only OAuth `error` and `error_description`. The raw body is not returned:
 * a 400 can echo the form, including the refresh token.
 */
export function tastytradeOAuthErrorSample(
  status: number,
  body: string,
  secrets: readonly string[] = [],
): string {
  let error = "";
  let description = "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.error === "string") error = parsed.error;
    if (typeof parsed.error_description === "string") description = parsed.error_description;
  } catch {
    error = "";
  }
  const text = [error, description].filter((part) => part.length > 0).join(": ");
  const safe = redactSecrets(text, secrets);
  if (!safe) return `Tastytrade OAuth failed (${status})`;
  return clip(safe);
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

export async function openCandleAccess(deps?: {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<{ access: CandleAccess; errorSample: null } | { access: null; errorSample: string }> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const env = deps?.env ?? process.env;
  const creds = readTastytradeCredentials(env);
  if (!creds) return { access: null, errorSample: "Tastytrade candles are not configured." };
  try {
    const minted = await requestAccessToken(fetchImpl, creds);
    return { access: { access: minted.access, expiresInMs: minted.expiresInMs }, errorSample: null };
  } catch (err) {
    const sample = err instanceof TastytradeOAuthError
      ? err.sample
      : clip(err instanceof Error ? err.message : "Tastytrade OAuth failed");
    return { access: null, errorSample: sample };
  }
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
    /** When set, this run does not request another OAuth token. */
    access?: CandleAccess | null;
  },
): Promise<CandleFetchResult> {
  const candles = new Map<string, CandleBar[]>();
  const completed: string[] = [];
  const errors: string[] = [];
  const usable = subs.filter((sub) => (sub.streamer.startsWith(".") || sub.period != null) && Number.isFinite(sub.fromTime));
  const batches = chunkCandleSubs(usable, CANDLE_SUBSCRIPTION_LIMIT);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const connect = deps?.connect ?? connectNodeWebSocket;
  const timeoutMs = deps?.timeoutMs ?? 25_000;
  const quietMs = deps?.quietMs ?? 2500;
  const emptyWaitMs = deps?.emptyWaitMs ?? 8000;
  const env = deps?.env ?? process.env;
  let access = deps?.access?.access ?? "";
  if (!access) {
    const opened = await openCandleAccess({ fetchImpl, env });
    if (!opened.access) {
      return { candles, completed, errors: [opened.errorSample], errorSample: opened.errorSample };
    }
    access = opened.access.access;
  }
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const session = await openQuoteSession(fetchImpl, access);
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
  return { candles, completed, errors: errors.slice(0, 8), errorSample: null };
}

/** Read-only GET against the Tastytrade REST API with an OAuth access token. Null on any failure. */
export async function tastytradeGetJson(
  access: CandleAccess,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  try {
    const res = await fetchImpl(`https://api.tastyworks.com${path}`, {
      headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${access.access}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TASTYTRADE_REST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

class TastytradeOAuthError extends Error {
  readonly sample: string;

  constructor(sample: string) {
    super(sample);
    this.name = "TastytradeOAuthError";
    this.sample = sample;
  }
}

async function requestAccessToken(
  fetchImpl: typeof fetch,
  creds: TastytradeCredentials,
): Promise<{ access: string; expiresInMs: number | null }> {
  const request = tastytradeTokenRequest(creds);
  const oauth = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(TASTYTRADE_REST_TIMEOUT_MS),
  });
  if (!oauth.ok) {
    const body = await oauth.text().catch(() => "");
    const sample = tastytradeOAuthErrorSample(oauth.status, body, [creds.clientSecret, creds.refreshToken]);
    console.error(`Tastytrade OAuth failed (${oauth.status}): ${sample}`);
    throw new TastytradeOAuthError(sample);
  }
  const oauthJson = await oauth.json() as Record<string, unknown>;
  const access = typeof oauthJson.access_token === "string" ? oauthJson.access_token : "";
  if (!access) throw new TastytradeOAuthError("Tastytrade OAuth did not return an access token");
  const expiresIn = Number(oauthJson.expires_in);
  return { access, expiresInMs: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : null };
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
        symbol: candleSubscriptionSymbol(sub.streamer, sub.period ?? "1m", sub.regularHours === true),
        fromTime: Math.floor(sub.fromTime),
      })),
    },
  ];
}

export async function openQuoteSession(fetchImpl: typeof fetch, access: string): Promise<QuoteSession> {
  const quote = await fetchImpl(QUOTE_URL, {
    signal: AbortSignal.timeout(TASTYTRADE_REST_TIMEOUT_MS),
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
  let covered = false;
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
        if (rangeCovered(subs, byTime)) {
          covered = true;
          break;
        }
      } else if (state.phase === "streaming" && isKeepalive(parsed)) {
        sawHeartbeat = true;
      }
    }
  } finally {
    try {
      transport.close();
    } catch {
      // Already closed.
    }
  }
  const candles = new Map<string, CandleBar[]>();
  byTime.forEach((times, symbol) => {
    const bars = Array.from(times.values()).sort((a, b) => a.t - b.t);
    if (bars.length > 0) candles.set(symbol, bars);
  });
  const settled = historySettled(lastDataAt, sawHeartbeat, subscribedAt, quietMs, emptyWaitMs);
  const completed = state.phase === "streaming" && error == null && (settled || covered);
  if (!completed && !error) {
    error = state.phase === "auth"
      ? "DXLink did not authorize the quote session."
      : "DXLink returned no candles before the timeout.";
  }
  return { candles, completed, error };
}

/** True when every subscription asked for a range and has bars at both ends of it. */
export function rangeCovered(
  subs: readonly CandleSubscription[],
  byTime: ReadonlyMap<string, ReadonlyMap<number, CandleBar>>,
): boolean {
  if (subs.length === 0) return false;
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    if (sub.coverFrom == null || sub.coverUntil == null) return false;
    const times = byTime.get(streamerSymbolKey(sub.streamer));
    if (!times || times.size === 0) return false;
    let low = Infinity;
    let high = -Infinity;
    times.forEach((_bar, t) => {
      if (t < low) low = t;
      if (t > high) high = t;
    });
    if (low > sub.coverFrom || high < sub.coverUntil) return false;
  }
  return true;
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
    const bar: CandleBar = { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c };
    if (candle.v != null) bar.v = candle.v;
    times.set(candle.t, bar);
  }
}

function parseCompactRow(values: unknown[], offset: number): ParsedCandle | null {
  const symbol = streamerSymbolKey(typeof values[offset] === "string" ? values[offset] as string : "");
  const t = epochMs(values[offset + 1]);
  const o = positive(values[offset + 2]);
  const h = positive(values[offset + 3]);
  const l = positive(values[offset + 4]);
  const c = positive(values[offset + 5]);
  if (!symbol || t == null || o == null || h == null || l == null || c == null) return null;
  if (h + 1e-9 < l) return null;
  const rawVolume = values[offset + 6];
  const out: ParsedCandle = { symbol, t, o, h, l, c };
  if (!symbol.startsWith(".") && typeof rawVolume === "number" && Number.isFinite(rawVolume) && rawVolume >= 0) out.v = rawVolume;
  return out;
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

function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (let i = 0; i < secrets.length; i++) {
    const secret = secrets[i];
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(
      /(refresh_token|client_secret|access_token)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      "$1$2[redacted]",
    );
}

function clip(value: string): string {
  return value.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/\s+/g, " ").slice(0, 180);
}

export function connectNodeWebSocket(url: string): Promise<CandleTransport> {
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
    let closed = false;
    let socketRef: { close(): void } | null = null;
    // The open handshake can stall without an error or close event. Never wait on it forever.
    const openTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socketRef?.close();
      } catch {
        // Already closed.
      }
      reject(new Error(`DXLink connection did not open within ${DXLINK_OPEN_TIMEOUT_MS / 1000} s`));
    }, DXLINK_OPEN_TIMEOUT_MS);
    const fail = () => {
      clearTimeout(openTimer);
      closed = true;
      if (waiter) {
        const pending = waiter;
        waiter = null;
        pending(null);
      }
      if (settled) return;
      settled = true;
      reject(new Error("DXLink connection failed"));
    };
    const socket = attach(
      () => {
        clearTimeout(openTimer);
        if (settled) {
          // The open timer already gave up. Do not leave this socket running.
          try {
            socket.close();
          } catch {
            // Already closed.
          }
          return;
        }
        settled = true;
        resolve({
          send(data: string) {
            if (closed) return;
            try {
              socket.send(data);
            } catch {
              closed = true;
            }
          },
          close() {
            closed = true;
            try {
              socket.close();
            } catch {
              // Already closed.
            }
          },
          next(waitMs: number) {
            if (queue.length > 0) return Promise.resolve(queue.shift() ?? null);
            if (closed) return Promise.resolve(null);
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
        closed = true;
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
    socketRef = socket;
  });
}

function wsDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  return "";
}
