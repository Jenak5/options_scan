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

import { dataSourceStatus, getFlowOptionChain, resetDataSourceStatsForTests } from "@/app/lib/marketData";

const creds = { TASTYTRADE_CLIENT_ID: "id", TASTYTRADE_CLIENT_SECRET: "secret", TASTYTRADE_REFRESH_TOKEN: "refresh" };
const chain = (n: number, lastSize: number | null) => ({
  contracts: Array(n).fill({ lastSize, tradeTime: lastSize == null ? null : 1 }),
  delayed: false,
  underlyingPrice: n > 0 ? 100 : null,
});

describe("flow chain router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDataSourceStatsForTests();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("serves the Flow chain from Schwab first so last-trade size and time are present", async () => {
    sw.chain.mockResolvedValue(chain(2, 5));
    const out = await getFlowOptionChain({ symbol: "SPY" }, { ...creds });
    expect(out.contracts[0]).toMatchObject({ lastSize: 5, tradeTime: 1 });
    expect(tt.chain).not.toHaveBeenCalled();
    expect(dataSourceStatus().lastServed.chain).toMatchObject({ source: "schwab", fallback: false });
  });

  it("falls back to Tastytrade when Schwab fails or is empty", async () => {
    sw.chain.mockRejectedValueOnce(new Error("Schwab not connected"));
    tt.chain.mockResolvedValue(chain(3, null));
    await expect(getFlowOptionChain({ symbol: "SPY" }, { ...creds })).resolves.toEqual(chain(3, null));
    expect(dataSourceStatus().lastServed.chain).toMatchObject({ source: "tastytrade", fallback: true });
    sw.chain.mockResolvedValueOnce(chain(0, null));
    await getFlowOptionChain({ symbol: "SPY" }, { ...creds });
    expect(dataSourceStatus().lastServed.chain?.reason).toBe("empty Schwab answer");
  });

  it("uses Schwab only when DATA_SOURCE=schwab", async () => {
    sw.chain.mockRejectedValueOnce(new Error("down"));
    await expect(getFlowOptionChain({ symbol: "SPY" }, { ...creds, DATA_SOURCE: "schwab" })).rejects.toThrow("down");
    expect(tt.chain).not.toHaveBeenCalled();
  });

  it("rethrows Schwab errors when Tastytrade also fails", async () => {
    sw.chain.mockRejectedValueOnce(new Error("schwab down"));
    tt.chain.mockRejectedValueOnce(new Error("tt down"));
    await expect(getFlowOptionChain({ symbol: "SPY" }, { ...creds })).rejects.toThrow("tt down");
  });
});
