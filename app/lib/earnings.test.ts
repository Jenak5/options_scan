import { afterEach, describe, expect, it } from "vitest";
import { EVENT_RULES } from "@/app/lib/alertConfig";
import {
  clearEarningsCacheForTests,
  earningsForTicker,
  parseNasdaqTiming,
  parseYahooEarnings,
  setEarningsFetcherForTests,
} from "@/app/lib/earnings";
import { NO_EARNINGS_LISTED, UNKNOWN_EARNINGS } from "@/app/lib/eventRisk";

afterEach(() => {
  setEarningsFetcherForTests(null);
  clearEarningsCacheForTests();
});

describe("earnings parsers", () => {
  it("reads the next Yahoo earnings date and ignores a date that already passed", () => {
    const fact = parseYahooEarnings({
      quoteSummary: {
        result: [{
          calendarEvents: {
            earnings: {
              earningsDate: [
                { fmt: "2026-07-30" },
                { fmt: "2026-10-29" },
              ],
              isEarningsDateEstimate: false,
            },
          },
        }],
        error: null,
      },
    }, "2026-10-05");
    expect(fact).toEqual({
      status: "known",
      date: "2026-10-29",
      timing: null,
      estimated: false,
    });
  });

  it("marks an estimated Yahoo date", () => {
    const fact = parseYahooEarnings({
      quoteSummary: {
        result: [{
          calendarEvents: {
            earnings: {
              earningsDate: { fmt: "2026-11-02" },
              isEarningsDateEstimate: true,
            },
          },
        }],
        error: null,
      },
    }, "2026-10-05");
    expect(fact.status).toBe("known");
    expect(fact.date).toBe("2026-11-02");
    expect(fact.estimated).toBe(true);
  });

  it("treats a symbol with no fundamentals as no earnings calendar", () => {
    const fact = parseYahooEarnings({
      quoteSummary: {
        result: null,
        error: { code: "Not Found", description: "No fundamentals data found for symbol: SPY" },
      },
    }, "2026-10-05");
    expect(fact).toEqual(NO_EARNINGS_LISTED);
  });

  it("treats a stale Yahoo date as unknown", () => {
    const fact = parseYahooEarnings({
      quoteSummary: {
        result: [{
          calendarEvents: {
            earnings: { earningsDate: [{ fmt: "2026-01-29" }], isEarningsDateEstimate: false },
          },
        }],
        error: null,
      },
    }, "2026-10-05");
    expect(fact).toEqual(UNKNOWN_EARNINGS);
  });

  it("reads Nasdaq before and after the open", () => {
    const body = {
      data: {
        rows: [
          { symbol: "HD", time: "time-pre-market" },
          { symbol: "SNDK", time: "time-after-hours" },
          { symbol: "AAPL", time: "time-not-supplied" },
        ],
      },
    };
    expect(parseNasdaqTiming(body, "hd")).toBe("before-market");
    expect(parseNasdaqTiming(body, "SNDK")).toBe("after-market");
    expect(parseNasdaqTiming(body, "AAPL")).toBe("unspecified");
    expect(parseNasdaqTiming(body, "MSFT")).toBeNull();
    expect(parseNasdaqTiming({}, "AAPL")).toBeNull();
  });
});

describe("earnings cache", () => {
  it("keeps a known date for the configured hours and retries an unknown sooner", async () => {
    const start = Date.parse("2026-10-05T15:00:00Z");
    let calls = 0;
    setEarningsFetcherForTests(async () => {
      calls += 1;
      return { status: "known", date: "2026-12-20", timing: "after-market", estimated: false };
    });
    expect((await earningsForTicker("aapl", start)).date).toBe("2026-12-20");
    expect((await earningsForTicker("AAPL", start + 60_000)).date).toBe("2026-12-20");
    expect(calls).toBe(1);
    const later = start + EVENT_RULES.cacheHours * 60 * 60 * 1000 + 1;
    await earningsForTicker("AAPL", later);
    expect(calls).toBe(2);

    calls = 0;
    setEarningsFetcherForTests(async () => {
      calls += 1;
      throw new Error("earnings source down");
    });
    const unknownAt = start + 10_000_000;
    expect((await earningsForTicker("NVDA", unknownAt)).status).toBe("unknown");
    await earningsForTicker("NVDA", unknownAt + 60_000);
    expect(calls).toBe(1);
    const retry = unknownAt + EVENT_RULES.unknownCacheMinutes * 60 * 1000 + 1;
    expect((await earningsForTicker("NVDA", retry)).status).toBe("unknown");
    expect(calls).toBe(2);
  });

  it("looks up each ticker once while the cache is warm", async () => {
    const start = Date.parse("2026-10-05T15:00:00Z");
    let calls = 0;
    setEarningsFetcherForTests(async () => {
      calls += 1;
      return { status: "known", date: "2026-12-20", timing: "unspecified", estimated: false };
    });
    const tickers = ["SPY", "JPM", "BA", "XOM", "XLF", "GLD", "NVDA", "COST", "AVGO"];
    for (let i = 0; i < tickers.length; i++) await earningsForTicker(tickers[i], start);
    expect(calls).toBe(tickers.length);
    for (let i = 0; i < tickers.length; i++) await earningsForTicker(tickers[i], start + 1_000);
    expect(calls).toBe(tickers.length);
  });

  it("does not call the network for a ticker that is not a symbol", async () => {
    let calls = 0;
    setEarningsFetcherForTests(async () => {
      calls += 1;
      return UNKNOWN_EARNINGS;
    });
    expect((await earningsForTicker("not a ticker")).status).toBe("unknown");
    expect(calls).toBe(0);
  });
});
