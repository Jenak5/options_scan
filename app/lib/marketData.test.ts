import { beforeEach, describe, expect, it, vi } from "vitest";

const tt = vi.hoisted(() => ({ chain: vi.fn(), history: vi.fn(), quotes: vi.fn() }));
const sw = vi.hoisted(() => ({ chain: vi.fn(), history: vi.fn(), quotes: vi.fn(), backup: vi.fn(async () => true) }));

vi.mock("@/app/lib/tastytradeMarket", () => ({
  ttOptionChain: tt.chain, ttPriceHistory: tt.history, ttQuoteEntries: tt.quotes,
}));
vi.mock("@/app/lib/schwab", () => ({
  getOptionChain: sw.chain, getPriceHistory: sw.history, getQuoteEntries: sw.quotes,
  schwabConfigured: () => true, getSchwabStatus: vi.fn(), schwabBackupAvailable: sw.backup,
  SchwabConfigError: class extends Error {},
  SchwabNotConnectedError: class extends Error {
    constructor() {
      super("Schwab is not connected. Use Reconnect Schwab.");
      this.name = "SchwabNotConnectedError";
    }
  },
}));

import {
  dataSourceStatus, getOptionChain, getPriceHistory, getQuoteEntries, preferredDataSource, resetDataSourceStatsForTests,
} from "@/app/lib/marketData";
import { requestedPrimary } from "@/app/lib/dataSourcePref";

const creds = { TASTYTRADE_CLIENT_ID: "id", TASTYTRADE_CLIENT_SECRET: "secret", TASTYTRADE_REFRESH_TOKEN: "refresh" };
const chain = (n: number) => ({ contracts: Array(n).fill({}), delayed: false, underlyingPrice: n > 0 ? 100 : null });

