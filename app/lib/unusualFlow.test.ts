import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowRow } from "@/app/lib/flow";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { clearMemoryStoreForTests, resolveStoreKind } from "@/app/lib/schwabStore";
import {
  ESTIMATE_SHARE_NOTE,
  SWEEP_NOTE,
  TRADE_SHARE_NOTE,
  UNUSUAL_DTE_MAX,
  UNUSUAL_DTE_MIN,
  UNUSUAL_MIN_ASK_SHARE,
  UNUSUAL_MIN_PREMIUM,
  UNUSUAL_MIN_VOL_OI,
  UNUSUAL_OTM_MAX,
  UNUSUAL_SWEEP_MIN_CONTRACTS,
  applyUnusualScan,
  emptyUnusualBook,
  intervalsFromFlowRows,
  isSweepLikeBurst,
  parseTradeAggressor,
  parseUnusualBook,
  passesCommon,
  presetFor,
  resolveSide,
  serializeUnusualBook,
  signedOtmFraction,
  sortUnusualFlags,
  topUnusualFlags,
  unusualFlowHealth,
  unusualUniverse,
  type UnusualFlag,
  type UnusualInterval,
  type UnusualMetrics,
} from "@/app/lib/unusualFlow";
import { readUnusualBook, runUnusualFlowPass } from "@/app/lib/unusualFlowStore";

const STORE_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "VERCEL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of STORE_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearMemoryStoreForTests();
});

