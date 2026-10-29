import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOptionChain, getQuotes } from "@/app/lib/marketData";
import { fetchUnusualChain, fetchUnusualQuotes, intervalsFromChain } from "@/app/lib/unusualFlowData";

vi.mock("@/app/lib/marketData", () => ({
  getOptionChain: vi.fn(),
  getQuotes: vi.fn(),
}));

describe("unusual flow market data", () => {
  beforeEach(() => {
    vi.mocked(getOptionChain).mockReset();
    vi.mocked(getQuotes).mockReset();
  });

  it("reads a chain through the shared router and keeps a trade aggressor", async () => {
    vi.mocked(getOptionChain).mockResolvedValue({
      underlyingPrice: 100,
      delayed: false,
      contracts: [{
        bid: 1.9,
        ask: 2,
        last: 1.9,
        volume: 10,
        openInterest: 4,
        delta: null,
        iv: null,
        strike: 105,
        expiration: "2026-11-20",
        putCall: "call",
        aggressor: "buy",
        trades: [{ size: 4, aggressor: "sell" }, { size: 6, price: 2, bid: 1.9, ask: 2 }],
      } as never],
    });
    const chain = await fetchUnusualChain("spy", new Date("2026-10-01T16:00:00Z"));
    expect(vi.mocked(getOptionChain).mock.calls[0][0].symbol).toBe("SPY");
    expect(chain.contracts[0].tradeAggressor).toBe("ask");
    expect(chain.contracts[0].trades?.[0].aggressor).toBe("bid");
    expect(chain.contracts[0].trades?.[1].aggressor).toBeNull();
    const [interval] = intervalsFromChain(chain, { "2026-11-20|105|call": 4 }, new Date("2026-10-01T16:00:00Z"));
    expect(interval.volumeJump).toBe(6);
    expect(interval.tradeAggressor).toBe("ask");
    expect(interval.symbol).toBe("SPY");
  });

  it("asks the shared quote router and does not invent a quote for an empty list", async () => {
    vi.mocked(getQuotes).mockResolvedValue([]);
    expect(await fetchUnusualQuotes([])).toEqual([]);
    expect(getQuotes).not.toHaveBeenCalled();
    await fetchUnusualQuotes(["SPY   261120C00500000"]);
    expect(getQuotes).toHaveBeenCalledTimes(1);
  });
});