describe("market data router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sw.backup.mockReset();
    sw.backup.mockResolvedValue(true);
    resetDataSourceStatsForTests();
    Object.assign(process.env, creds, { DATA_SOURCE: "tastytrade" });
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("picks the source from MARKET_DATA_PRIMARY, then DATA_SOURCE, then the Tastytrade keys", () => {
    expect(requestedPrimary({ ...creds })).toBe("tastytrade");
    expect(preferredDataSource({ ...creds })).toBe("tastytrade");
    expect(preferredDataSource({ ...creds, DATA_SOURCE: "schwab" })).toBe("schwab");
    expect(preferredDataSource({ DATA_SOURCE: "tastytrade" })).toBe("schwab");
    expect(preferredDataSource({ ...creds, MARKET_DATA_PRIMARY: "schwab", DATA_SOURCE: "tastytrade" })).toBe("schwab");
    expect(preferredDataSource({ ...creds, MARKET_DATA_PRIMARY: "tastytrade", DATA_SOURCE: "schwab" })).toBe("tastytrade");
    expect(requestedPrimary({})).toBe("tastytrade");
  });

  it("serves from Tastytrade when it answers", async () => {
    tt.chain.mockResolvedValue(chain(3));
    await expect(getOptionChain({ symbol: "SPY" })).resolves.toEqual(chain(3));
    expect(sw.chain).not.toHaveBeenCalled();
    const status = dataSourceStatus();
    expect(status.lastServed.chain).toMatchObject({ source: "tastytrade", fallback: false });
    expect(status.counts.tastytrade).toBe(1);
    expect(status.active.chain).toBe("tastytrade");
    expect(status.active.openInterest).toBe("tastytrade");
    expect(status.active.volume).toBe("tastytrade");
    expect(status.active.greeks).toBe("tastytrade");
    expect(status.primary).toBe("tastytrade");
    expect(status.tradeSideDataAvailable).toBe("no");
    expect(status.lastTastytradeSuccessAt).toBeTruthy();
  });

  it("falls back to Schwab on a 401, a timeout, or an empty answer", async () => {
    tt.chain.mockRejectedValueOnce(new Error("Tastytrade option chain failed (401) bearer super-secret-token"));
    sw.chain.mockResolvedValueOnce(chain(4));
    await expect(getOptionChain({ symbol: "QQQ" })).resolves.toEqual(chain(4));
    const after401 = dataSourceStatus();
    expect(after401.lastServed.chain).toMatchObject({ source: "schwab", fallback: true });
    expect(after401.fallbackCount).toBe(1);
    expect(after401.lastError).not.toContain("super-secret-token");
    expect(after401.lastError).toContain("[redacted]");

    tt.chain.mockRejectedValueOnce(new Error("Tastytrade market data request timed out"));
    sw.chain.mockResolvedValueOnce(chain(2));
    await expect(getOptionChain({ symbol: "IWM" })).resolves.toEqual(chain(2));
    expect(dataSourceStatus().lastError).toMatch(/timed out/i);
    tt.chain.mockRejectedValueOnce(new Error("Tastytrade market data request failed (500)"));
    sw.chain.mockResolvedValue(chain(2));
    await expect(getOptionChain({ symbol: "SPY" })).resolves.toEqual(chain(2));
    expect(dataSourceStatus().lastServed.chain).toMatchObject({ source: "schwab", fallback: true });
    tt.history.mockResolvedValueOnce([]);
    sw.history.mockResolvedValueOnce([{ close: 1 }]);
    await expect(getPriceHistory({ symbol: "SPY", periodType: "day", period: 1, frequencyType: "minute", frequency: 5 }))
      .resolves.toEqual([{ close: 1 }]);
    expect(dataSourceStatus().fallbacks).toBe(4);
  });

  it("keeps Tastytrade quotes and asks Schwab only for the symbols Tastytrade missed", async () => {
    tt.quotes.mockResolvedValueOnce({ entries: [{ symbol: "A" }], problem: null });
    sw.quotes.mockImplementation(async (symbols: string[]) => ({
      entries: symbols.map((symbol) => ({ symbol })),
      problem: null,
    }));
    const read = await getQuoteEntries(["A", "B"]);
    expect(sw.quotes).toHaveBeenCalledTimes(1);
    expect(sw.quotes.mock.calls[0][0]).toEqual(["B"]);
    expect(read.entries.map((entry) => entry.symbol)).toEqual(["A", "B"]);
  });

  it("keeps a partial Tastytrade quote when the Schwab backup is not connected", async () => {
    sw.backup.mockResolvedValueOnce(false);
    tt.quotes.mockResolvedValueOnce({ entries: [{ symbol: "A" }], problem: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = await getQuoteEntries(["A", "B"]);
    expect(sw.quotes).not.toHaveBeenCalled();
    expect(read.entries.map((entry) => entry.symbol)).toEqual(["A"]);
    expect(warn).toHaveBeenCalledWith("B skipped: tastytrade partial; Schwab backup not connected");
  });

  it("does not call Schwab when Tastytrade fails and the Schwab login is expired", async () => {
    sw.backup.mockResolvedValue(false);
    tt.chain.mockRejectedValueOnce(new Error("Tastytrade option chain failed (401)"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(getOptionChain({ symbol: "XLF" })).rejects.toThrow("XLF skipped: tastytrade 401; Schwab backup not connected");
    expect(sw.chain).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("XLF skipped: tastytrade 401; Schwab backup not connected");
  });

  it("uses only Schwab when DATA_SOURCE=schwab", async () => {
    process.env.DATA_SOURCE = "schwab";
    sw.chain.mockResolvedValue(chain(1));
    await getOptionChain({ symbol: "SPY" });
    expect(tt.chain).not.toHaveBeenCalled();
    expect(sw.backup).not.toHaveBeenCalled();
    expect(dataSourceStatus().preferred).toBe("schwab");
  });

  it("stops on a Schwab disconnect when DATA_SOURCE=schwab", async () => {
    process.env.DATA_SOURCE = "schwab";
    sw.chain.mockRejectedValueOnce(Object.assign(new Error("Schwab is not connected. Use Reconnect Schwab."), { name: "SchwabNotConnectedError" }));
    await expect(getOptionChain({ symbol: "XLF" })).rejects.toThrow(/Schwab is not connected/);
    expect(tt.chain).not.toHaveBeenCalled();
  });
});
