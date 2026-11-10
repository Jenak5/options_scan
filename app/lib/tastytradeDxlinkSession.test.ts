import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { put } from "@vercel/blob";
import {
  dataSourceStatus,
  getPriceHistory,
  resetDataSourceStatsForTests,
} from "@/app/lib/marketData";
import * as schwab from "@/app/lib/schwab";
import type { CandleTransport } from "@/app/lib/tastytradeCandles";
import {
  DXLINK_MAX_SOCKETS,
  dxlinkPeakSockets,
  resetTastytradeMarketForTests,
  setDxlinkConnectForTests,
  ttLastTrades,
  ttPriceHistory,
  ttQuotes,
} from "@/app/lib/tastytradeMarket";
import { TASTYTRADE_ACCESS_BLOB, writeStoredTastytradeAccess } from "@/app/lib/tastytradeStore";
import * as schwabStore from "@/app/lib/schwabStore";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
  put: vi.fn(async () => ({})),
  del: vi.fn(),
}));

const ENV = {
  TASTYTRADE_CLIENT_ID: "id",
  TASTYTRADE_CLIENT_SECRET: "client-secret-value",
  TASTYTRADE_REFRESH_TOKEN: "refresh-token-value",
};

const QUOTE_A = "quote-token-alpha-do-not-leak";
const QUOTE_B = "quote-token-beta-do-not-leak";

function candleMessage(at = Date.now()) {
  return {
    type: "FEED_DATA",
    data: ["Candle", [`SPY{=5m,tho=true}`, at, 10, 11, 9, 10.5, 100]],
  };
}

function transport(messages: unknown[], onAuth?: (token: string) => void): CandleTransport {
  const queue = messages.slice();
  let closed = false;
  return {
    send(data: string) {
      const row = JSON.parse(data) as { type?: string; token?: string };
      if (row.type === "AUTH" && row.token) onAuth?.(row.token);
    },
    close() {
      closed = true;
    },
    next() {
      if (closed) return Promise.resolve(null);
      const next = queue.shift();
      if (!next) return Promise.resolve("timeout");
      return Promise.resolve(JSON.stringify(next));
    },
  };
}

function historyInput(symbol: string) {
  return {
    symbol,
    periodType: "day" as const,
    period: 1,
    frequencyType: "minute" as const,
    frequency: 5,
  };
}

