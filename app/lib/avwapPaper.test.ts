import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  AVWAP_BUDGET_DOLLARS,
  AVWAP_DRAWDOWN_FLAG_DOLLARS,
  AVWAP_FEE_PER_SIDE,
  AVWAP_GAP_FRACTION,
  AVWAP_PAPER_NOTE,
  AVWAP_RULES_OLD,
  AVWAP_RULES_VERSION,
  lastTradingDayBeforeExpiry,
  advanceAvwapPaper,
  anchorCovered,
  atmStrike,
  avwapContractCount,
  avwapDailyStop,
  avwapDrawdown,
  avwapPaperBrief,
  avwapPnl,
  avwapPoints,
  avwapSessionOpen,
  emptyAvwapPaperBook,
  expiryCandidates,
  firstAvwapReject,
  fiveMinuteBars,
  formatAvwapPaperAlert,
  isGapSession,
  latestAvwapCross,
  latestGapDay,
  minuteHistoryChunks,
  parseAvwapPaperBook,
  quotePlan,
  serializeAvwapPaperBook,
  avwapPaperSection,
  signalIsFresh,
  timeStopDue,
  type AvwapPaperTrade,
  type AvwapSnapshot,
} from "@/app/lib/avwapPaper";
import { formatAvwapPaperLog, runAvwapPaper, type AvwapPaperDeps } from "@/app/lib/avwapPaperRun";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { clearMemoryStoreForTests } from "@/app/lib/schwabStore";

const DAY = "2026-10-28T13:40:00.000Z";
const NOW = new Date(DAY);

function bar(iso: string, o: number, h: number, l: number, c: number, v?: number): CandleBar {
  return { t: Date.parse(iso), o, h, l, c, v };
}

function gapDays(): CandleBar[] {
  return [
    bar("2026-10-27T14:00:00.000Z", 438, 441, 437, 440, 1_000_000),
    bar("2026-10-28T14:00:00.000Z", 450, 451, 447, 448, 1_000_000),
  ];
}

function signalBars(): CandleBar[] {
  return [
    bar("2026-10-28T13:30:00.000Z", 449, 451, 449, 450, 1000),
    bar("2026-10-28T13:35:00.000Z", 449, 450, 447, 448, 1000),
  ];
}

function snapshot(over: Partial<AvwapSnapshot> = {}): AvwapSnapshot {
  return {
    symbol: "SPY",
    daily: gapDays().map((row) => ({ t: row.t, open: row.o, close: row.c })),
    bars: signalBars(),
    quotes: [
      { expiration: "2026-11-04", strike: 448, bid: 2, ask: 2.2 },
      { expiration: "2026-11-11", strike: 448, bid: 2.1, ask: 2.3 },
    ],
    ...over,
  };
}

function closedLoss(id: string, closedAt: string, pnl: number): AvwapPaperTrade {
  const at = Date.parse(closedAt);
  return {
    id,
    symbol: "IWM",
    putCall: "put",
    strike: 200,
    expiration: "2026-11-04",
    dte: 7,
    contracts: 1,
    openedAt: at - 60_000,
    signalAt: at - 300_000,
    anchorDate: "2026-10-28",
    gap: 0.02,
    spot: 200,
    signalClose: 199,
    signalVwap: 200,
    entryAsk: 2,
    entryBid: 1.9,
    lastBid: 1,
    lastAsk: 1.1,
    lastQuoteAt: at,
    quoteSource: null,
    rulesVersion: "old",
    status: "closed",
    closedAt: at,
    exitBid: 1,
    exitAsk: 1.1,
    exitReason: "expiry",
    exitNote: null,
    pnlDollars: pnl,
    whatIfs: [],
  };
}

