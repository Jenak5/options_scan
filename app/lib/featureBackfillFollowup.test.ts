import { describe, expect, it } from "vitest";
import { BEARER_PATHS, isBearerPath } from "@/app/lib/bearerPaths";
import { dailyCover, intradayCover, parseTickerParam } from "@/app/lib/featureBackfillStore";
import type { CandleBar } from "@/app/lib/candleTypes";
import { fetchOptionCandles, rangeCovered } from "@/app/lib/tastytradeCandles";

const ENV = {
  TASTYTRADE_CLIENT_ID: "client-id",
  TASTYTRADE_CLIENT_SECRET: "client-secret",
  TASTYTRADE_REFRESH_TOKEN: "refresh-token",
};

function bars(times: number[]): Map<number, CandleBar> {
  const out = new Map<number, CandleBar>();
  for (const t of times) out.set(t, { t, o: 1, h: 1, l: 1, c: 1 });
  return out;
}

describe("feature backfill follow-up", () => {
  it("lets the health bearer reach the feature backfill route", () => {
    expect(isBearerPath("/api/features/backfill")).toBe(true);
    expect(isBearerPath("/api/health")).toBe(true);
    expect(isBearerPath("/api/learn")).toBe(false);
    expect(BEARER_PATHS.has("/api/candles/backfill")).toBe(true);
  });

  it("is covered only when every subscription has bars at both ends", () => {
    const subs = [
      { streamer: "AAPL", fromTime: 0, period: "5m" as const, coverFrom: 100, coverUntil: 900 },
      { streamer: "SPY", fromTime: 0, period: "5m" as const, coverFrom: 100, coverUntil: 900 },
    ];
    expect(rangeCovered(subs, new Map([["AAPL", bars([50, 950])]]))).toBe(false);
    expect(rangeCovered(subs, new Map([["AAPL", bars([50, 950])], ["SPY", bars([200, 950])]]))).toBe(false);
    expect(rangeCovered(subs, new Map([["AAPL", bars([50, 950])], ["SPY", bars([100, 900])]]))).toBe(true);
    expect(rangeCovered([{ streamer: "AAPL", fromTime: 0 }], new Map([["AAPL", bars([50, 950])]]))).toBe(false);
  });

  it("stops the DXLink batch as soon as the range is covered, before the feed goes quiet", async () => {
    const incoming: object[] = [
      { type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" },
      { type: "FEED_DATA", data: ["Candle", ["AAPL{=5m}", 1_757_000_900_000, 2, 2, 2, 2, 10]] },
      { type: "FEED_DATA", data: ["Candle", ["AAPL{=5m}", 1_757_000_000_000, 1, 1, 1, 1, 10]] },
    ];
    let reads = 0;
    const started = Date.now();
    const result = await fetchOptionCandles(
      [{ streamer: "AAPL", fromTime: 1_756_999_000_000, period: "5m", coverFrom: 1_757_000_000_000, coverUntil: 1_757_000_900_000 }],
      {
        env: ENV,
        timeoutMs: 20_000,
        quietMs: 60_000,
        emptyWaitMs: 60_000,
        fetchImpl: (async (url: string) => {
          if (String(url).endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
          return new Response(JSON.stringify({ data: { "dxlink-url": "wss://x", token: "q" } }), { status: 200 });
        }) as unknown as typeof fetch,
        connect: async () => ({
          send() {},
          close() {},
          next() {
            reads += 1;
            const next = incoming.shift();
            // After the covered data, a live feed keeps sending. Never go quiet.
            return Promise.resolve(JSON.stringify(next ?? { type: "FEED_DATA", data: ["Candle", ["AAPL{=5m}", 1_757_000_900_000 + reads, 3, 3, 3, 3, 1]] }));
          },
        }),
      },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.completed).toEqual(["AAPL"]);
    expect(result.errors).toEqual([]);
    expect(result.candles.get("AAPL")?.length).toBe(2);
  });

  it("parses ?tickers= and builds cover windows", () => {
    expect(parseTickerParam("aapl, NVDA,aapl,,bad ticker!")).toEqual(["AAPL", "NVDA"]);
    expect(parseTickerParam("")).toBeNull();
    expect(parseTickerParam(null)).toBeNull();
    expect(intradayCover(1_000_000_000, 2_000_000_000)).toEqual({ coverFrom: 1_000_000_000 - 300_000, coverUntil: 2_000_000_000 - 900_000 });
    expect(dailyCover(10 * 86_400_000, 20 * 86_400_000)).toEqual({ coverFrom: -20 * 86_400_000, coverUntil: 16 * 86_400_000 });
  });
});
