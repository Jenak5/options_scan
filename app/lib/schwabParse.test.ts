import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_FALLBACK_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  alertDue,
  buildAuthorizeUrl,
  marketDataGetUrl,
  parseOptionChain,
  parsePriceHistory,
  parseQuoteEntries,
  parseQuotes,
  QUOTE_EMPTY,
  QUOTE_REJECTED,
  QUOTE_UNREADABLE,
  quoteReadProblem,
  parseTokenResponse,
  publicTokenStatus,
  refreshWarnSoon,
} from "@/app/lib/schwabParse";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("market-data URL guard", () => {
  it("allows chains, quotes, and price history and refuses everything else", () => {
    const chain = marketDataGetUrl("chains", new URLSearchParams({ symbol: "SPY" }));
    const quotes = marketDataGetUrl("quotes", new URLSearchParams({ symbols: "SPY" }));
    const history = marketDataGetUrl("pricehistory", new URLSearchParams({ symbol: "SPY", periodType: "day" }));
    expect(chain.startsWith("https://api.schwabapi.com/marketdata/v1/chains?")).toBe(true);
    expect(quotes.startsWith("https://api.schwabapi.com/marketdata/v1/quotes?")).toBe(true);
    expect(history.startsWith("https://api.schwabapi.com/marketdata/v1/pricehistory?")).toBe(true);
    expect(history.includes("symbol=SPY")).toBe(true);
    expect(history.includes("periodType=day")).toBe(true);
    expect(chain.includes("/orders")).toBe(false);
    expect(history.includes("/trader")).toBe(false);
    expect(() => marketDataGetUrl("orders", new URLSearchParams())).toThrow(/price history/);
    expect(() => marketDataGetUrl("trader/v1/accounts", new URLSearchParams())).toThrow(/price history/);
    expect(() => marketDataGetUrl("../trader/v1/orders", new URLSearchParams())).toThrow(/price history/);
    expect(() => marketDataGetUrl("chains/../orders", new URLSearchParams())).toThrow(/price history/);
    expect(() => marketDataGetUrl("pricehistory/../orders", new URLSearchParams())).toThrow(/price history/);
  });

  it("encodes a padded option symbol with %20", () => {
    const quotes = marketDataGetUrl("quotes", new URLSearchParams({
      symbols: "NVDA  261106P00235000",
      indicative: "false",
    }));
    expect(quotes).toContain("symbols=NVDA%20%20261106P00235000");
    expect(quotes.includes("+")).toBe(false);
  });
});