describe("DXLink quote sessions", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    vi.stubEnv("MARKET_DATA_PRIMARY", "tastytrade");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob-token");
    vi.stubEnv("SESSION_SECRET", "session-secret-value-0123456789");
    resetTastytradeMarketForTests({ sleep: async () => {} });
    resetDataSourceStatsForTests();
    vi.mocked(put).mockClear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setDxlinkConnectForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ignores the opening AUTH_STATE UNAUTHORIZED and subscribes only after AUTHORIZED", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let oauth = 0;
    let quotes = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        oauth += 1;
        return new Response(JSON.stringify({ access_token: "access-1", expires_in: 900 }), { status: 200 });
      }
      quotes += 1;
      return new Response(JSON.stringify({
        data: {
          "dxlink-url": "wss://dxlink.example/ws",
          token: QUOTE_A,
          "expires-at": new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      }), { status: 200 });
    });
    const incoming = [
      { type: "AUTH_STATE", channel: 0, state: "UNAUTHORIZED" },
      { type: "KEEPALIVE", channel: 0 },
      { type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" },
      candleMessage(),
    ];
    setDxlinkConnectForTests(async () => ({
      send(data: string) {
        sent.push(JSON.parse(data) as Record<string, unknown>);
      },
      close() {},
      next() {
        const next = incoming.shift();
        if (!next) return Promise.resolve("timeout");
        return Promise.resolve(JSON.stringify(next));
      },
    }));
    const bars = await ttPriceHistory(historyInput("SPY"), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
      quietMs: 0,
    });
    expect(bars.length).toBeGreaterThan(0);
    expect(oauth).toBe(1);
    expect(quotes).toBe(1);
    const types = sent.map((row) => row.type);
    expect(types).toEqual([
      "SETUP",
      "AUTH",
      "KEEPALIVE",
      "CHANNEL_REQUEST",
      "FEED_SETUP",
      "FEED_SUBSCRIPTION",
    ]);
    expect(sent[0]).toMatchObject({
      type: "SETUP",
      channel: 0,
      version: "0.1",
      keepaliveTimeout: 60,
      acceptKeepaliveTimeout: 60,
    });
    expect(sent[1]).toMatchObject({ type: "AUTH", channel: 0, token: QUOTE_A });
    expect(sent[2]).toEqual({ type: "KEEPALIVE", channel: 0 });
    expect(sent[3]).toMatchObject({
      type: "CHANNEL_REQUEST",
      channel: 1,
      service: "FEED",
      parameters: { contract: "AUTO" },
    });
    expect(sent[4]).toMatchObject({
      type: "FEED_SETUP",
      channel: 1,
      acceptAggregationPeriod: 0.1,
      acceptDataFormat: "COMPACT",
      acceptEventFields: { Candle: ["eventSymbol", "time", "open", "high", "low", "close", "volume"] },
    });
    expect(sent[5]).toMatchObject({
      type: "FEED_SUBSCRIPTION",
      channel: 1,
      add: [{ type: "Candle", symbol: expect.stringContaining("SPY{=5m") }],
    });
    const warns = vi.mocked(console.warn).mock.calls.map((call) => String(call[0])).join(" ");
    expect(warns).not.toContain("refreshing once");
    expect(warns).not.toContain("AUTH_STATE UNAUTHORIZED");
  });

  it("waits through the opening UNAUTHORIZED state and fails on timeout without a second token", async () => {
    let oauth = 0;
    let quotes = 0;
    let connects = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        oauth += 1;
        return new Response(JSON.stringify({ access_token: `access-${oauth}`, expires_in: 900 }), { status: 200 });
      }
      quotes += 1;
      return new Response(JSON.stringify({
        data: {
          "dxlink-url": "wss://dxlink.example/ws",
          token: QUOTE_A,
          "expires-at": new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      }), { status: 200 });
    });
    setDxlinkConnectForTests(async () => {
      connects += 1;
      let opened = false;
      return {
        send() {},
        close() {},
        next() {
          if (!opened) {
            opened = true;
            return Promise.resolve(JSON.stringify({ type: "AUTH_STATE", channel: 0, state: "UNAUTHORIZED" }));
          }
          return Promise.resolve("timeout");
        },
      };
    });
    await expect(ttPriceHistory(historyInput("QQQ"), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 40,
      quietMs: 0,
    })).rejects.toThrow("DXLink did not authorize the quote session before the timeout.");
    expect(oauth).toBe(1);
    expect(quotes).toBe(1);
    expect(connects).toBe(1);
    const warns = vi.mocked(console.warn).mock.calls.map((call) => String(call[0])).join(" ");
    expect(warns).not.toContain("refreshing once");
  });

  it("mints a fresh access token immediately before each quote token and does not reuse the quote token", async () => {
    const urls: string[] = [];
    const quoteAuth: string[] = [];
    const socketTokens: string[] = [];
    let oauth = 0;
    let quotes = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      expect(init?.cache).toBe("no-store");
      if (u.endsWith("/oauth/token")) {
        oauth += 1;
        return new Response(JSON.stringify({ access_token: `access-${oauth}`, expires_in: 900 }), { status: 200 });
      }
      quotes += 1;
      const bearer = new Headers(init?.headers).get("Authorization");
      quoteAuth.push(bearer ?? "");
      const future = new Date(Date.now() + 10 * 60_000).toISOString();
      const token = quotes === 1 ? QUOTE_A : QUOTE_B;
      return new Response(JSON.stringify({
        data: { "dxlink-url": "wss://dxlink.example/ws", token, "expires-at": future },
      }), { status: 200 });
    });
    setDxlinkConnectForTests(async () => transport(
      [{ type: "AUTH_STATE", state: "AUTHORIZED" }, candleMessage()],
      (token) => socketTokens.push(token),
    ));
    await ttPriceHistory(historyInput("SPY"), { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, quietMs: 0 });
    await ttPriceHistory(historyInput("QQQ"), { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, quietMs: 0 });
    expect(urls.map((u) => (u.endsWith("/oauth/token") ? "oauth" : "quote"))).toEqual(["oauth", "quote", "oauth", "quote"]);
    expect(quoteAuth).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(socketTokens).toEqual([QUOTE_A, QUOTE_B]);
    expect(new Set(socketTokens).size).toBe(2);
    const logs = vi.mocked(console.info).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toMatch(/quote token expires at \d{4}-\d{2}-\d{2}T/);
    expect(logs).not.toContain(QUOTE_A);
    expect(logs).not.toContain(QUOTE_B);
    expect(logs).not.toContain("refresh-token-value");
    expect(logs).not.toContain("access-1");
  });

  it("discards an expired quote token and opens the socket with the replacement", async () => {
    const socketTokens: string[] = [];
    let quotes = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: `access-${quotes + 1}`, expires_in: 900 }), { status: 200 });
      }
      quotes += 1;
      if (quotes === 1) {
        return new Response(JSON.stringify({
          data: {
            "dxlink-url": "wss://dxlink.example/ws",
            token: QUOTE_A,
            "expires-at": new Date(Date.now() - 60_000).toISOString(),
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          "dxlink-url": "wss://dxlink.example/ws",
          token: QUOTE_B,
          "expires-at": new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      }), { status: 200 });
    });
    let connects = 0;
    setDxlinkConnectForTests(async () => {
      connects += 1;
      return transport(
        [{ type: "AUTH_STATE", state: "AUTHORIZED" }, candleMessage()],
        (token) => socketTokens.push(token),
      );
    });
    const bars = await ttPriceHistory(historyInput("SPY"), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
      quietMs: 0,
    });
    expect(bars.length).toBeGreaterThan(0);
    expect(quotes).toBe(2);
    expect(connects).toBe(1);
    expect(socketTokens).toEqual([QUOTE_B]);
  });

  it("retries one auth-related DXLink error with a new access and quote token", async () => {
    let oauth = 0;
    let quotes = 0;
    let connects = 0;
    const socketTokens: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        oauth += 1;
        return new Response(JSON.stringify({ access_token: `access-${oauth}`, expires_in: 900 }), { status: 200 });
      }
      quotes += 1;
      const token = quotes === 1 ? QUOTE_A : QUOTE_B;
      return new Response(JSON.stringify({
        data: {
          "dxlink-url": "wss://dxlink.example/ws",
          token,
          "expires-at": new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      }), { status: 200 });
    });
    setDxlinkConnectForTests(async () => {
      connects += 1;
      const which = connects;
      const messages = which === 1
        ? [{ type: "ERROR", error: "UNAUTHORIZED", reason: "token_expired", message: `rejected ${QUOTE_A}` }]
        : [{ type: "AUTH_STATE", state: "AUTHORIZED" }, candleMessage()];
      return transport(messages, (token) => socketTokens.push(token));
    });
    const bars = await ttPriceHistory(historyInput("NVDA"), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
      quietMs: 0,
    });
    expect(bars.length).toBeGreaterThan(0);
    expect(oauth).toBe(2);
    expect(quotes).toBe(2);
    expect(connects).toBe(2);
    expect(socketTokens).toEqual([QUOTE_A, QUOTE_B]);
  });

  it("does not loop the token endpoint when the auth error repeats", async () => {
    let oauth = 0;
    let connects = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        oauth += 1;
        if (oauth > 2) throw new Error("token endpoint loop");
        return new Response(JSON.stringify({ access_token: `access-${oauth}`, expires_in: 900 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          "dxlink-url": "wss://dxlink.example/ws",
          token: QUOTE_A,
          "expires-at": new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      }), { status: 200 });
    });
    setDxlinkConnectForTests(async () => {
      connects += 1;
      return transport([{
        type: "ERROR",
        error: "UNAUTHORIZED",
        reason: "token_expired",
        message: `bearer ${QUOTE_A}`,
      }]);
    });
    await expect(ttPriceHistory(historyInput("TSLA"), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
      quietMs: 0,
    })).rejects.toThrow(/DXLink error=UNAUTHORIZED/);
    expect(oauth).toBe(2);
    expect(connects).toBe(2);
  });

  it("stores the redacted DXLink error and reason, and notes that Schwab was not called", async () => {
    vi.spyOn(schwab, "schwabBackupAvailable").mockResolvedValue(false);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "access-token", expires_in: 900 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          "dxlink-url": "wss://dxlink.example/ws",
          token: QUOTE_A,
          "expires-at": new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    setDxlinkConnectForTests(async () => transport([{
      type: "ERROR",
      error: "UNAUTHORIZED",
      reason: "token_expired",
      message: `session rejected ${QUOTE_A} bearer secret-access`,
    }]));
    await expect(getPriceHistory(historyInput("AAPL"))).rejects.toThrow(/DXLink error=UNAUTHORIZED/);
    const status = dataSourceStatus();
    expect(status.lastError).toContain("error=UNAUTHORIZED");
    expect(status.lastError).toContain("reason=token_expired");
    expect(status.lastError).toContain("message=session rejected");
    expect(status.lastError).toContain("[redacted]");
    expect(status.lastError).not.toContain(QUOTE_A);
    expect(status.lastError).not.toContain("secret-access");
    expect(status.lastError).not.toContain("Schwab");
    expect(status.backupNote).toBe("Schwab backup not connected");
    expect(status.preferred).toBe("tastytrade");
    expect(schwab.schwabBackupAvailable).toHaveBeenCalled();
    expect(vi.mocked(put).mock.calls.map((call) => call[0])).not.toContain(TASTYTRADE_ACCESS_BLOB);
  });

  it("caps DXLink sockets and closes one before opening the next", async () => {
    let active = 0;
    let peak = 0;
    let overlapped = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: `access-${Date.now()}`, expires_in: 900 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          "dxlink-url": "wss://dxlink.example/ws",
          token: `quote-${Math.random()}`,
          "expires-at": new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      }), { status: 200 });
    });
    setDxlinkConnectForTests(async () => {
      active += 1;
      if (active > 1) overlapped = true;
      peak = Math.max(peak, active);
      let closed = false;
      const queue = [{ type: "AUTH_STATE", state: "AUTHORIZED" }, candleMessage()];
      return {
        send() {},
        close() {
          if (!closed) {
            closed = true;
            active -= 1;
          }
        },
        next() {
          const next = queue.shift();
          if (!next) return Promise.resolve("timeout");
          return Promise.resolve(JSON.stringify(next));
        },
      };
    });
    await Promise.all([
      ttPriceHistory(historyInput("SPY"), { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, quietMs: 0 }),
      ttPriceHistory(historyInput("QQQ"), { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, quietMs: 0 }),
    ]);
    expect(DXLINK_MAX_SOCKETS).toBeGreaterThanOrEqual(1);
    expect(DXLINK_MAX_SOCKETS).toBeLessThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(DXLINK_MAX_SOCKETS);
    expect(dxlinkPeakSockets()).toBeLessThanOrEqual(DXLINK_MAX_SOCKETS);
    expect(overlapped).toBe(false);
    expect(active).toBe(0);
  });

  it("mints a fresh quote token for a trade snapshot and does not write the access token to Blob", async () => {
    const encrypt = vi.spyOn(schwabStore, "encryptTokenPayload");
    const seen: string[] = [];
    let oauth = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      expect(init?.cache).toBe("no-store");
      if (u.endsWith("/oauth/token")) {
        oauth += 1;
        return new Response(JSON.stringify({ access_token: `access-${oauth}`, expires_in: 900 }), { status: 200 });
      }
      if (u.includes("/api-quote-tokens")) {
        seen.push((new Headers(init?.headers).get("Authorization") ?? "").replace("Bearer ", ""));
        return new Response(JSON.stringify({
          data: { "dxlink-url": "wss://dxlink.example/ws", token: `q-${oauth}`, "expires-at": new Date(Date.now() + 60_000).toISOString() },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
    });
    setDxlinkConnectForTests(async () => transport([
      { type: "AUTH_STATE", state: "AUTHORIZED" },
      { type: "FEED_DATA", data: ["Trade", [".SPY261030C670", 1.2, 1, Date.now(), 4]] },
    ]));
    await ttLastTrades(["SPY   261030C00670000"], { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, quietMs: 0 });
    await ttLastTrades(["QQQ   261030C00450000"], { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, quietMs: 0 });
    expect(seen).toEqual(["access-1", "access-2"]);
    expect(oauth).toBe(2);
    await ttQuotes({ equity: ["SPY"] }, fetchImpl as unknown as typeof fetch);
    const restCalls = fetchImpl.mock.calls.filter((call) => String(call[0]).includes("/market-data/"));
    expect(restCalls.length).toBeGreaterThan(0);
    expect(restCalls[0][1]).toMatchObject({ cache: "no-store" });
    expect(vi.mocked(put).mock.calls.map((call) => call[0])).not.toContain(TASTYTRADE_ACCESS_BLOB);
    expect(encrypt).not.toHaveBeenCalled();
    const bodies = vi.mocked(put).mock.calls.map((call) => JSON.stringify(call[1] ?? ""));
    expect(bodies.join(" ")).not.toContain("refresh-token-value");
    await writeStoredTastytradeAccess({ access: "memory-only", mintedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    expect(vi.mocked(put).mock.calls.map((call) => call[0])).not.toContain(TASTYTRADE_ACCESS_BLOB);
  });
});