describe("anchored VWAP", () => {
  it("weights typical price and floors a missing volume at 1", () => {
    const now = Date.parse("2026-10-28T13:40:00.000Z");
    const points = avwapPoints([
      bar("2026-10-28T13:30:00.000Z", 9, 10, 8, 9, 100),
      bar("2026-10-28T13:35:00.000Z", 8, 10, 7, 8, 100),
    ], "2026-10-28", now);
    expect(points).toHaveLength(2);
    expect(points[0].vwap).toBe(9);
    expect(points[1].vwap).toBeCloseTo(26 / 3, 8);

    const floored = avwapPoints([
      bar("2026-10-28T13:30:00.000Z", 9, 9, 9, 9, 0),
      bar("2026-10-28T13:35:00.000Z", 6, 6, 6, 6),
    ], "2026-10-28", now);
    expect(floored[1].vwap).toBeCloseTo(7.5, 8);
  });

  it("rolls 1-minute bars into a 5-minute bucket and drops premarket and the unfinished bar", () => {
    const now = Date.parse("2026-10-28T13:35:00.000Z");
    const minutes = [
      bar("2026-10-28T13:00:00.000Z", 90, 91, 89, 90, 5),
      bar("2026-10-28T13:30:00.000Z", 100, 101, 99, 100, 10),
      bar("2026-10-28T13:31:00.000Z", 100, 102, 99.5, 101, 10),
      bar("2026-10-28T13:32:00.000Z", 101, 101, 100, 100.5, 10),
      bar("2026-10-28T13:33:00.000Z", 100.5, 101, 100, 100.2, 10),
      bar("2026-10-28T13:34:00.000Z", 100.2, 100.5, 99.8, 100, 10),
      bar("2026-10-28T13:35:00.000Z", 100, 100, 99, 99, 10),
    ];
    expect(fiveMinuteBars(minutes, now)).toEqual([
      { t: Date.parse("2026-10-28T13:30:00.000Z"), o: 100, h: 102, l: 99, c: 100, v: 50 },
    ]);
  });

  it("starts at the gap day and leaves an early-close afternoon bar out", () => {
    const now = Date.parse("2026-11-27T18:05:00.000Z");
    const bars = [
      bar("2026-11-26T14:30:00.000Z", 10, 10, 10, 10, 10),
      bar("2026-11-27T17:55:00.000Z", 11, 12, 10, 11, 10),
      bar("2026-11-27T18:00:00.000Z", 11, 12, 10, 11, 10),
    ];
    const points = avwapPoints(bars, "2026-11-27", now);
    expect(points.map((point) => point.t)).toEqual([Date.parse("2026-11-27T17:55:00.000Z")]);
  });
});

