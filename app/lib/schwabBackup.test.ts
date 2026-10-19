import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as cronGet } from "@/app/api/cron/route";
import { GET as flowGet } from "@/app/api/flow/route";
import type { OptionContract } from "@/app/lib/contract";
import { clearFlowScanCacheForTests, scanEstimatedFlow } from "@/app/lib/flowScan";
import { clearLevelCacheForTests } from "@/app/lib/levelScan";
import { getQuoteEntries, resetDataSourceStatsForTests } from "@/app/lib/marketData";
import { getAccessToken, getSchwabStatus, SchwabNotConnectedError } from "@/app/lib/schwab";
import { clearMemoryStoreForTests, readFlowSnapshots, readScanHealth, writeTokens } from "@/app/lib/schwabStore";
import * as schwab from "@/app/lib/schwab";

const tt = vi.hoisted(() => ({ chain: vi.fn(), history: vi.fn(), quotes: vi.fn() }));

vi.mock("@/app/lib/tastytradeMarket", () => ({
  ttOptionChain: tt.chain,
  ttPriceHistory: tt.history,
  ttQuoteEntries: tt.quotes,
}));

vi.mock("@/app/lib/earnings", () => ({
  earningsForTicker: async () => ({ status: "unknown", date: null, timing: null, estimated: false }),
}));

