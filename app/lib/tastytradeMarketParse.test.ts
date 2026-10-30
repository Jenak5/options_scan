import { describe, expect, it } from "vitest";
import {
  buildChainResult,
  candlePeriod,
  historyCandleSymbol,
  chicagoMidnight,
  historyFromTime,
  nearestStrikes,
  parseEquityCandles,
  parseMarketDataItems,
  parseNestedChain,
  parseOccSymbol,
  quoteEntriesFromItems,
  selectChainSymbols,
  toPriceCandles,
  underlyingFromItems,
} from "@/app/lib/tastytradeMarketParse";

// Shapes copied from live api.tastyworks.com responses on Oct 14, 2026 (trimmed).
const nested = {
  data: { items: [{ "underlying-symbol": "SPY", expirations: [
    { "expiration-date": "2026-10-14", strikes: [
      { "strike-price": "770.0", call: "SPY   261014C00770000", put: "SPY   261014P00770000" },
      { "strike-price": "775.0", call: "SPY   261014C00775000", put: "SPY   261014P00775000" },
      { "strike-price": "780.0", call: "SPY   261014C00780000", put: "SPY   261014P00780000" },
    ] },
    { "expiration-date": "2026-12-18", strikes: [
      { "strike-price": "775.0", call: "SPY   261218C00775000", put: "SPY   261218P00775000" },
    ] },
  ] }] },
};

const optionItem = {
  ask: "36.33", "ask-size": "30.0", bid: "35.57", "bid-size": "34.0", delta: "0.975730336",
  "instrument-type": "Equity Option", last: "38.81", mark: "35.95", "open-interest": 4296,
  symbol: "SPY   261014C00775000", "updated-at": "2026-10-14T13:41:27.923Z", volatility: "0.302441752", volume: "112.0",
};
const equityItem = { symbol: "SPY", "instrument-type": "Equity", last: "775.31", mark: "775.3", bid: "775.3", ask: "775.32" };

describe("tastytrade market parsers", () => {
  it("reads the nested chain", () => {
    const exps = parseNestedChain(nested);
    expect(exps.map((e) => e.expiration)).toEqual(["2026-10-14", "2026-12-18"]);
    expect(exps[0].strikes[1]).toEqual({ strike: 775, call: "SPY   261014C00775000", put: "SPY   261014P00775000" });
  });

  it("applies the Schwab chain filters", () => {
    const exps = parseNestedChain(nested);
    const window = selectChainSymbols(exps, { fromDate: "2026-10-14", toDate: "2026-11-01", strikeCount: 1 }, 776);
    expect(window.map((s) => s.symbol)).toEqual(["SPY   261014C00775000", "SPY   261014P00775000"]);
    const exact = selectChainSymbols(exps, { contractType: "PUT", strike: 775 }, null);
    expect(exact.map((s) => s.expiration)).toEqual(["2026-10-14", "2026-12-18"]);
    expect(exact.every((s) => s.putCall === "put")).toBe(true);
    expect(nearestStrikes([{ strike: 1 }, { strike: 5 }, { strike: 9 }], 6, 2).map((r) => r.strike)).toEqual([5, 9]);
  });

  it("maps a quote to the same OptionContract shape Schwab produces", () => {
    const items = parseMarketDataItems({ data: { items: [optionItem, equityItem] } });
    expect(underlyingFromItems(items, "spy")).toBe(775.31);
    const chain = buildChainResult(
      [{ symbol: "SPY 261014C00775000", expiration: "2026-10-14", strike: 775, putCall: "call" }],
      items,
      775.31,
    );
    expect(chain).toEqual({
      delayed: false,
      underlyingPrice: 775.31,
      contracts: [{
        bid: 35.57, ask: 36.33, last: 38.81, volume: 112, openInterest: 4296, delta: 0.975730336,
        gamma: null, theta: null, vega: null, rho: null, aggressorSide: null,
        iv: 0.302441752, strike: 775, expiration: "2026-10-14", putCall: "call",
        lastSize: null, bidSize: 34, askSize: 30, tradeTime: null, quoteTime: Date.parse("2026-10-14T13:41:27.923Z"),
      }],
    });
    const entries = quoteEntriesFromItems(items);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbol).toBe("SPY   261014C00775000");
  });

  it("subscribes VXN candles at the dxFeed index symbol", () => {
    expect(historyCandleSymbol({ symbol: "vxn", frequencyType: "daily", frequency: 1 })).toBe("$VXN{=1d}");
    expect(historyCandleSymbol({ symbol: "VIX", frequencyType: "daily", frequency: 1 })).toBe("VIX{=1d}");
    expect(historyCandleSymbol({
      symbol: "SPY", frequencyType: "minute", frequency: 5, needExtendedHoursData: false,
    })).toBe("SPY{=5m,tho=true}");
    expect(historyCandleSymbol({ symbol: "not a symbol!", frequencyType: "daily", frequency: 1 })).toBeNull();
  });

  it("parses OCC symbols", () => {
    expect(parseOccSymbol("NVDA  261106P00235500")).toEqual({ root: "NVDA", expiration: "2026-11-06", putCall: "put", strike: 235.5 });
    expect(parseOccSymbol("junk")).toBeNull();
  });

  it("reads compact candles and restamps daily bars to Chicago midnight", () => {
    const rows = parseEquityCandles(["Candle", [
      "SPY{=1d}", 1791936000000, 774.9, 775.9, 774.4, 775.3, 3843712.6,
      "SPY{=1d}", 1791849600000, 777.3, 778.7, 775.9, 778.0, "NaN",
      "SPY{=1d}", 1791849600000, 0, 1, 1, 1, 5,
    ]]);
    expect(rows).toHaveLength(2);
    const daily = toPriceCandles(rows, undefined, true);
    expect(daily.map((c) => c.datetime)).toEqual([chicagoMidnight("2026-10-13"), chicagoMidnight("2026-10-14")]);
    expect(new Date(chicagoMidnight("2026-10-14")).toISOString()).toBe("2026-10-14T05:00:00.000Z");
    expect(new Date(chicagoMidnight("2026-12-14")).toISOString()).toBe("2026-12-14T06:00:00.000Z");
    expect(daily[0].volume).toBe(0);
    const intraday = toPriceCandles(rows, 1791900000000, false);
    expect(intraday.map((c) => c.datetime)).toEqual([1791849600000]);
  });

  it("maps periods and windows", () => {
    expect(candlePeriod("daily", 1)).toBe("1d");
    expect(candlePeriod("minute", 5)).toBe("5m");
    expect(historyFromTime({ periodType: "day", period: 1, startDate: 123 }, 1e12)).toBe(123);
    expect(historyFromTime({ periodType: "month", period: 3 }, 1e12)).toBe(1e12 - 93 * 864e5);
  });
});