afterEach(() => {
  for (const key of STORE_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearMemoryStoreForTests();
});

function interval(over: Partial<UnusualInterval> = {}): UnusualInterval {
  return {
    symbol: "SPY",
    putCall: "call",
    strike: 105,
    expiration: "2026-10-30",
    volume: 3000,
    openInterest: 500,
    previousVolume: 1000,
    volumeJump: 2000,
    bid: 1.9,
    ask: 2,
    last: 2,
    mark: 1.95,
    dte: 21,
    underlyingPrice: 100,
    tradeAggressor: null,
    ...over,
  };
}

function row(over: Partial<FlowRow> = {}): FlowRow {
  const putCall = over.putCall ?? "call";
  const strike = over.strike ?? 105;
  const expiration = over.expiration ?? "2026-10-30";
  const ticker = over.ticker ?? "SPY";
  return {
    id: `${ticker}|${expiration}|${strike}|${putCall}`,
    ticker,
    putCall,
    strike,
    expiration,
    bid: 1.9,
    ask: 2,
    last: 2,
    volume: 3000,
    openInterest: 500,
    iv: null,
    delta: null,
    mid: 1.95,
    notionalPremium: 585_000,
    volOiRatio: 6,
    volumeOiJump: 2500,
    volumeExceedsOi: true,
    previousVolume: 1000,
    volumeJump: 2000,
    otmPoints: 5,
    otmFraction: 0.05,
    otm: true,
    dte: 21,
    spreadFraction: 0.05,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "",
    askFraction: 1,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 100,
    levels: null,
    prints: EMPTY_PRINTS,
    score: 1,
    ...over,
  };
}

describe("unusual flow metrics", () => {
  it("uses the preset constants", () => {
    expect(UNUSUAL_MIN_VOL_OI).toBe(3);
    expect(UNUSUAL_MIN_PREMIUM).toBe(50_000);
    expect(UNUSUAL_MIN_ASK_SHARE).toBe(0.6);
    expect(UNUSUAL_DTE_MIN).toBe(7);
    expect(UNUSUAL_DTE_MAX).toBe(60);
    expect(UNUSUAL_OTM_MAX).toBe(0.15);
    expect(UNUSUAL_SWEEP_MIN_CONTRACTS).toBe(250);
  });

  it("keeps SPY, QQQ, and IWM with the watchlist and drops duplicates", () => {
    expect(unusualUniverse(["AAPL", "spy"])).toEqual(["SPY", "QQQ", "IWM", "AAPL"]);
  });

  it("measures signed percent out of the money and premium from the mark", () => {
    expect(signedOtmFraction("call", 115, 100)).toBeCloseTo(0.15, 10);
    expect(signedOtmFraction("call", 90, 100)).toBeCloseTo(-0.1, 10);
    expect(signedOtmFraction("put", 95, 100)).toBeCloseTo(0.05, 10);
    const sample = interval();
    const book = applyUnusualScan({
      intervals: [sample],
      watchlist: ["AAPL"],
      book: emptyUnusualBook(),
      now: new Date("2026-10-01T16:00:00Z"),
    });
    const flag = book.book.flags[0];
    expect(flag.metrics.volOiRatio).toBeCloseTo(6, 10);
    expect(flag.metrics.premium).toBeCloseTo(3000 * 1.95 * 100, 6);
    expect(flag.metrics.askSidePremium).toBeCloseTo(2000 * 1.95 * 100, 6);
    expect(flag.metrics.askShare).toBe(1);
    expect(flag.metrics.bidShare).toBe(0);
    expect(flag.metrics.otmFraction).toBeCloseTo(0.05, 10);
    expect(flag.metrics.dte).toBe(21);
    expect(flag.underlyingPrice).toBe(100);
    expect(flag.metrics.sideSource).toBe("estimate");
    expect(flag.metrics.sideNote).toBe(ESTIMATE_SHARE_NOTE);
  });

  it("attributes a real aggressor and falls back to the last price when it is missing", () => {
    expect(parseTradeAggressor("BUY")).toBe("ask");
    expect(parseTradeAggressor("at bid")).toBe("bid");
    expect(parseTradeAggressor("estimated at ask")).toBeNull();
    expect(resolveSide({ bid: 1, ask: 2, last: 1, tradeAggressor: "ask" })).toEqual({ side: "ask", source: "trade" });
    expect(resolveSide({ bid: 1, ask: 2, last: 1, tradeAggressor: null }).source).toBe("estimate");

    const bought = applyUnusualScan({
      intervals: [interval({ last: 1.9, tradeAggressor: "ask" })],
      watchlist: [],
      book: emptyUnusualBook(),
      now: new Date("2026-10-01T16:00:00Z"),
    });
    expect(bought.book.flags[0].metrics.sideSource).toBe("trade");
    expect(bought.book.flags[0].metrics.askShare).toBe(1);
    expect(bought.book.flags[0].metrics.sideNote).toBe(TRADE_SHARE_NOTE);

    const estimated = applyUnusualScan({
      intervals: [interval({ last: 1.9, tradeAggressor: null })],
      watchlist: [],
      book: emptyUnusualBook(),
      now: new Date("2026-10-01T16:00:00Z"),
    });
    expect(estimated.book.flags).toHaveLength(0);
  });

  it("weights per-trade aggressors and estimates the trades that have none", () => {
    const mixed = applyUnusualScan({
      intervals: [interval({
        volumeJump: 1000,
        trades: [
          { size: 800, aggressor: "ask" },
          { size: 200, price: 1.9, bid: 1.9, ask: 2 },
        ],
      })],
      watchlist: [],
      book: emptyUnusualBook(),
      now: new Date("2026-10-01T16:00:00Z"),
    });
    const metrics = mixed.book.flags[0].metrics;
    expect(metrics.askShare).toBeCloseTo(0.8, 10);
    expect(metrics.bidShare).toBeCloseTo(0.2, 10);
    expect(metrics.sideSource).toBe("mixed");
  });

  it("calls a large at-ask jump a sweep-like burst and labels it an approximation", () => {
    expect(isSweepLikeBurst(UNUSUAL_SWEEP_MIN_CONTRACTS, "ask")).toBe(true);
    expect(isSweepLikeBurst(UNUSUAL_SWEEP_MIN_CONTRACTS - 1, "ask")).toBe(false);
    expect(isSweepLikeBurst(UNUSUAL_SWEEP_MIN_CONTRACTS, "bid")).toBe(false);
    const flagged = applyUnusualScan({
      intervals: [interval({ volumeJump: 250 })],
      watchlist: [],
      book: emptyUnusualBook(),
      now: new Date("2026-10-01T16:00:00Z"),
    });
    expect(flagged.book.flags[0].metrics.sweepLike).toBe(true);
    expect(flagged.book.flags[0].metrics.sweepNote).toBe(SWEEP_NOTE);
  });
});

describe("unusual flow presets", () => {
  const now = new Date("2026-10-01T16:00:00Z");

  function flag(over: Partial<UnusualInterval> = {}): UnusualFlag | undefined {
    return applyUnusualScan({
      intervals: [interval(over)],
      watchlist: ["AAPL"],
      book: emptyUnusualBook(),
      now,
    }).book.flags[0];
  }

  it("flags an unusually bullish call and an unusually bearish put", () => {
    const call = flag();
    expect(call?.preset).toBe("bullish");
    expect(call?.symbol).toBe("SPY");
    expect(call?.putCall).toBe("call");
    const put = flag({ putCall: "put", strike: 95 });
    expect(put?.preset).toBe("bearish");
    expect(put?.metrics.otmFraction).toBeCloseTo(0.05, 10);
  });

  it("rejects the other side, a low ratio, the bid, a small premium, the wrong window, and in-the-money", () => {
    expect(flag({ putCall: "put", strike: 105 })?.preset).not.toBe("bullish");
    expect(flag({ openInterest: 2000 })).toBeUndefined();
    expect(flag({ last: 1.9 })).toBeUndefined();
    expect(flag({ volume: 200, previousVolume: 0, volumeJump: 200, openInterest: 40, mark: 2 })).toBeUndefined();
    expect(flag({ dte: 6 })).toBeUndefined();
    expect(flag({ dte: 61 })).toBeUndefined();
    expect(flag({ strike: 116 })).toBeUndefined();
    expect(flag({ strike: 90 })).toBeUndefined();
    expect(flag({ strike: 100 })?.preset).toBe("bullish");
    expect(flag({ strike: 115 })?.preset).toBe("bullish");
  });

  it("needs mostly-at-ask across scans, then keeps the first flag", () => {
    const first = applyUnusualScan({
      intervals: [interval({ volume: 1100, previousVolume: 1000, volumeJump: 100, last: 1.9, openInterest: 200 })],
      watchlist: [],
      book: emptyUnusualBook(),
      now,
    });
    expect(first.newFlags).toBe(0);
    const second = applyUnusualScan({
      intervals: [interval({ volume: 2000, previousVolume: 1100, volumeJump: 900, last: 2, openInterest: 200 })],
      watchlist: [],
      book: first.book,
      now: new Date("2026-10-01T16:05:00Z"),
    });
    expect(second.newFlags).toBe(1);
    expect(second.book.flags[0].metrics.askShare).toBeCloseTo(0.9, 10);
    const third = applyUnusualScan({
      intervals: [interval({ volume: 2100, previousVolume: 2000, volumeJump: 100, last: 2, openInterest: 200 })],
      watchlist: [],
      book: second.book,
      now: new Date("2026-10-01T16:10:00Z"),
    });
    expect(third.newFlags).toBe(0);
    expect(third.book.flags).toHaveLength(1);
    expect(third.book.flags[0].flaggedAt).toBe(new Date("2026-10-01T16:05:00Z").getTime());
  });

  it("leaves a name off the watchlist out, including when it is not SPY, QQQ, or IWM", () => {
    const book = applyUnusualScan({
      intervals: [interval({ symbol: "TSLA" }), interval({ symbol: "AAPL" })],
      watchlist: ["AAPL"],
      book: emptyUnusualBook(),
      now,
    });
    expect(book.book.flags.map((item) => item.symbol)).toEqual(["AAPL"]);
  });

  it("does not flag on a full-day NYSE holiday", () => {
    const holiday = applyUnusualScan({
      intervals: [interval()],
      watchlist: [],
      book: emptyUnusualBook(),
      now: new Date("2026-11-26T16:00:00Z"),
    });
    expect(holiday.skipped).toBe("holiday");
    expect(holiday.book.flags).toHaveLength(0);
    expect(holiday.changed).toBe(false);
  });

  it("fills the 1, 3, and 5 trading-day marks from later scans and skips the same day", () => {
    const opened = applyUnusualScan({
      intervals: [interval()],
      watchlist: [],
      book: emptyUnusualBook(),
      now: new Date("2026-10-01T16:00:00Z"),
    });
    const later = (iso: string, underlying: number, mark: number) => applyUnusualScan({
      intervals: [interval({
        underlyingPrice: underlying,
        mark,
        bid: mark - 0.05,
        ask: mark + 0.05,
        last: mark + 0.05,
        previousVolume: 3000,
        volume: 3000,
        volumeJump: 0,
      })],
      watchlist: [],
      book: opened.book,
      now: new Date(iso),
    });
    const sameDay = later("2026-10-01T18:00:00Z", 101, 2);
    expect(sameDay.outcomes).toBe(0);
    expect(sameDay.book.flags[0].outcomes.d1).toBeNull();

    const day1 = applyUnusualScan({
      intervals: [interval({ underlyingPrice: 110, mark: 2.5, bid: 2.4, ask: 2.6, last: 2.6, previousVolume: 3000, volume: 3100, volumeJump: 100 })],
      watchlist: [],
      book: opened.book,
      now: new Date("2026-10-02T16:00:00Z"),
    });
    expect(day1.book.flags[0].outcomes.d1?.underlyingChange).toBeCloseTo(0.1, 10);
    expect(day1.book.flags[0].outcomes.d1?.optionChange).toBeCloseTo((2.5 - 1.95) / 1.95, 10);
    expect(day1.book.flags[0].outcomes.d3).toBeNull();

    const day3 = applyUnusualScan({
      intervals: [interval({ underlyingPrice: 90, mark: 1, bid: 0.95, ask: 1.05, last: 1.05, previousVolume: null, volumeJump: null })],
      watchlist: [],
      book: day1.book,
      now: new Date("2026-10-06T16:00:00Z"),
    });
    expect(day3.book.flags[0].outcomes.d3?.underlyingChange).toBeCloseTo(-0.1, 10);
    expect(day3.book.flags[0].outcomes.d5).toBeNull();

    const day5 = applyUnusualScan({
      intervals: [interval({ underlyingPrice: 120, mark: 3, bid: 2.9, ask: 3.1, last: 3.1, previousVolume: null, volumeJump: null })],
      watchlist: [],
      book: day3.book,
      now: new Date("2026-10-08T16:00:00Z"),
    });
    expect(day5.book.flags[0].outcomes.d5?.tradingDays).toBe(5);
    expect(day5.book.flags[0].outcomes.d5?.underlyingPrice).toBe(120);
    expect(day5.outcomes).toBe(1);
  });
});

describe("unusual flow list", () => {
  it("sorts by premium and keeps the top five from today", () => {
    const flags = [1, 2, 3, 4, 5, 6].map((n) => sampleFlag(n));
    expect(topUnusualFlags(flags, "2026-10-01").map((flag) => flag.metrics.premium)).toEqual([
      60_000, 50_000, 40_000, 30_000, 20_000,
    ]);
    expect(sortUnusualFlags(flags, "symbol", "asc").map((flag) => flag.symbol)[0]).toBe("AAA");
    const health = unusualFlowHealth({ flags, ledgerDay: "2026-10-01", ledger: {} }, new Date("2026-10-01T18:00:00Z"));
    expect(health.flagsToday).toBe(6);
    expect(health.bullishToday).toBe(6);
    expect(health.awaitingOutcome).toBe(6);
  });

  it("round-trips a book and does not send from the pass", async () => {
    expect(resolveStoreKind()).toBe("memory");
    const savedPass = await runUnusualFlowPass({
      rows: [row()],
      watchlist: ["AAPL"],
      now: new Date("2026-10-01T16:00:00Z"),
    });
    expect(savedPass.newFlags).toBe(1);
    expect(savedPass.saved).toBe(true);
    expect(savedPass.skipped).toBeNull();
    const stored = await readUnusualBook();
    expect(stored.flags).toHaveLength(1);
    expect(stored.flags[0].symbol).toBe("SPY");
    expect(stored.flags[0].underlyingPrice).toBe(100);
    expect(JSON.stringify(stored)).not.toContain("secret");
    const again = await runUnusualFlowPass({
      rows: [row({ previousVolume: 3000, volume: 3000, volumeJump: 0 })],
      watchlist: ["AAPL"],
      now: new Date("2026-10-01T16:05:00Z"),
    });
    expect(again.newFlags).toBe(0);
    const holiday = await runUnusualFlowPass({
      rows: [row()],
      watchlist: [],
      now: new Date("2026-11-26T16:00:00Z"),
    });
    expect(holiday.skipped).toBe("holiday");
    const parsed = parseUnusualBook(serializeUnusualBook(stored));
    expect(parsed.flags[0].contractKey).toBe(stored.flags[0].contractKey);
    expect(parsed.flags[0].outcomes.d1).toBeNull();
  });

  it("reads a flow row, including an optional trade aggressor", () => {
    const [fromRow] = intervalsFromFlowRows([Object.assign(row({ last: 1.9 }), { tradeAggressor: "sell" })]);
    expect(fromRow.tradeAggressor).toBe("bid");
    expect(fromRow.mark).toBe(1.95);
    expect(passesCommon(fromRowMetrics(fromRow))).toBe(false);
    const [tape] = intervalsFromFlowRows([Object.assign(row({ last: 1.9 }), { aggressorSide: "buy" })]);
    expect(tape.tradeAggressor).toBe("ask");
    const [unknown] = intervalsFromFlowRows([Object.assign(row({ last: 1.9 }), { aggressorSide: "unknown" })]);
    expect(unknown.tradeAggressor).toBeNull();
  });
});

function fromRowMetrics(intervalRow: UnusualInterval): UnusualMetrics {
  return {
    volume: intervalRow.volume,
    openInterest: intervalRow.openInterest,
    volOiRatio: 6,
    premium: 10_000,
    askSidePremium: 0,
    askShare: 0,
    bidShare: 1,
    sideSource: "estimate",
    sideNote: ESTIMATE_SHARE_NOTE,
    dte: 21,
    otmFraction: 0.05,
    sweepLike: false,
    sweepNote: SWEEP_NOTE,
    optionMark: 1.95,
  };
}

function sampleFlag(n: number): UnusualFlag {
  const metrics: UnusualMetrics = {
    volume: 1000,
    openInterest: 100,
    volOiRatio: 10 - n,
    premium: n * 10_000,
    askSidePremium: n * 8_000,
    askShare: 0.8,
    bidShare: 0.2,
    sideSource: "estimate",
    sideNote: ESTIMATE_SHARE_NOTE,
    dte: 20 + n,
    otmFraction: n / 100,
    sweepLike: n > 4,
    sweepNote: SWEEP_NOTE,
    optionMark: 1,
  };
  return {
    id: `2026-10-01|AAA|2026-11-20|${n}|call`,
    preset: "bullish",
    flaggedAt: n,
    tradingDay: "2026-10-01",
    symbol: n === 1 ? "ZZZ" : "AAA",
    putCall: "call",
    strike: n,
    expiration: "2026-11-20",
    contractKey: `AAA|2026-11-20|${n}|call`,
    metrics,
    underlyingPrice: 100,
    optionMark: 1,
    outcomes: { d1: null, d3: null, d5: null },
  };
}

describe("preset gate", () => {
  it("accepts a call only for bullish and a put only for bearish", () => {
    const metrics: UnusualMetrics = {
      volume: 3000,
      openInterest: 500,
      volOiRatio: 6,
      premium: 50_000,
      askSidePremium: 40_000,
      askShare: 0.6,
      bidShare: 0.4,
      sideSource: "estimate",
      sideNote: ESTIMATE_SHARE_NOTE,
      dte: 7,
      otmFraction: 0,
      sweepLike: false,
      sweepNote: SWEEP_NOTE,
      optionMark: 1,
    };
    expect(presetFor("call", metrics)).toBe("bullish");
    expect(presetFor("put", metrics)).toBe("bearish");
    expect(presetFor("call", { ...metrics, volOiRatio: 2.99 })).toBeNull();
    expect(presetFor("call", { ...metrics, premium: 49_999 })).toBeNull();
    expect(presetFor("call", { ...metrics, askShare: 0.59 })).toBeNull();
    expect(presetFor("call", { ...metrics, dte: 60 })).toBe("bullish");
    expect(presetFor("put", { ...metrics, otmFraction: 0.1500001 })).toBeNull();
  });
});
