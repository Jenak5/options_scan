import { describe, expect, it } from "vitest";
import { applyLastTrade, buildChainResult, parseCompactTrades, streamerFromOcc } from "@/app/lib/tastytradeMarketParse";

describe("DXLink last trade", () => {
  it("maps OCC to streamer symbols", () => {
    expect(streamerFromOcc("SPY   261030C00670000")).toBe(".SPY261030C670");
    expect(streamerFromOcc("TLT   261113P00077500")).toBe(".TLT261113P77.5");
    expect(streamerFromOcc("junk")).toBeNull();
  });

  it("parses compact Trade events, skipping NaN", () => {
    const map = parseCompactTrades(["Trade", [".A261030P345", 5.95, 4, 1791991476211, 3792, ".B261030C1", "NaN", "NaN", "NaN", "NaN"]]);
    expect(map.get(".A261030P345")).toEqual({ price: 5.95, size: 4, time: 1791991476211, dayVolume: 3792 });
    expect(map.get(".B261030C1")).toEqual({ price: null, size: null, time: null, dayVolume: null });
  });

  it("fills size and time, keeps the larger volume, ignores trades without time", () => {
    const base = { bid: 5.8, ask: 6.05, last: 6.0, volume: 3739, openInterest: 1518, delta: null, iv: null, strike: 345, expiration: "2026-10-30", putCall: "put" as const, lastSize: null, tradeTime: null };
    const out = applyLastTrade(base, { price: 5.95, size: 4, time: 1791991476211, dayVolume: 3792 });
    expect(out.lastSize).toBe(4);
    expect(out.tradeTime).toBe(1791991476211);
    expect(out.last).toBe(5.95);
    expect(out.volume).toBe(3792);
    expect(applyLastTrade(base, { price: 1, size: 1, time: null, dayVolume: 9e9 })).toBe(base);
    expect(applyLastTrade(base, { price: 5.9, size: 2, time: 5, dayVolume: 10 }).volume).toBe(3739);
  });

  it("buildChainResult applies trades by streamer symbol", () => {
    const sel = [{ symbol: "AAPL  261030P00345000", expiration: "2026-10-30", strike: 345, putCall: "put" as const }];
    const quotes = [{ symbol: "AAPL  261030P00345000", bid: 5.8, ask: 6.05, last: 6, volume: 3739, openInterest: 1518, delta: null, volatility: null, bidSize: null, askSize: null, updatedAt: null, prevClose: null }];
    const trades = parseCompactTrades(["Trade", [".AAPL261030P345", 5.95, 4, 1791991476211, 3792]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = buildChainResult(sel, quotes as any, 345.9, trades);
    expect(res.contracts[0].lastSize).toBe(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildChainResult(sel, quotes as any, 345.9).contracts[0].lastSize).toBeNull();
  });
});