const ENV_KEYS = [
  "DATA_SOURCE",
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
  "TASTYTRADE_ENABLED",
  "TASTYTRADE_ACCOUNT_NUMBER",
  "SCHWAB_CLIENT_ID",
  "SCHWAB_CLIENT_SECRET",
  "SCHWAB_REDIRECT_URI",
  "BLOB_READ_WRITE_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "EDGE_CONFIG",
  "GLOBAL_CONFIG",
  "VERCEL_API_TOKEN",
  "VERCEL",
  "CRON_SECRET",
  "FLOW_WATCHLIST",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "XAI_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};
const SESSION = new Date("2026-10-06T15:00:00Z");

function contract(): OptionContract {
  return {
    bid: 1.2,
    ask: 1.3,
    last: 1.25,
    volume: 0,
    openInterest: 20,
    delta: 0.4,
    iv: 0.25,
    strike: 100,
    expiration: "2026-12-18",
    putCall: "call",
  };
}

function chain() {
  return { contracts: [contract()], delayed: false, underlyingPrice: 100 };
}

describe("Schwab backup while tastytrade is preferred", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const telegramBodies: string[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.DATA_SOURCE = "tastytrade";
    process.env.TASTYTRADE_CLIENT_ID = "fixture-tt-id";
    process.env.TASTYTRADE_CLIENT_SECRET = "fixture-tt-secret";
    process.env.TASTYTRADE_REFRESH_TOKEN = "fixture-tt-refresh";
    process.env.SCHWAB_CLIENT_ID = "fixture-schwab-id";
    process.env.SCHWAB_CLIENT_SECRET = "fixture-schwab-secret";
    process.env.SCHWAB_REDIRECT_URI = "https://example.com/schwab";
    process.env.CRON_SECRET = "cron-token";
    process.env.FLOW_WATCHLIST = "TLT,GLD,XLF";
    clearMemoryStoreForTests();
    clearFlowScanCacheForTests();
    clearLevelCacheForTests();
    resetDataSourceStatsForTests();
    vi.clearAllMocks();
    telegramBodies.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SESSION);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      telegramBodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response("{}", { status: 200 });
    });
    tt.history.mockResolvedValue([{ open: 100, high: 101, low: 99, close: 100, volume: 1, datetime: SESSION.getTime() }]);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    clearMemoryStoreForTests();
    clearFlowScanCacheForTests();
    clearLevelCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("completes the scan and saves the other tickers when Schwab is expired and tastytrade returns 401 for XLF", async () => {
    const now = SESSION.getTime();
    await writeTokens({
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      accessExpiresAt: now - 60_000,
      refreshExpiresAt: now - 60_000,
    });
    const status = await getSchwabStatus(now);
    expect(status.refreshExpired).toBe(true);
    expect(status.connected).toBe(false);

    tt.chain.mockImplementation(async (input: { symbol: string }) => {
      if (input.symbol === "XLF") throw new Error("Tastytrade option chain failed (401)");
      return chain();
    });
    const schwabChain = vi.spyOn(schwab, "getOptionChain").mockRejectedValue(new Error("Schwab backup must not be called"));
    const schwabHistory = vi.spyOn(schwab, "getPriceHistory").mockRejectedValue(new Error("Schwab backup must not be called"));

    const scan = await scanEstimatedFlow({ tickers: ["TLT", "GLD", "XLF"], now, bypassCache: true });

    expect(scan.errors.map((item) => item.ticker)).toEqual(["XLF"]);
    expect(scan.errors[0].message).toBe("XLF skipped: tastytrade 401; Schwab backup not connected");
    expect(new Set(scan.rows.map((row) => row.ticker))).toEqual(new Set(["TLT", "GLD"]));
    const saved = await readFlowSnapshots();
    expect(Object.keys(saved).sort()).toEqual(["GLD", "TLT"]);
    expect(saved.XLF).toBeUndefined();
    expect(schwabChain).not.toHaveBeenCalled();
    expect(schwabHistory).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0])).toContain("XLF skipped: tastytrade 401; Schwab backup not connected");
    expect(warn.mock.calls.map((call) => String(call[0])).join(" ")).not.toMatch(/Schwab scan skipped/);

    process.env.TELEGRAM_BOT_TOKEN = "fixture-bot";
    process.env.TELEGRAM_CHAT_ID = "fixture-chat";
    await expect(getAccessToken()).rejects.toBeInstanceOf(SchwabNotConnectedError);
    expect(telegramBodies.join(" ")).not.toMatch(/Schwab reconnect|Schwab refresh failed|Schwab scan skipped/);

    const response = await flowGet(new NextRequest("https://options-scan.vercel.app/api/flow?liquidOnly=false", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connected).toBe(true);
    expect(body.skipped).toEqual(["XLF"]);
    expect(body.data.map((row: { ticker: string }) => row.ticker)).toEqual(expect.arrayContaining(["TLT", "GLD"]));
    expect(body.data.map((row: { ticker: string }) => row.ticker)).not.toContain("XLF");
    expect(telegramBodies.join(" ")).not.toMatch(/Schwab scan skipped/);
  });

  it("keeps Tastytrade quotes and asks Schwab only for the missing symbols in a partial quote batch", async () => {
    const now = SESSION.getTime();
    await writeTokens({
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      accessExpiresAt: now + 30 * 60_000,
      refreshExpiresAt: now + 5 * 24 * 60 * 60_000,
    });
    tt.quotes.mockResolvedValueOnce({
      entries: [{ symbol: "TLT   261218C00100000", contract: contract() }],
      problem: null,
    });
    const schwabQuotes = vi.spyOn(schwab, "getQuoteEntries").mockImplementation(async (symbols: string[]) => ({
      entries: symbols.map((symbol) => ({ symbol, contract: contract() })),
      problem: null,
    }));

    const read = await getQuoteEntries(["TLT   261218C00100000", "GLD   261218C00100000"]);

    expect(schwabQuotes).toHaveBeenCalledTimes(1);
    expect(schwabQuotes.mock.calls[0][0]).toEqual(["GLD   261218C00100000"]);
    expect(read.entries.map((entry) => entry.symbol)).toEqual([
      "TLT   261218C00100000",
      "GLD   261218C00100000",
    ]);
  });

  it("stops the scan when DATA_SOURCE=schwab and Schwab is disconnected", async () => {
    process.env.DATA_SOURCE = "schwab";
    process.env.TELEGRAM_BOT_TOKEN = "fixture-bot";
    process.env.TELEGRAM_CHAT_ID = "fixture-chat";
    await writeTokens({
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      accessExpiresAt: SESSION.getTime() - 60_000,
      refreshExpiresAt: SESSION.getTime() - 60_000,
    });

    await expect(scanEstimatedFlow({ tickers: ["TLT", "XLF"], now: SESSION.getTime(), bypassCache: true }))
      .rejects.toBeInstanceOf(SchwabNotConnectedError);
    expect(await readFlowSnapshots()).toEqual({});

    const response = await cronGet(new NextRequest("https://options-scan.vercel.app/api/cron", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toBe(true);
    expect(body.alertsSent).toBe(0);
    expect(body.reason).toMatch(/Schwab is not connected/);
    const health = await readScanHealth();
    expect(health.lastOutcome).toBe("skipped");
    expect(telegramBodies.some((text) => text.includes("Schwab scan skipped"))).toBe(true);
    expect(await readFlowSnapshots()).toEqual({});
  });
});
