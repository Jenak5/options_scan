import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  AVWAP_BUDGET_DOLLARS,
  AVWAP_DRAWDOWN_FLAG_DOLLARS,
  AVWAP_FEE_PER_SIDE,
  AVWAP_GAP_FRACTION,
  AVWAP_PAPER_NOTE,
  AVWAP_SYMBOLS,
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
  isAvwapSymbol,
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
  type AvwapSymbol,
} from "@/app/lib/avwapPaper";
import {
  AVWAP_HISTORY_BUDGET_MS,
  avwapMinuteHistoryInput,
  candleWaves,
  formatAvwapPaperLog,
  loadAvwapDailyBars,
  loadAvwapMinuteBars,
  runAvwapPaper,
  setAvwapHistoryReadersForTests,
  type AvwapPaperDeps,
} from "@/app/lib/avwapPaperRun";
import { CORE_FLOW_WATCHLIST } from "@/app/lib/flow";
import { SCAN_TIME_BUDGET_MS } from "@/app/lib/scanHealth";
import { DEFAULT_MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { equityHistoryKey, type EquityHistoryInput } from "@/app/lib/tastytradeMarket";
import type { PriceCandle } from "@/app/lib/schwabParse";
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
    expect(section.health.symbols.NVDA.reason).toMatch(/no bars/);
    expect(section.health.symbols.AAPL.reason).toMatch(/no bars/);
    expect(section.health.symbols.TSLA.reason).toMatch(/no bars/);
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
    });
    expect(trade.whatIfs.find((leg) => leg.id === "dte14")).toMatchObject({
      expiration: "2026-11-11",
      contracts: 3,
      entryAsk: 2.3,
      status: "open",
    });
    expect(formatAvwapPaperAlert(trade)).toContain("PAPER ONLY");
    expect(formatAvwapPaperAlert(trade)).toContain("No order is placed");

    const hit = advanceAvwapPaper(opened.book, [snapshot({
      quotes: [
        { expiration: "2026-11-04", strike: 448, bid: 3.3, ask: 3.4 },
        { expiration: "2026-11-11", strike: 448, bid: 2.2, ask: 2.4 },
      ],
    })], new Date("2026-10-28T13:45:00.000Z"));
    expect(hit.closed[0]).toMatchObject({
      status: "closed",
      exitReason: "target50",
      exitBid: 3.3,
      exitAsk: 3.4,
      pnlDollars: avwapPnl(2.2, 3.3, 3),
    });
    expect(hit.closed[0].whatIfs.find((leg) => leg.id === "target25-or-3d")).toMatchObject({
      status: "closed",
      exitReason: "target25",
      exitBid: 3.3,
    });
    expect(hit.closed[0].whatIfs.find((leg) => leg.id === "dte14")?.status).toBe("open");
    expect(hit.opened).toHaveLength(0);
  });

  it("closes at the expiry-day final scan, and at 12:55 ET on an early close", () => {
    const opened = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot()], NOW);
    const before = advanceAvwapPaper(opened.book, [snapshot()], new Date("2026-11-04T20:50:00.000Z"));
    expect(before.closed).toHaveLength(0);
    const expiry = advanceAvwapPaper(opened.book, [snapshot({
      quotes: [
        { expiration: "2026-11-04", strike: 448, bid: 2, ask: 2.1 },
        { expiration: "2026-11-11", strike: 448, bid: 2.1, ask: 2.2 },
      ],
    })], new Date("2026-11-04T20:55:00.000Z"));
    expect(expiry.closed[0]).toMatchObject({ exitReason: "expiry", exitBid: 2, pnlDollars: avwapPnl(2.2, 2, 3) });

    const earlyOpen = advanceAvwapPaper(emptyAvwapPaperBook(), [snapshot({
      daily: [
        { date: "2026-11-19", open: 430, close: 440 },
        { date: "2026-11-20", open: 450, close: 448 },
      ],
      bars: [
        bar("2026-11-20T14:30:00.000Z", 449, 451, 449, 450, 1000),
        bar("2026-11-20T14:35:00.000Z", 449, 450, 447, 448, 1000),
      ],
      quotes: [
        { expiration: "2026-11-27", strike: 448, bid: 2, ask: 2.2 },
        { expiration: "2026-12-04", strike: 448, bid: 2.1, ask: 2.3 },
      ],
    })], new Date("2026-11-20T14:40:00.000Z"));
    expect(earlyOpen.opened[0]?.expiration).toBe("2026-11-27");
    const tooSoon = advanceAvwapPaper(earlyOpen.book, [snapshot({
      quotes: [{ expiration: "2026-11-27", strike: 448, bid: 1.5, ask: 1.6 }],
    })], new Date("2026-11-27T17:54:00.000Z"));
    expect(tooSoon.closed).toHaveLength(0);
    const early = advanceAvwapPaper(earlyOpen.book, [snapshot({
      quotes: [{ expiration: "2026-11-27", strike: 448, bid: 1.5, ask: 1.6 }],
    })], new Date("2026-11-27T17:55:00.000Z"));
    expect(early.closed[0]).toMatchObject({ exitReason: "expiry", exitBid: 1.5 });
  });

  it("closes the what-ifs after 3 trading days and leaves the 50% primary open", () => {
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
    expect(parseAvwapPaperBook("{").trades).toEqual([]);
    expect(avwapSessionOpen(new Date("2026-11-26T15:30:00.000Z"))).toBe(false);
    expect(advanceAvwapPaper(opened.book, [snapshot()], new Date("2026-11-26T15:30:00.000Z")).opened).toEqual([]);
    const brief = avwapPaperBrief(opened.book.trades, NOW);
    expect(brief.paperOnly).toBe(true);
    expect(brief.openRows[0]).toMatchObject({ symbol: "SPY", entryAsk: 2.2, entryBid: 2, status: "open" });
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
    const second = await runAvwapPaper(new Date("2026-10-28T13:45:00.000Z"), deps.deps);
    expect(second.closed).toBe(1);
    expect(parseAvwapPaperBook(deps.text()).trades[0]).toMatchObject({
      status: "closed",
      exitReason: "target50",
      exitBid: 3.3,
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

const DRY_NOW = new Date("2026-11-12T14:40:00.000Z");

describe("NVDA, AAPL, and TSLA", () => {
  it("keeps the $875 cap and the 15-name scan budget", () => {
    expect(AVWAP_SYMBOLS).toEqual(["SPY", "IWM", "QQQ", "NVDA", "AAPL", "TSLA"]);
    expect(isAvwapSymbol("NVDA")).toBe(true);
    expect(isAvwapSymbol("AAPL")).toBe(true);
    expect(isAvwapSymbol("TSLA")).toBe(true);
    expect(isAvwapSymbol("AMD")).toBe(false);
    expect(AVWAP_BUDGET_DOLLARS).toBe(875);
    expect(AVWAP_BUDGET_DOLLARS).toBe(DEFAULT_MAX_LOSS_DOLLARS);
    expect(AVWAP_PAPER_NOTE).toContain("NVDA, AAPL, and TSLA");
    expect(AVWAP_PAPER_NOTE).toContain("Paper only");
    expect(CORE_FLOW_WATCHLIST).toHaveLength(15);
    expect(CORE_FLOW_WATCHLIST).toEqual(expect.arrayContaining(["SPY", "QQQ", "IWM", "AAPL", "NVDA", "TSLA"]));
    expect(SCAN_TIME_BUDGET_MS).toBe(240_000);
    expect(AVWAP_HISTORY_BUDGET_MS).toBeLessThan(SCAN_TIME_BUDGET_MS);
    const waves = candleWaves(AVWAP_SYMBOLS.map((symbol) => avwapMinuteHistoryInput(symbol, Date.parse("2026-11-01"), Date.parse("2026-11-12"))));
    expect(waves).toHaveLength(1);
    expect(waves[0].map((input) => input.symbol)).toEqual([...AVWAP_SYMBOLS]);
    const repeated = candleWaves([
      avwapMinuteHistoryInput("TSLA", Date.parse("2026-11-01"), Date.parse("2026-11-08")),
      avwapMinuteHistoryInput("TSLA", Date.parse("2026-11-08"), Date.parse("2026-11-12")),
    ]);
    expect(repeated).toHaveLength(2);
  });

  it("detects a gap and an anchored cross on NVDA, AAPL, and TSLA", () => {
    const now = DRY_NOW.getTime();
    for (const symbol of ["NVDA", "AAPL", "TSLA"] as const) {
      const gap = latestGapDay([
        { date: "2026-11-11", open: 100, close: 100 },
        { date: "2026-11-12", open: 103, close: 101 },
      ]);
      expect(gap?.date).toBe("2026-11-12");
      expect(isGapSession(103, 100)).toBe(true);
      const bars = crossBars(103);
      const signal = latestAvwapCross(bars, "2026-11-12", now);
      expect(signal, symbol).not.toBeNull();
      expect(signal && signal.close < signal.vwap).toBe(true);
      expect(signal && signal.priorClose >= signal.priorVwap).toBe(true);
    }
    expect(latestGapDay([
      { date: "2026-11-11", open: 220, close: 220 },
      { date: "2026-11-12", open: 221.5, close: 222 },
    ])).toBeNull();
  });

  it("dry-runs all six symbols and skips a put over $875 without a spread", () => {
    const snapshots = AVWAP_SYMBOLS.map((symbol) => drySnapshot(symbol));
    const result = advanceAvwapPaper(emptyAvwapPaperBook(), snapshots, DRY_NOW);
    const lines = AVWAP_SYMBOLS.map((symbol) => `${symbol}: ${dryOutcome(result.book.checks[symbol])}`);
    expect(lines).toEqual([
      "SPY: entered",
      "IWM: no signal: anchored at 2026-11-12; no close below the anchored VWAP after a prior close at or above it",
      "QQQ: skipped: one contract costs more than $875",
      "NVDA: entered",
      "AAPL: skipped: no gap of more than 1% in the daily bars",
      "TSLA: skipped: one contract costs more than $875",
    ]);
    const opened = result.opened.map((trade) => trade.symbol).sort();
    expect(opened).toEqual(["NVDA", "SPY"]);
    for (const trade of result.opened) {
      expect(trade.putCall).toBe("put");
      expect(trade.entryAsk * 100).toBeLessThanOrEqual(875);
      expect(formatAvwapPaperAlert(trade)).toContain(trade.symbol);
      expect(formatAvwapPaperAlert(trade)).toContain("PAPER ONLY");
      expect(formatAvwapPaperAlert(trade)).not.toContain("spread");
    }
    expect(result.book.notes.QQQ).toBe("one contract costs more than $875");
    expect(result.book.notes.TSLA).toBe("one contract costs more than $875");
    expect(result.opened.find((trade) => trade.symbol === "TSLA")).toBeUndefined();
    const plan = quotePlan(emptyAvwapPaperBook(), AVWAP_SYMBOLS.map((symbol) => drySnapshot(symbol, "enter")), DRY_NOW);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(100);
    expect(new Set(plan.map((item) => item.symbol))).toEqual(new Set(AVWAP_SYMBOLS));
    expect(plan.every((item) => item.occ.includes("P"))).toBe(true);
  });
});

describe("AVWAP candle batch", () => {
  afterEach(() => {
    setAvwapHistoryReadersForTests(null);
  });

  it("asks DXLink for all six symbols in one session and does not call Schwab", async () => {
    const now = new Date("2026-11-12T15:00:00.000Z");
    const seen: string[][] = [];
    const timeouts: number[] = [];
    setAvwapHistoryReadersForTests({
      source: "tastytrade",
      prefetch: async (inputs, timeoutMs) => {
        seen.push(inputs.map((input) => input.symbol));
        timeouts.push(timeoutMs);
        const map = new Map<string, PriceCandle[]>();
        for (let i = 0; i < inputs.length; i++) {
          map.set(equityHistoryKey(inputs[i]), coveringCandles(inputs[i].frequencyType === "daily"));
        }
        return map;
      },
      router: async () => {
        throw new Error("router backup ran");
      },
      schwab: async () => {
        throw new Error("Schwab ran as primary");
      },
    });
    const daily = await Promise.all(AVWAP_SYMBOLS.map((symbol) => loadAvwapDailyBars(symbol, now)));
    expect(daily.every((bars) => bars.length > 0)).toBe(true);
    expect(seen).toEqual([[...AVWAP_SYMBOLS]]);
    expect(timeouts).toEqual([15_000]);
    seen.length = 0;
    timeouts.length = 0;
    const minutes = await Promise.all(AVWAP_SYMBOLS.map((symbol) => loadAvwapMinuteBars(symbol, now, "2026-09-17")));
    expect(minutes.every((bars) => bars.length > 0)).toBe(true);
    const chunks = minuteHistoryChunks("2026-09-17", now.getTime());
    expect(chunks.length).toBeGreaterThan(1);
    expect(seen).toHaveLength(chunks.length);
    expect(seen.every((batch) => batch.join(",") === AVWAP_SYMBOLS.join(","))).toBe(true);
    expect(timeouts.every((ms) => ms === 15_000)).toBe(true);
  });

  it("uses Schwab chunks only after Tastytrade misses, and keeps each chunk inside 8 days", async () => {
    const now = new Date("2026-11-12T15:00:00.000Z");
    const routerInputs: EquityHistoryInput[] = [];
    const schwabInputs: EquityHistoryInput[] = [];
    setAvwapHistoryReadersForTests({
      source: "tastytrade",
      prefetch: async () => new Map(),
      router: async (input) => {
        routerInputs.push(input);
        return [candleAt("2026-11-12T14:30:00.000Z")];
      },
      schwab: async (input) => {
        schwabInputs.push(input);
        return [candleAt("2026-11-12T14:30:00.000Z")];
      },
      schwabReady: async () => true,
    });
    const bars = await loadAvwapMinuteBars("TSLA", now, "2026-11-10");
    expect(bars.length).toBeGreaterThan(0);
    expect(schwabInputs).toEqual([]);
    expect(routerInputs.length).toBeGreaterThan(0);
    expect(routerInputs.every((input) => input.symbol === "TSLA")).toBe(true);
    expect(routerInputs.every((input) => (input.endDate ?? 0) - (input.startDate ?? 0) <= 8 * 24 * 60 * 60 * 1000)).toBe(true);

    routerInputs.length = 0;
    setAvwapHistoryReadersForTests({
      source: "tastytrade",
      prefetch: async () => {
        throw new Error("DXLink down");
      },
      router: async (input) => {
        routerInputs.push(input);
        return [];
      },
      schwab: async (input) => {
        schwabInputs.push(input);
        return [candleAt("2026-11-12T14:30:00.000Z")];
      },
      schwabReady: async () => true,
    });
    const backedUp = await loadAvwapMinuteBars("QQQ", now, "2026-11-10");
    expect(backedUp.length).toBeGreaterThan(0);
    expect(routerInputs).toEqual([]);
    expect(schwabInputs.length).toBeGreaterThan(0);
    expect(schwabInputs.every((input) => input.symbol === "QQQ")).toBe(true);
    expect(schwabInputs.every((input) => (input.endDate ?? 0) - (input.startDate ?? 0) <= 8 * 24 * 60 * 60 * 1000)).toBe(true);
  });
});

function drySnapshot(symbol: AvwapSymbol, force?: "enter"): AvwapSnapshot {
  const spec = DRY[symbol];
  const mode = force ?? spec.mode;
  const open = mode === "nogap" ? spec.nogapOpen : spec.open;
  const bars = mode === "flat" ? flatBars(open) : crossBars(open);
  const strike = atmStrike(bars[bars.length - 1].c) ?? 1;
  const ask = mode === "enter" ? spec.ask : 2.2;
  return {
    symbol,
    daily: [
      { date: "2026-11-11", open: spec.prev, close: spec.prev },
      { date: "2026-11-12", open, close: open },
    ],
    bars,
    quotes: [{ expiration: "2026-11-19", strike, bid: Math.max(0.05, ask - 0.1), ask }],
  };
}

const DRY: Record<AvwapSymbol, { prev: number; open: number; nogapOpen: number; ask: number; mode: "enter" | "flat" | "nogap" }> = {
  SPY: { prev: 500, open: 510, nogapOpen: 502, ask: 2.2, mode: "enter" },
  IWM: { prev: 200, open: 204, nogapOpen: 201, ask: 2.2, mode: "flat" },
  QQQ: { prev: 400, open: 408, nogapOpen: 402, ask: 9, mode: "enter" },
  NVDA: { prev: 140, open: 145, nogapOpen: 141, ask: 3.5, mode: "enter" },
  AAPL: { prev: 220, open: 226, nogapOpen: 221.5, ask: 2.2, mode: "nogap" },
  TSLA: { prev: 250, open: 260, nogapOpen: 251, ask: 12.5, mode: "enter" },
};

function dryOutcome(check: { entered: boolean; reason: string } | undefined): string {
  if (!check) return "skipped: not checked";
  if (check.entered) return "entered";
  if (check.reason.includes("no close below")) return `no signal: ${check.reason}`;
  return `skipped: ${check.reason}`;
}

function crossBars(open: number): CandleBar[] {
  return [
    bar("2026-11-12T14:30:00.000Z", open, open, open, open, 1000),
    bar("2026-11-12T14:35:00.000Z", open, open, open - 3, open - 2, 1000),
  ];
}

function flatBars(open: number): CandleBar[] {
  return [
    bar("2026-11-12T14:30:00.000Z", open, open + 1, open, open + 0.6, 1000),
    bar("2026-11-12T14:35:00.000Z", open + 0.6, open + 1.4, open + 0.5, open + 1, 1000),
  ];
}

function candleAt(iso: string): PriceCandle {
  return { datetime: Date.parse(iso), open: 10, high: 11, low: 9, close: 10, volume: 100 };
}

function coveringCandles(daily: boolean): PriceCandle[] {
  if (daily) return [candleAt("2026-11-11T14:00:00.000Z"), candleAt("2026-11-12T14:00:00.000Z")];
  return [candleAt("2026-09-17T14:30:00.000Z"), candleAt("2026-11-12T14:55:00.000Z")];
}

function memoryDeps(daily = vi.fn(async (symbol: string) => (symbol === "SPY" ? gapDays() : [
  bar("2026-10-27T14:00:00.000Z", 100, 101, 99, 100, 10),
  bar("2026-10-28T14:00:00.000Z", 100.4, 101, 100, 100.5, 10),
]))): { deps: AvwapPaperDeps; text: () => string | null; sent: ReturnType<typeof vi.fn>; bid: number; ask: number } {
  let text: string | null = null;
  const state = { bid: 2, ask: 2.2 };
  const sent = vi.fn(async () => true);
  const deps: AvwapPaperDeps = {
    daily,
    minutes: async (symbol) => (symbol === "SPY" ? signalBars() : []),
    quotes: async (symbols) => {
      const map = new Map<string, { bid: number; ask: number }>();
      for (let i = 0; i < symbols.length; i++) map.set(normalizeOptionSymbol(symbols[i]), { bid: state.bid, ask: state.ask });
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
  };
}
