import { afterEach, describe, expect, it, vi } from "vitest";
import { tastytradeStreamerSymbol } from "@/app/lib/optionStreamer";
import {
  CANDLE_SUBSCRIPTION_LIMIT,
  chunkCandleSubs,
  dxlinkOpening,
  fetchOptionCandles,
  handleDxlinkMessage,
  parseCompactCandles,
  type CandleSubscription,
  type DxlinkState,
} from "@/app/lib/tastytradeCandles";

const ENV = {
  TASTYTRADE_CLIENT_ID: "client-id",
  TASTYTRADE_CLIENT_SECRET: "client-secret",
  TASTYTRADE_REFRESH_TOKEN: "refresh-token",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tastytrade candle protocol", () => {
  const subs: CandleSubscription[] = [{ streamer: ".TLT261113P77.5", fromTime: 1_756_699_200_000 }];
  const auth: DxlinkState = { phase: "auth", subs };

  it("builds the streamer symbol the candle proof subscribed to", () => {
    expect(tastytradeStreamerSymbol({
      ticker: "TLT",
      expiration: "2026-11-13",
      strike: 77.5,
      putCall: "put",
    })).toBe(".TLT261113P77.5");
    expect(tastytradeStreamerSymbol({
      ticker: "SPY",
      expiration: "2026-09-18",
      strike: 670,
      putCall: "call",
    })).toBe(".SPY260918C670");
  });

  it("answers keepalive and waits for AUTHORIZED before the feed subscription", () => {
    expect(dxlinkOpening("quote-token").map((row) => (row as { type: string }).type)).toEqual(["SETUP", "AUTH"]);
    const keepalive = handleDxlinkMessage(auth, { type: "KEEPALIVE", channel: 0 });
    expect(keepalive.send).toEqual([{ type: "KEEPALIVE", channel: 0 }]);
    expect(keepalive.state.phase).toBe("auth");
    expect(keepalive.send.some((row) => (row as { type: string }).type === "CHANNEL_REQUEST")).toBe(false);

    const waiting = handleDxlinkMessage(auth, { type: "AUTH_STATE", state: "UNAUTHORIZED" });
    expect(waiting.send).toEqual([]);
    expect(waiting.state.phase).toBe("auth");

    const authorized = handleDxlinkMessage(auth, { type: "AUTH_STATE", state: "AUTHORIZED" });
    expect(authorized.state.phase).toBe("streaming");
    expect(authorized.send.map((row) => (row as { type: string }).type)).toEqual([
      "CHANNEL_REQUEST",
      "FEED_SETUP",
      "FEED_SUBSCRIPTION",
    ]);
    expect(authorized.send[1]).toMatchObject({
      acceptDataFormat: "COMPACT",
      acceptEventFields: {
        Candle: ["eventSymbol", "time", "open", "high", "low", "close", "volume"],
      },
    });
    expect(authorized.send[2]).toMatchObject({
      add: [{ type: "Candle", symbol: ".TLT261113P77.5{=1m}", fromTime: 1_756_699_200_000 }],
    });
  });

  it("keeps each session at or under 100 candle subscriptions", () => {
    const many = Array.from({ length: CANDLE_SUBSCRIPTION_LIMIT + 1 }, (_, index) => ({
      streamer: `.SPY260918C${index}`,
      fromTime: 1,
    }));
    const batches = chunkCandleSubs(many);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toHaveLength(1);
    expect(chunkCandleSubs(many.slice(0, 100))).toHaveLength(1);
  });

  it("reads compact candle rows and strips the 1-minute suffix", () => {
    const rows = parseCompactCandles([
      "Candle",
      [".TLT261113P77.5{=1m}", 1_757_000_000_000, 1.2, 1.5, 1.1, 1.4, 8],
    ]);
    expect(rows).toEqual([{
      symbol: ".TLT261113P77.5",
      t: 1_757_000_000_000,
      o: 1.2,
      h: 1.5,
      l: 1.1,
      c: 1.4,
    }]);
  });

  it("sends the feed setup only after the quote session authorizes", async () => {
    const sent: object[] = [];
    const incoming = [
      { type: "KEEPALIVE", channel: 0 },
      { type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" },
      {
        type: "FEED_DATA",
        data: ["Candle", [".TLT261113P77.5{=1m}", 1_757_000_000_000, 1.2, 1.5, 1.1, 1.4, 8]],
      },
    ];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/oauth/token")) {
        expect(init?.method).toBe("POST");
        const headers = init?.headers as Record<string, string>;
        expect(headers["User-Agent"]).toBe("options-scan/1.0");
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        expect(String(init?.body)).toContain("client_id=client-id");
        return json({ access_token: "access-token" });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer access-token");
      expect(headers["User-Agent"]).toBe("options-scan/1.0");
      return json({ data: { "dxlink-url": "wss://dxlink.example/ws", token: "quote-token" } });
    });
    const result = await fetchOptionCandles(subs, {
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
      quietMs: 0,
      emptyWaitMs: 0,
      connect: async (url: string) => {
        expect(url).toBe("wss://dxlink.example/ws");
        return {
          send(data: string) {
            sent.push(JSON.parse(data) as object);
          },
          close() {},
          next() {
            const next = incoming.shift();
            return Promise.resolve(next ? JSON.stringify(next) : "timeout");
          },
        };
      },
    });
    expect(sent.map((row) => (row as { type: string }).type)).toEqual([
      "SETUP",
      "AUTH",
      "KEEPALIVE",
      "CHANNEL_REQUEST",
      "FEED_SETUP",
      "FEED_SUBSCRIPTION",
    ]);
    const feedAt = sent.findIndex((row) => (row as { type: string }).type === "CHANNEL_REQUEST");
    const authAt = sent.findIndex((row) => (row as { type: string }).type === "AUTH");
    expect(feedAt).toBeGreaterThan(authAt);
    expect(result.candles.get(".TLT261113P77.5")).toEqual([
      { t: 1_757_000_000_000, o: 1.2, h: 1.5, l: 1.1, c: 1.4 },
    ]);
    expect(result.completed).toEqual([".TLT261113P77.5"]);
    expect(result.errors).toEqual([]);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
