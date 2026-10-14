import { beforeEach, describe, expect, it, vi } from "vitest";

const tt = vi.hoisted(() => ({ chain: vi.fn(), history: vi.fn(), quotes: vi.fn() }));
const sw = vi.hoisted(() => ({ chain: vi.fn(), history: vi.fn(), quotes: vi.fn() }));

vi.mock("@/app/lib/tastytradeMarket", () => ({
  ttOptionChain: tt.chain, ttPriceHistory: tt.history, ttQuoteEntries: tt.quotes,
}));
vi.mock("@/app/lib/schwab", () => ({
  getOptionChain: sw.chain, getPriceHistory: sw.history, getQuoteEntries: sw.quotes,
  schwabConfigured: () => true, getSchwabStatus: vi.fn(),
  SchwabConfigError: class extends Error {}, SchwabNotConnectedError: class extends Error {},
}));

import {
  dataSourceStatus, getOptionChain, getPriceHistory, getQuoteEntries, preferredDataSource, resetDataSourceStatsForTests,
} from "@/app/lib/marketData";

const creds = { TASTYTRADE_CLIENT_ID: "id", TASTYTRADE_CLIENT_SECRET: "secret", TASTYTRADE_REFRESH_TOKEN: "refresh" };
const chain = (n: number) => ({ contracts: Array(n).fill({}), delayed: false, underlyingPrice: n > 0 ? 100 : null });

describe("market data router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDataSourceStatsForTests();
    Object.assign(process.env, creds, { DATA_SOURCE: "tastytrade" });
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("picks the source from DATA_SOURCE and the Tastytrade keys", () => {
    expect(preferredDataSource({ ...creds })).toBe("tastytrade");
    expect(preferredDataSource({ ...creds, DATA_SOURCE: "schwab" })).toBe("schwab");
    expect(preferredDataSource({ DATA_SOURCE: "tastytrade" })).toBe("schwab");
  });

  it("serves from Tastytrade when it answers", async () => {
    tt.chain.mockResolvedValue(chain(3));
    await expect(getOptionChain({ symbol: "SPY" })).resolves.toEqual(chain(3));
    expect(sw.chain).not.toHaveBeenCalled();
    const status = dataSourceStatus();
    expect(status.lastServed.chain).toMatchObject({ source: "tastytrade", fallback: false });
    expect(status.counts.tastytrade).toBe(1);
  });

  it("falls back to Schwab on an error or an empty answer", async () => {
    tt.chain.mockRejectedValueOnce(new Error("Tastytrade market data request failed (500)"));
    sw.chain.mockResolvedValue(chain(2));
    await expect(getOptionChain({ symbol: "SPY" })).resolves.toEqual(chain(2));
    expect(dataSourceStatus().lastServed.chain).toMatchObject({ source: "schwab", fallback: true });
    tt.history.mockResolvedValueOnce([]);
    sw.history.mockResolvedValueOnce([{ close: 1 }]);
    await expect(getPriceHistory({ symbol: "SPY", periodType: "day", period: 1, frequencyType: "minute", frequency: 5 }))
      .resolves.toEqual([{ close: 1 }]);
    expect(dataSourceStatus().fallbacks).toBe(2);
  });

  it("falls back when Tastytrade misses any requested quote", async () => {
    tt.quotes.mockResolvedValueOnce({ entries: [{ symbol: "A" }], problem: null });
    sw.quotes.mockResolvedValueOnce({ entries: [{ symbol: "A" }, { symbol: "B" }], problem: null });
    const read = await getQuoteEntries(["A", "B"]);
    expect(read.entries).toHaveLength(2);
  });

  it("uses only Schwab when DATA_SOURCE=schwab", async () => {
    process.env.DATA_SOURCE = "schwab";
    sw.chain.mockResolvedValue(chain(1));
    await getOptionChain({ symbol: "SPY" });
    expect(tt.chain).not.toHaveBeenCalled();
    expect(dataSourceStatus().preferred).toBe("schwab");
  });
});