describe("authorize URL", () => {
  it("is the code flow and does not carry the client secret", () => {
    const url = buildAuthorizeUrl({
      clientId: "fixture-client-id",
      redirectUri: "https://example.com/api/schwab/callback",
      state: "fixture-state",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://api.schwabapi.com");
    expect(parsed.pathname).toBe("/v1/oauth/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("fixture-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/api/schwab/callback");
    expect(parsed.searchParams.get("state")).toBe("fixture-state");
    expect(url.includes("client_secret")).toBe(false);
    expect(url.includes("fixture-secret")).toBe(false);
  });
});

describe("token response", () => {
  const now = Date.parse("2026-10-01T15:00:00Z");

  it("starts a 7-day refresh clock on the authorization-code exchange", () => {
    const tokens = parseTokenResponse({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      expires_in: 1800,
    }, now);
    expect(tokens.accessToken).toBe("fixture-access");
    expect(tokens.refreshToken).toBe("fixture-refresh");
    expect(tokens.accessExpiresAt).toBe(now + 1800 * 1000);
    expect(tokens.refreshExpiresAt).toBe(now + REFRESH_TOKEN_TTL_MS);
  });

  it("defaults the access token to 30 minutes when expires_in is missing", () => {
    const tokens = parseTokenResponse({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
    }, now);
    expect(tokens.accessExpiresAt).toBe(now + ACCESS_TOKEN_FALLBACK_SECONDS * 1000);
  });

  it("resets the refresh clock only when Schwab issues a new refresh token", () => {
    const previous = {
      refreshToken: "fixture-refresh",
      refreshExpiresAt: now + 2 * DAY,
    };
    const same = parseTokenResponse({
      access_token: "fixture-access-2",
      refresh_token: "fixture-refresh",
      expires_in: 1800,
    }, now, previous);
    expect(same.refreshExpiresAt).toBe(previous.refreshExpiresAt);

    const rotated = parseTokenResponse({
      access_token: "fixture-access-2",
      refresh_token: "fixture-refresh-new",
      expires_in: 1800,
    }, now, previous);
    expect(rotated.refreshToken).toBe("fixture-refresh-new");
    expect(rotated.refreshExpiresAt).toBe(now + REFRESH_TOKEN_TTL_MS);

    const omitted = parseTokenResponse({
      access_token: "fixture-access-3",
      expires_in: 1800,
    }, now, previous);
    expect(omitted.refreshToken).toBe("fixture-refresh");
    expect(omitted.refreshExpiresAt).toBe(previous.refreshExpiresAt);
  });

  it("throws a message that does not echo the token body", () => {
    expect(() => parseTokenResponse({ refresh_token: "fixture-refresh" }, now)).toThrow(/access token/);
    try {
      parseTokenResponse({ refresh_token: "fixture-refresh" }, now);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.includes("fixture-refresh")).toBe(false);
    }
  });
});

describe("refresh window", () => {
  const now = Date.parse("2026-10-01T15:00:00Z");

  it("warns only under 2 days, and treats expiry as expired", () => {
    expect(refreshWarnSoon(now + 3 * DAY, now)).toBe(false);
    expect(refreshWarnSoon(now + 2 * DAY, now)).toBe(false);
    expect(refreshWarnSoon(now + 2 * DAY - 1, now)).toBe(true);
    expect(refreshWarnSoon(now, now)).toBe(false);

    const healthy = publicTokenStatus({
      configured: true,
      storage: "kv",
      accessExpiresAt: now + 10 * 60 * 1000,
      refreshExpiresAt: now + 3 * DAY,
      now,
    });
    expect(healthy.connected).toBe(true);
    expect(healthy.warnRefreshSoon).toBe(false);
    expect(healthy.refreshDaysLeft).toBe(3);

    const edge = publicTokenStatus({
      configured: true,
      storage: "kv",
      accessExpiresAt: now + 1000,
      refreshExpiresAt: now + 2 * DAY,
      now,
    });
    expect(edge.warnRefreshSoon).toBe(false);
    expect(edge.connected).toBe(true);

    const soon = publicTokenStatus({
      configured: true,
      storage: "kv",
      accessExpiresAt: now - 1,
      refreshExpiresAt: now + 1.5 * DAY,
      now,
    });
    expect(soon.warnRefreshSoon).toBe(true);
    expect(soon.connected).toBe(true);
    expect(soon.accessExpired).toBe(true);
    expect(soon.refreshExpired).toBe(false);
    expect(soon.message).toMatch(/under 2 days/i);

    const expired = publicTokenStatus({
      configured: true,
      storage: "memory",
      accessExpiresAt: now - 1,
      refreshExpiresAt: now - 1000,
      now,
    });
    expect(expired.connected).toBe(false);
    expect(expired.refreshExpired).toBe(true);
    expect(expired.warnRefreshSoon).toBe(false);
    expect(expired.message).toMatch(/expired/i);

    const absent = publicTokenStatus({
      configured: true,
      storage: "memory",
      accessExpiresAt: null,
      refreshExpiresAt: null,
      now,
    });
    expect(absent.connected).toBe(false);
    expect(JSON.stringify(absent).includes("fixture")).toBe(false);
  });

  it("names the KV, Upstash, and Blob env vars when production storage is not configured", () => {
    const status = publicTokenStatus({
      configured: true,
      storage: "unconfigured",
      accessExpiresAt: now + DAY,
      refreshExpiresAt: now + DAY,
      now,
    });
    expect(status.connected).toBe(false);
    expect(status.storageWarning).toContain("KV_REST_API_URL");
    expect(status.storageWarning).toContain("KV_REST_API_TOKEN");
    expect(status.storageWarning).toContain("UPSTASH_REDIS_REST_URL");
    expect(status.storageWarning).toContain("UPSTASH_REDIS_REST_TOKEN");
    expect(status.storageWarning).toContain("BLOB_READ_WRITE_TOKEN");
    expect(status.message).toContain("not configured");
    expect(JSON.stringify(status).includes("fixture")).toBe(false);
  });
});

describe("quote and chain normalization", () => {
  it("maps an option quote and skips the equity", () => {
    const expiration = Date.parse("2026-10-16T20:00:00Z");
    const contracts = parseQuotes({
      AAPL: {
        assetMainType: "EQUITY",
        quote: { bidPrice: 100, askPrice: 100.1, lastPrice: 100.05 },
      },
      "SPY   261016C00570000": {
        assetMainType: "OPTION",
        quote: {
          bidPrice: 1.95,
          askPrice: 2.05,
          lastPrice: 2,
          totalVolume: 140,
          openInterest: 800,
          volatility: 22.5,
          strikePrice: 570,
        },
        reference: {
          contractType: "C",
          expirationDate: expiration,
          strikePrice: 570,
        },
      },
    });
    expect(contracts).toHaveLength(1);
    expect(parseQuoteEntries({
      "SPY   261016C00570000": {
        assetMainType: "OPTION",
        quote: { bidPrice: 1.95, askPrice: 2.05, lastPrice: 2, strikePrice: 570 },
        reference: { contractType: "C", expirationDate: expiration, strikePrice: 570 },
      },
    })[0].symbol).toBe("SPY   261016C00570000");
    expect(contracts[0]).toMatchObject({
      bid: 1.95,
      ask: 2.05,
      last: 2,
      volume: 140,
      openInterest: 800,
      delta: null,
      iv: 0.225,
      strike: 570,
      expiration: "2026-10-16",
      putCall: "call",
      lastSize: null,
      tradeTime: null,
    });
  });

  it("reads Schwab's quotes payload: expiration year, month, day, and quote.bidPrice", () => {
    const quoteTime = Date.parse("2026-10-08T17:50:00.000Z");
    const tradeTime = quoteTime - 1000;
    const payload = {
      "NVDA  261106P00235000": {
        assetMainType: "OPTION",
        symbol: "NVDA  261106P00235000",
        realtime: true,
        reference: {
          contractType: "P",
          daysToExpiration: 29,
          expirationDay: 6,
          expirationMonth: 11,
          expirationYear: 2026,
          strikePrice: 235,
          underlying: "NVDA",
          multiplier: 100,
        },
        quote: {
          bidPrice: 9.75,
          askPrice: 9.95,
          lastPrice: 9.85,
          mark: 9.85,
          quoteTime,
          tradeTime,
          openInterest: 120,
          totalVolume: 40,
          volatility: 32.5,
          delta: -0.42,
        },
      },
    };
    const entries = parseQuoteEntries(payload);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbol).toBe("NVDA  261106P00235000");
    expect(entries[0].contract).toMatchObject({
      bid: 9.75,
      ask: 9.95,
      last: 9.85,
      strike: 235,
      expiration: "2026-11-06",
      putCall: "put",
      volume: 40,
      openInterest: 120,
      delta: -0.42,
      iv: 0.325,
      quoteTime,
      tradeTime,
    });
    expect(quoteReadProblem(payload)).toBeNull();
    expect(parseQuoteEntries({
      errors: { invalidSymbols: ["NVDA  261106P00235000"], invalidCusips: [], invalidSSIDs: [] },
    })).toEqual([]);
    expect(quoteReadProblem({
      errors: { invalidSymbols: ["NVDA  261106P00235000"], invalidCusips: [], invalidSSIDs: [] },
    })).toBe(QUOTE_REJECTED);
    expect(quoteReadProblem({})).toBe(QUOTE_EMPTY);
    expect(quoteReadProblem({
      "NVDA  261106P00235000": { assetMainType: "OPTION", quote: { bidPrice: 9.75, askPrice: 9.95 } },
    })).toBe(QUOTE_UNREADABLE);
  });

  it("reads last size and trade time from a chain row", () => {
    const parsed = parseOptionChain({
      callExpDateMap: {
        "2026-10-16:10": {
          "100.0": [{
            putCall: "CALL",
            bid: 1.2,
            ask: 1.3,
            last: 1.3,
            lastSize: 40,
            bidSize: 10,
            askSize: 12,
            totalVolume: 80,
            openInterest: 500,
            tradeTimeInLong: 1_760_000_000_000,
            quoteTimeInLong: 1_760_000_000_500,
            volatility: 20,
            strikePrice: 100,
          }],
        },
      },
    });
    expect(parsed.contracts[0]).toMatchObject({
      lastSize: 40,
      bidSize: 10,
      askSize: 12,
      tradeTime: 1_760_000_000_000,
      quoteTime: 1_760_000_000_500,
    });
  });

  it("keeps a zero IV and a missing greek as null delta", () => {
    const parsed = parseOptionChain({
      isDelayed: true,
      callExpDateMap: {
        "2026-11-20:40": {
          "100.0": [{
            putCall: "CALL",
            bid: 1,
            ask: 1.02,
            last: 1.01,
            totalVolume: 100,
            openInterest: 500,
            volatility: 0,
            strikePrice: 100,
          }],
        },
      },
    });
    expect(parsed.delayed).toBe(true);
    expect(parsed.contracts[0].iv).toBe(0);
    expect(parsed.contracts[0].delta).toBeNull();
    expect(parsed.contracts[0].expiration).toBe("2026-11-20");
  });

  it("does not call the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network");
    });
    parseOptionChain({ callExpDateMap: {}, putExpDateMap: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("price history candles", () => {
  it("keeps valid candles in time order and drops a broken one", () => {
    const candles = parsePriceHistory({
      candles: [
        { open: 10, high: 11, low: 9, close: 10.5, volume: 100, datetime: 2000 },
        { open: 8, high: 9, low: 7, close: 8, volume: 50, datetime: 1000 },
        { open: 1, high: 1, low: 2, close: 1, volume: 1, datetime: 3000 },
        { open: 5, high: 6, low: 4, close: 0, volume: 10, datetime: 4000 },
        { foo: "bar" },
      ],
    });
    expect(candles.map((candle) => candle.datetime)).toEqual([1000, 2000]);
    expect(candles[1].close).toBe(10.5);
    expect(parsePriceHistory({ empty: true }).length).toBe(0);
    expect(parsePriceHistory(null).length).toBe(0);
  });
});

describe("alert throttle", () => {
  it("sends the first alert and then waits out the interval", () => {
    const now = 1_000_000;
    expect(alertDue(null, now, 60_000)).toBe(true);
    expect(alertDue(now - 59_999, now, 60_000)).toBe(false);
    expect(alertDue(now - 60_000, now, 60_000)).toBe(true);
  });
});