describe("gap day and signal", () => {
  it("uses a gap of more than 1 percent and keeps the latest one", () => {
    expect(AVWAP_GAP_FRACTION).toBe(0.01);
    expect(isGapSession(101, 100)).toBe(false);
    expect(isGapSession(101.02, 100)).toBe(true);
    expect(isGapSession(98, 100)).toBe(true);
    const gap = latestGapDay([
      { date: "2026-10-26", open: 100, close: 100 },
      { date: "2026-10-27", open: 102, close: 100 },
      { date: "2026-10-28", open: 101, close: 100 },
    ]);
    expect(gap?.date).toBe("2026-10-27");
    expect(gap?.gap).toBeCloseTo(0.02, 8);
    expect(latestGapDay([
      { date: "2026-10-27", open: 100, close: 100 },
      { date: "2026-10-28", open: 98, close: 97 },
    ])?.gap).toBeCloseTo(-0.02, 8);
  });

  it("fires on the first 5-minute close below the anchored VWAP after a close at or above it", () => {
    const now = Date.parse(DAY);
    const bars = [
      bar("2026-10-28T13:30:00.000Z", 10, 10, 10, 10, 10),
      bar("2026-10-28T13:35:00.000Z", 10, 10, 10, 10, 10),
      bar("2026-10-28T13:40:00.000Z", 9, 10, 8, 9, 10),
      bar("2026-10-28T13:45:00.000Z", 11, 12, 11, 12, 10),
      bar("2026-10-28T13:50:00.000Z", 9, 10, 8, 8, 10),
    ];
    const later = Date.parse("2026-10-28T13:55:00.000Z");
    const signal = firstAvwapReject(bars, "2026-10-28", later);
    expect(signal).toMatchObject({ at: Date.parse("2026-10-28T13:40:00.000Z"), close: 9 });
    expect(signal && signal.close < signal.vwap).toBe(true);
    expect(signal && signal.priorClose >= signal.priorVwap).toBe(true);
    expect(firstAvwapReject(bars.slice(0, 2), "2026-10-28", now)).toBeNull();
    expect(signal && signalIsFresh(signal, Date.parse("2026-10-28T13:45:00.000Z"))).toBe(true);
    expect(signal && signalIsFresh(signal, Date.parse("2026-10-28T14:01:00.000Z"))).toBe(false);
  });

  it("picks the expiry nearest 7 and 14 calendar days, skipping weekends and Thanksgiving", () => {
    expect(expiryCandidates("2026-10-28", 5, 10, 7)[0]).toBe("2026-11-04");
    expect(expiryCandidates("2026-10-28", 12, 16, 14)[0]).toBe("2026-11-11");
    expect(expiryCandidates("2026-11-20", 5, 10, 7)[0]).toBe("2026-11-27");
    expect(expiryCandidates("2026-11-19", 5, 10, 7)[0]).toBe("2026-11-25");
    expect(expiryCandidates("2026-11-20", 5, 10, 7)).not.toContain("2026-11-26");
    expect(atmStrike(448.4)).toBe(448);
    expect(atmStrike(448.5)).toBe(449);
  });

  it("loads 5-minute bars back to a Sep 17 anchor instead of the last 12 days", () => {
    const now = Date.parse("2026-10-29T19:35:00.000Z");
    const chunks = minuteHistoryChunks("2026-09-17", now);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startDate).toBe(Date.parse("2026-09-17T00:00:00.000Z"));
    expect(chunks[chunks.length - 1].endDate).toBe(now);
    expect(chunks.every((chunk) => chunk.endDate - chunk.startDate <= 8 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(now - 12 * 24 * 60 * 60 * 1000).toBeGreaterThan(Date.parse("2026-09-18T00:00:00.000Z"));
  });

  it("papers the latest prior-bar cross even when an older cross already happened", () => {
    const older = [
      bar("2026-10-26T13:30:00.000Z", 100, 100, 100, 100, 100),
      bar("2026-10-26T13:35:00.000Z", 90, 100, 90, 90, 100),
    ];
    const again = [
      ...older,
      bar("2026-10-28T13:30:00.000Z", 110, 110, 110, 110, 100),
      bar("2026-10-28T13:35:00.000Z", 95, 100, 90, 95, 100),
    ];
    const now = Date.parse("2026-10-28T13:40:00.000Z");
    const first = firstAvwapReject(again, "2026-10-26", now);
    const latest = latestAvwapCross(again, "2026-10-26", now);
    expect(first?.at).toBe(Date.parse("2026-10-26T13:35:00.000Z"));
    expect(latest?.at).toBe(Date.parse("2026-10-28T13:35:00.000Z"));
    expect(latest && latest.priorClose >= latest.priorVwap && latest.close < latest.vwap).toBe(true);
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot({
      daily: [
        { date: "2026-10-23", open: 100, close: 100 },
        { date: "2026-10-26", open: 102, close: 100 },
        { date: "2026-10-27", open: 100.2, close: 100 },
        { date: "2026-10-28", open: 100.4, close: 95 },
      ],
      bars: again,
      quotes: [
        { expiration: "2026-11-04", strike: 95, bid: 2, ask: 2.2 },
        { expiration: "2026-11-11", strike: 95, bid: 2.1, ask: 2.3 },
      ],
    })], new Date(now));
    expect(opened.opened).toHaveLength(1);
    expect(opened.opened[0].signalAt).toBe(latest?.at);
    expect(opened.book.checks.SPY).toMatchObject({ anchorDate: "2026-10-26", entered: true });
  });

  it("does not invent an anchored VWAP when the 5-minute bars start after the gap day", () => {
    const now = new Date(DAY);
    const missed = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot({
      daily: [
        { date: "2026-09-16", open: 500, close: 500 },
        { date: "2026-09-17", open: 520, close: 530 },
        { date: "2026-10-27", open: 532, close: 670 },
        { date: "2026-10-28", open: 671, close: 668 },
      ],
      bars: signalBars(),
    })], now);
    expect(anchorCovered(signalBars(), "2026-09-17", now.getTime()).covered).toBe(false);
    expect(missed.opened).toHaveLength(0);
    expect(missed.book.checks.SPY).toMatchObject({
      anchorDate: "2026-09-17",
      entered: false,
    });
    expect(missed.book.checks.SPY?.reason).toMatch(/before the 5-minute history/);
    expect(missed.book.checks.SPY?.reason).toMatch(/Anchored VWAP was not computed/);
    const section = avwapPaperSection(missed.book, now, true);
    expect(section.health.lastCheckAt).toBe(now.toISOString());
    expect(section.health.symbols.SPY.reason).toMatch(/2026-09-17/);
    expect(section.health.symbols.QQQ.reason).toMatch(/no bars/);
    expect(formatAvwapPaperLog({
      opened: 0,
      closed: 0,
      saved: true,
      skipped: null,
      drawdownFlag: false,
      logNote: section.health.symbols.SPY.reason,
    })).toMatch(/^AVWAP paper:/);
  });
});

