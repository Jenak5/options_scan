import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_FALLBACK_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  alertDue,
  buildAuthorizeUrl,
  marketDataGetUrl,
  parseOptionChain,
  parseQuotes,
  parseTokenResponse,
  publicTokenStatus,
  refreshWarnSoon,
} from "@/app/lib/schwabParse";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("market-data URL guard", () => {
  it("allows chains and quotes and refuses everything else", () => {
    const chain = marketDataGetUrl("chains", new URLSearchParams({ symbol: "SPY" }));
    const quotes = marketDataGetUrl("quotes", new URLSearchParams({ symbols: "SPY" }));
    expect(chain.startsWith("https://api.schwabapi.com/marketdata/v1/chains?")).toBe(true);
    expect(quotes.startsWith("https://api.schwabapi.com/marketdata/v1/quotes?")).toBe(true);
    expect(chain.includes("/orders")).toBe(false);
    expect(() => marketDataGetUrl("orders", new URLSearchParams())).toThrow(/chains and quotes/);
    expect(() => marketDataGetUrl("trader/v1/accounts", new URLSearchParams())).toThrow(/chains and quotes/);
    expect(() => marketDataGetUrl("../trader/v1/orders", new URLSearchParams())).toThrow(/chains and quotes/);
    expect(() => marketDataGetUrl("chains/../orders", new URLSearchParams())).toThrow(/chains and quotes/);
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

  it("names the KV and Upstash env vars when production storage is not configured", () => {
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

describe("alert throttle", () => {
  it("sends the first alert and then waits out the interval", () => {
    const now = 1_000_000;
    expect(alertDue(null, now, 60_000)).toBe(true);
    expect(alertDue(now - 59_999, now, 60_000)).toBe(false);
    expect(alertDue(now - 60_000, now, 60_000)).toBe(true);
  });
});