describe("size, fees, and exits", () => {
  it("buys whole contracts inside $875 and skips a contract that costs more", () => {
    expect(avwapContractCount(4)).toBe(2);
    expect(avwapContractCount(8.75)).toBe(1);
    expect(avwapContractCount(8.76)).toBe(0);
    expect(avwapContractCount(2.5)).toBe(3);
    expect(avwapContractCount(0.1)).toBe(87);
    expect(8.75 * 100).toBe(AVWAP_BUDGET_DOLLARS);
    expect(avwapContractCount(0)).toBeNull();
    expect(avwapPnl(2, 3, 2)).toBeCloseTo(200 - AVWAP_FEE_PER_SIDE * 2 * 2, 2);
  });

  it("sells the primary at +50% and records the 25% and 14-day what-ifs", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    expect(opened.opened).toHaveLength(1);
    const trade = opened.opened[0];
    expect(trade).toMatchObject({
      symbol: "SPY",
      putCall: "put",
      strike: 448,
      expiration: "2026-11-04",
      contracts: 3,
      entryAsk: 2.2,
      entryBid: 2,
      status: "open",
      rulesVersion: AVWAP_RULES_VERSION,
    });
    expect(trade.whatIfs.find((leg) => leg.id === "old50-or-expiry")).toMatchObject({
      label: "old rule: +50% or expiry",
      expiration: "2026-11-04",
      contracts: 3,
      entryAsk: 2.2,
      status: "open",
    });
    expect(trade.whatIfs.find((leg) => leg.id === "dte14")).toMatchObject({
      expiration: "2026-11-11",
      contracts: 3,
      entryAsk: 2.3,
      status: "open",
    });
    expect(formatAvwapPaperAlert(trade)).toContain("PAPER ONLY");
    expect(formatAvwapPaperAlert(trade)).toContain("No order is placed");

    const quoteAt = Date.parse("2026-10-28T13:44:30.000Z");
    const hit = advanceAvwapPaper(opened.book, [snapshot({
      quotes: [
        { expiration: "2026-11-04", strike: 448, bid: 3.3, ask: 3.4, quoteTime: quoteAt, source: "tastytrade" },
        { expiration: "2026-11-11", strike: 448, bid: 2.2, ask: 2.4, quoteTime: quoteAt, source: "tastytrade" },
      ],
    })], new Date("2026-10-28T13:45:00.000Z"));
    expect(hit.closed[0]).toMatchObject({
      status: "closed",
      exitReason: "target50",
      exitBid: 3.3,
      exitAsk: 3.4,
      lastQuoteAt: quoteAt,
      quoteSource: "tastytrade",
      pnlDollars: avwapPnl(2.2, 3.3, 3),
    });
    expect(hit.closed[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")).toMatchObject({
      status: "closed",
      exitReason: "target50",
      exitBid: 3.3,
    });
    expect(hit.closed[0].whatIfs.find((leg) => leg.id === "target25-or-3d")).toMatchObject({
      status: "closed",
      exitReason: "target25",
      exitBid: 3.3,
    });
    expect(hit.closed[0].whatIfs.find((leg) => leg.id === "dte14")?.status).toBe("open");
    expect(hit.opened).toHaveLength(0);
  });

  it("closes the day before expiration and leaves the old rule open until expiry", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    expect(opened.opened[0].expiration).toBe("2026-11-04");
    expect(lastTradingDayBeforeExpiry("2026-11-04")).toBe("2026-11-03");
    const before = advanceAvwapPaper(opened.book, [snapshot()], new Date("2026-11-03T20:50:00.000Z"));
    expect(before.closed).toHaveLength(0);
    const quoteAt = Date.parse("2026-11-03T20:54:40.000Z");
    const pre = advanceAvwapPaper(opened.book, [snapshot({
      quotes: [
        { expiration: "2026-11-04", strike: 448, bid: 2, ask: 2.1, quoteTime: quoteAt, source: "schwab" },
        { expiration: "2026-11-11", strike: 448, bid: 2.1, ask: 2.2 },
      ],
    })], new Date("2026-11-03T20:55:00.000Z"));
    expect(pre.closed[0]).toMatchObject({
      exitReason: "preExpiry",
      exitBid: 2,
      exitAsk: 2.1,
      lastQuoteAt: quoteAt,
      quoteSource: "schwab",
      pnlDollars: avwapPnl(2.2, 2, 3),
    });
    expect(pre.closed[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")?.status).toBe("open");
    const oldBefore = advanceAvwapPaper(pre.book, [snapshot()], new Date("2026-11-04T20:50:00.000Z"));
    expect(oldBefore.book.trades[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")?.status).toBe("open");
    const expiry = advanceAvwapPaper(pre.book, [snapshot({
      quotes: [
        { expiration: "2026-11-04", strike: 448, bid: 2, ask: 2.1 },
        { expiration: "2026-11-11", strike: 448, bid: 2.1, ask: 2.2 },
      ],
    })], new Date("2026-11-04T20:55:00.000Z"));
    expect(expiry.closed).toHaveLength(0);
    expect(expiry.book.trades[0].exitReason).toBe("preExpiry");
    expect(expiry.book.trades[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")).toMatchObject({
      status: "closed",
      exitReason: "expiry",
      exitBid: 2,
    });
  });

  it("closes a Friday expiry on Thursday, a Monday expiry on Friday, and skips a holiday", () => {
    expect(lastTradingDayBeforeExpiry("2026-11-06")).toBe("2026-11-05");
    expect(lastTradingDayBeforeExpiry("2026-11-09")).toBe("2026-11-06");
    expect(lastTradingDayBeforeExpiry("2026-11-27")).toBe("2026-11-25");
    expect(lastTradingDayBeforeExpiry("2026-11-30")).toBe("2026-11-27");
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);

    const friday = { ...opened.book, trades: [retimed(opened.opened[0], "2026-11-02T14:40:00.000Z", "2026-11-06")] };
    expect(advanceAvwapPaper(friday, [liveQuote("2026-11-06", 2)], new Date("2026-11-04T20:55:00.000Z")).closed).toHaveLength(0);
    expect(advanceAvwapPaper(friday, [liveQuote("2026-11-06", 2)], new Date("2026-11-05T20:50:00.000Z")).closed).toHaveLength(0);
    expect(advanceAvwapPaper(friday, [liveQuote("2026-11-06", 2)], new Date("2026-11-05T20:55:00.000Z")).closed[0]).toMatchObject({
      exitReason: "preExpiry",
      exitBid: 2,
    });

    const monday = { ...opened.book, trades: [retimed(opened.opened[0], "2026-11-02T14:40:00.000Z", "2026-11-09")] };
    expect(advanceAvwapPaper(monday, [liveQuote("2026-11-09", 1.8)], new Date("2026-11-05T20:55:00.000Z")).closed).toHaveLength(0);
    expect(advanceAvwapPaper(monday, [liveQuote("2026-11-09", 1.8)], new Date("2026-11-06T20:50:00.000Z")).closed).toHaveLength(0);
    expect(advanceAvwapPaper(monday, [liveQuote("2026-11-09", 1.8)], new Date("2026-11-06T20:55:00.000Z")).closed[0]).toMatchObject({
      exitReason: "preExpiry",
      exitBid: 1.8,
    });

    const afterHoliday = { ...opened.book, trades: [retimed(opened.opened[0], "2026-11-20T14:40:00.000Z", "2026-11-27")] };
    expect(advanceAvwapPaper(afterHoliday, [liveQuote("2026-11-27", 1.5)], new Date("2026-11-24T20:55:00.000Z")).closed).toHaveLength(0);
    expect(advanceAvwapPaper(afterHoliday, [liveQuote("2026-11-27", 1.5)], new Date("2026-11-25T20:50:00.000Z")).closed).toHaveLength(0);
    const holidayClose = advanceAvwapPaper(afterHoliday, [liveQuote("2026-11-27", 1.5)], new Date("2026-11-25T20:55:00.000Z"));
    expect(holidayClose.closed[0]).toMatchObject({ exitReason: "preExpiry", exitBid: 1.5, quoteSource: "tastytrade" });
    expect(holidayClose.closed[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")?.status).toBe("open");
    const early = advanceAvwapPaper(holidayClose.book, [liveQuote("2026-11-27", 1.4)], new Date("2026-11-27T17:55:00.000Z"));
    expect(early.book.trades[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")).toMatchObject({
      status: "closed",
      exitReason: "expiry",
      exitBid: 1.4,
    });

    const earlyMonday = { ...opened.book, trades: [retimed(opened.opened[0], "2026-11-24T14:40:00.000Z", "2026-11-30")] };
    expect(advanceAvwapPaper(earlyMonday, [liveQuote("2026-11-30", 1.6)], new Date("2026-11-25T20:55:00.000Z")).closed).toHaveLength(0);
    expect(advanceAvwapPaper(earlyMonday, [liveQuote("2026-11-30", 1.6)], new Date("2026-11-27T17:54:00.000Z")).closed).toHaveLength(0);
    expect(advanceAvwapPaper(earlyMonday, [liveQuote("2026-11-30", 1.6)], new Date("2026-11-27T17:55:00.000Z")).closed[0]).toMatchObject({
      exitReason: "preExpiry",
      exitBid: 1.6,
    });
  });

  it("closes the 25% and 14-day what-ifs after 3 trading days while the primary is still open", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    expect(timeStopDue(opened.opened[0].openedAt, new Date("2026-11-02T20:50:00.000Z"))).toBe(false);
    expect(timeStopDue(opened.opened[0].openedAt, new Date("2026-11-02T20:55:00.000Z"))).toBe(true);
    const held = advanceAvwapPaper(opened.book, [snapshot({
      quotes: [
        { expiration: "2026-11-04", strike: 448, bid: 2.4, ask: 2.5 },
        { expiration: "2026-11-11", strike: 448, bid: 2.4, ask: 2.5 },
      ],
    })], new Date("2026-11-02T20:55:00.000Z"));
    expect(held.closed).toHaveLength(0);
    const trade = held.book.trades[0];
    expect(trade.status).toBe("open");
    expect(trade.whatIfs.find((leg) => leg.id === "target25-or-3d")).toMatchObject({ status: "closed", exitReason: "time3", exitBid: 2.4 });
    expect(trade.whatIfs.find((leg) => leg.id === "dte14")).toMatchObject({ status: "closed", exitReason: "time3" });
    expect(trade.whatIfs.find((leg) => leg.id === "old50-or-expiry")?.status).toBe("open");
  });

  it("keeps a 60% loss open until the last trading day before expiration", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const bid = 2.2 * 0.4;
    const losing = [snapshot({
      quotes: [{ expiration: "2026-11-04", strike: 448, bid, ask: 1, source: "tastytrade" }],
    })];
    const early = advanceAvwapPaper(opened.book, losing, new Date("2026-11-02T20:55:00.000Z"));
    expect(early.closed).toHaveLength(0);
    expect(early.book.trades[0].status).toBe("open");
    expect(early.book.trades[0].lastBid).toBeCloseTo(bid, 8);
    const closed = advanceAvwapPaper(opened.book, losing, new Date("2026-11-03T20:55:00.000Z"));
    expect(closed.closed[0]).toMatchObject({ exitReason: "preExpiry", exitBid: bid, quoteSource: "tastytrade" });
    expect(AVWAP_FEE_PER_SIDE).toBe(0.65);
  });

  it("takes the +50% target when that bid and the pre-expiry scan arrive together", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const quoteAt = Date.parse("2026-11-03T20:54:05.000Z");
    const both = advanceAvwapPaper(opened.book, [snapshot({
      quotes: [
        { expiration: "2026-11-04", strike: 448, bid: 3.3, ask: 3.4, quoteTime: quoteAt, source: "tastytrade" },
        { expiration: "2026-11-11", strike: 448, bid: 2.2, ask: 2.4 },
      ],
    })], new Date("2026-11-03T20:55:00.000Z"));
    expect(both.closed[0]).toMatchObject({
      exitReason: "target50",
      exitBid: 3.3,
      exitAsk: 3.4,
      lastQuoteAt: quoteAt,
      quoteSource: "tastytrade",
    });
    expect(both.closed[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")).toMatchObject({
      status: "closed",
      exitReason: "target50",
    });
  });

  it("closes at 0 when the bid is gone after expiration", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const book = { ...opened.book, trades: [retimed(opened.opened[0], "2026-11-02T14:40:00.000Z", "2026-11-06")] };
    const missed = advanceAvwapPaper(book, [snapshot({ quotes: [] })], new Date("2026-11-09T15:00:00.000Z"));
    expect(missed.closed[0]).toMatchObject({
      exitReason: "expiry",
      exitBid: 0,
      exitNote: "No bid after expiration. Closed at 0.",
      pnlDollars: avwapPnl(2.2, 0, 3),
    });
  });

  it("keeps stored closes on the old rule and does not reprice them", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const raw = JSON.parse(serializeAvwapPaperBook(opened.book)) as { trades: Record<string, unknown>[] };
    delete raw.trades[0].rulesVersion;
    const openOld = parseAvwapPaperBook(JSON.stringify(raw));
    expect(openOld.trades[0].rulesVersion).toBe(AVWAP_RULES_OLD);
    expect(openOld.trades[0].whatIfs.some((leg) => leg.id === "old50-or-expiry")).toBe(true);
    const held = advanceAvwapPaper(openOld, [snapshot({
      quotes: [{ expiration: "2026-11-04", strike: 448, bid: 2.2 * 0.4, ask: 1 }],
    })], new Date("2026-11-03T20:55:00.000Z"));
    expect(held.closed).toHaveLength(0);
    expect(held.book.trades[0].status).toBe("open");
    expect(held.book.trades[0].rulesVersion).toBe(AVWAP_RULES_OLD);

    const closed = [0, 1, 2].map((i) => {
      const row = JSON.parse(JSON.stringify(closedLoss(`old-${i}`, "2026-10-2" + (i + 6) + "T15:00:00.000Z", -10 - i))) as Record<string, unknown>;
      delete row.rulesVersion;
      delete row.quoteSource;
      return row;
    });
    const parsed = parseAvwapPaperBook(JSON.stringify({ version: 1, trades: closed, notes: {}, checks: {}, updatedAt: 1 }));
    const kept = parsed.trades.slice().sort((a, b) => a.id.localeCompare(b.id));
    expect(kept).toHaveLength(3);
    expect(kept.map((trade) => trade.rulesVersion)).toEqual([AVWAP_RULES_OLD, AVWAP_RULES_OLD, AVWAP_RULES_OLD]);
    expect(kept.map((trade) => trade.pnlDollars)).toEqual([-10, -11, -12]);
    expect(kept.map((trade) => trade.exitBid)).toEqual([1, 1, 1]);
    expect(kept.map((trade) => trade.exitReason)).toEqual(["expiry", "expiry", "expiry"]);
    expect(kept.every((trade) => trade.whatIfs.length === 0)).toBe(true);
    const again = advanceAvwapPaper(parsed, [snapshot()], NOW);
    const still = again.book.trades.filter((trade) => trade.id.startsWith("old-")).sort((a, b) => a.id.localeCompare(b.id));
    expect(still.map((trade) => trade.pnlDollars)).toEqual([-10, -11, -12]);
    expect(still.map((trade) => trade.exitReason)).toEqual(["expiry", "expiry", "expiry"]);
    expect(AVWAP_PAPER_NOTE).toMatch(/last trading day before expiration/);
    expect(AVWAP_PAPER_NOTE).not.toMatch(/trading day 3|down 35%/);
    expect(AVWAP_PAPER_NOTE).toMatch(/old rule: \+50% or expiry/);
    expect(AVWAP_PAPER_NOTE).toMatch(/3:55 PM ET/);
    expect(AVWAP_PAPER_NOTE).toMatch(/12:55 PM ET/);
  });

  it("stops new entries after two losing closes in a row, and flags a $1,500 drawdown", () => {
    const book = {
      ...emptyAvwapPaperBook(),
      trades: [
        closedLoss("a", "2026-10-28T14:00:00.000Z", -10),
        closedLoss("b", "2026-10-28T15:00:00.000Z", -12),
      ],
    };
    expect(avwapDailyStop(book.trades, NOW)).toMatchObject({ dailyStop: true, consecutiveLosses: 2 });
    const blocked = advanceAvwapPaper(book, [snapshot()], NOW);
    expect(blocked.opened).toHaveLength(0);
    expect(blocked.book.notes.SPY).toMatch(/daily stop/);

    const reset = advanceAvwapPaper({
      ...book,
      trades: [closedLoss("a", "2026-10-28T14:00:00.000Z", -10), closedLoss("b", "2026-10-28T15:00:00.000Z", 5)],
    }, [snapshot()], NOW);
    expect(reset.opened).toHaveLength(1);

    expect(avwapDrawdown([closedLoss("a", "2026-10-28T14:00:00.000Z", -1500)]).flagged).toBe(false);
    expect(avwapDrawdown([closedLoss("a", "2026-10-28T14:00:00.000Z", -1500.01)]).flagged).toBe(true);
    expect(AVWAP_DRAWDOWN_FLAG_DOLLARS).toBe(1500);
    const deep = avwapDrawdown([
      closedLoss("a", "2026-10-01T15:00:00.000Z", 100),
      closedLoss("b", "2026-10-02T15:00:00.000Z", -800),
      closedLoss("c", "2026-10-05T15:00:00.000Z", -900),
    ]);
    expect(deep.maxDrawdownDollars).toBeGreaterThan(1500);
    expect(deep.flagged).toBe(true);
    expect(deep.cumulativePnlDollars).toBeCloseTo(-1600, 2);
  });

  it("keeps one open paper position per symbol and ignores a stale cross", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const again = advanceAvwapPaper(opened.book, [snapshot()], new Date("2026-10-28T13:45:00.000Z"));
    expect(again.opened).toHaveLength(0);
    expect(again.book.notes.SPY).toMatch(/already open/);

    const stale = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], new Date("2026-10-28T14:30:00.000Z"));
    expect(stale.opened).toHaveLength(0);
    expect(stale.book.notes.SPY).toMatch(/older than this scan/);
  });

  it("does not paper a second time after the same cross is closed", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const closed = advanceAvwapPaper(opened.book, [snapshot({
      quotes: [{ expiration: "2026-11-04", strike: 448, bid: 4, ask: 4.1 }],
    })], new Date("2026-10-28T13:45:00.000Z"));
    const later = advanceAvwapPaper(closed.book, [snapshot()], new Date("2026-10-28T13:50:00.000Z"));
    expect(later.opened).toHaveLength(0);
    expect(later.book.trades.filter((trade) => trade.symbol === "SPY")).toHaveLength(1);
  });

  it("round-trips the book and skips a name outside the session or on a holiday", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const parsed = parseAvwapPaperBook(serializeAvwapPaperBook(opened.book));
    expect(parsed.trades[0].pnlDollars).toBeNull();
    expect(parsed.trades[0].entryAsk).toBe(2.2);
    expect(parsed.trades[0].rulesVersion).toBe(AVWAP_RULES_VERSION);
    expect(parsed.trades[0].whatIfs.find((leg) => leg.id === "old50-or-expiry")?.label).toBe("old rule: +50% or expiry");
    expect(parseAvwapPaperBook("{").trades).toEqual([]);
    expect(avwapSessionOpen(new Date("2026-11-26T15:30:00.000Z"))).toBe(false);
    expect(advanceAvwapPaper(opened.book, [snapshot()], new Date("2026-11-26T15:30:00.000Z")).opened).toEqual([]);
    const brief = avwapPaperBrief(opened.book.trades, NOW);
    expect(brief.paperOnly).toBe(true);
    expect(brief.note).toMatch(/last trading day before expiration/);
    expect(brief.openRows[0]).toMatchObject({ symbol: "SPY", entryAsk: 2.2, entryBid: 2, status: "open", rulesVersion: AVWAP_RULES_VERSION });
    const plan = quotePlan(emptyAvwapPaperBook(), [snapshot()], NOW);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((item) => item.occ.includes("P"))).toBe(true);
    expect(quotePlan(emptyAvwapPaperBook(), [snapshot()], new Date("2026-11-26T15:30:00.000Z"))).toEqual([]);
  });
});

describe("AVWAP paper scan", () => {
  afterEach(() => {
    clearMemoryStoreForTests();
    vi.restoreAllMocks();
  });

  it("does not read the market on a NYSE holiday", async () => {
    const daily = vi.fn(async () => []);
    const deps = memoryDeps(daily);
    const holiday = await runAvwapPaper(new Date("2026-11-26T15:30:00.000Z"), deps.deps);
    expect(holiday.skipped).toBe("holiday");
    expect(daily).not.toHaveBeenCalled();
    expect(deps.sent).not.toHaveBeenCalled();
  });

  it("records a paper put from price history and quotes, then exits at the bid", async () => {
    const deps = memoryDeps();
    const first = await runAvwapPaper(NOW, deps.deps);
    expect(first.opened).toBe(1);
    expect(first.saved).toBe(true);
    expect(deps.sent).toHaveBeenCalledTimes(1);
    expect(deps.sent.mock.calls[0][0]).toContain("PAPER ONLY");
    expect(deps.sent.mock.calls[0][0]).toContain("No order is placed");
    const stored = parseAvwapPaperBook(deps.text());
    expect(stored.trades[0]).toMatchObject({ symbol: "SPY", entryAsk: 2.2, contracts: 3, status: "open" });

    deps.bid = 3.3;
    deps.ask = 3.4;
    deps.quoteTime = Date.parse("2026-10-28T13:44:30.000Z");
    deps.source = "tastytrade";
    const second = await runAvwapPaper(new Date("2026-10-28T13:45:00.000Z"), deps.deps);
    expect(second.closed).toBe(1);
    expect(parseAvwapPaperBook(deps.text()).trades[0]).toMatchObject({
      status: "closed",
      exitReason: "target50",
      exitBid: 3.3,
      lastQuoteAt: deps.quoteTime,
      quoteSource: "tastytrade",
      pnlDollars: avwapPnl(2.2, 3.3, 3),
    });
  });

  it("skips the entry when one contract is over $875", async () => {
    const deps = memoryDeps();
    deps.bid = 8.9;
    deps.ask = 9;
    const result = await runAvwapPaper(NOW, deps.deps);
    expect(result.opened).toBe(0);
    expect(deps.sent).not.toHaveBeenCalled();
    expect(parseAvwapPaperBook(deps.text()).notes.SPY).toMatch(/\$875/);
  });
});

function liveQuote(expiration: string, bid: number): AvwapSnapshot {
  return snapshot({
    quotes: [{ expiration, strike: 448, bid, ask: bid + 0.1, source: "tastytrade" }],
  });
}

function retimed(trade: AvwapPaperTrade, openedAt: string, expiration: string): AvwapPaperTrade {
  const at = Date.parse(openedAt);
  return {
    ...trade,
    openedAt: at,
    expiration,
    status: "open",
    closedAt: null,
    exitBid: null,
    exitAsk: null,
    exitReason: null,
    exitNote: null,
    pnlDollars: null,
    rulesVersion: AVWAP_RULES_VERSION,
    whatIfs: trade.whatIfs.map((leg) => ({
      ...leg,
      expiration: leg.status === "skipped" ? leg.expiration : expiration,
      status: leg.status === "skipped" ? "skipped" : "open",
      closedAt: null,
      exitBid: null,
      exitAsk: null,
      exitReason: null,
      exitNote: null,
      pnlDollars: null,
    })),
  };
}

function memoryDeps(daily = vi.fn(async (symbol: string) => (symbol === "SPY" ? gapDays() : [
  bar("2026-10-27T14:00:00.000Z", 100, 101, 99, 100, 10),
  bar("2026-10-28T14:00:00.000Z", 100.4, 101, 100, 100.5, 10),
]))): {
  deps: AvwapPaperDeps;
  text: () => string | null;
  sent: ReturnType<typeof vi.fn>;
  bid: number;
  ask: number;
  quoteTime: number | null;
  source: "tastytrade" | "schwab" | null;
} {
  let text: string | null = null;
  const state: { bid: number; ask: number; quoteTime: number | null; source: "tastytrade" | "schwab" | null } = {
    bid: 2,
    ask: 2.2,
    quoteTime: null,
    source: null,
  };
  const sent = vi.fn(async () => true);
  const deps: AvwapPaperDeps = {
    daily,
    minutes: async (symbol) => (symbol === "SPY" ? signalBars() : []),
    quotes: async (symbols) => {
      const map = new Map<string, { bid: number; ask: number; quoteTime: number | null; source: "tastytrade" | "schwab" | null }>();
      for (let i = 0; i < symbols.length; i++) {
        map.set(normalizeOptionSymbol(symbols[i]), {
          bid: state.bid,
          ask: state.ask,
          quoteTime: state.quoteTime,
          source: state.source,
        });
      }
      return map;
    },
    readBook: async () => text,
    writeBook: async (change) => {
      text = change(text);
      return true;
    },
    send: sent,
  };
  return {
    deps,
    text: () => text,
    sent,
    get bid() { return state.bid; },
    set bid(value: number) { state.bid = value; },
    get ask() { return state.ask; },
    set ask(value: number) { state.ask = value; },
    get quoteTime() { return state.quoteTime; },
    set quoteTime(value: number | null) { state.quoteTime = value; },
    get source() { return state.source; },
    set source(value: "tastytrade" | "schwab" | null) { state.source = value; },
  };
}
