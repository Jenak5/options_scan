import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  AVWAP_BUDGET_DOLLARS,
  AVWAP_DRAWDOWN_FLAG_DOLLARS,
  AVWAP_FEE_PER_SIDE,
  AVWAP_GAP_FRACTION,
  advanceAvwapPaper,
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
  latestGapDay,
  parseAvwapPaperBook,
  quotePlan,
  serializeAvwapPaperBook,
  signalIsFresh,
  timeStopDue,
  type AvwapPaperTrade,
  type AvwapSnapshot,
} from "@/app/lib/avwapPaper";
import { runAvwapPaper, type AvwapPaperDeps } from "@/app/lib/avwapPaperRun";
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
    expect(signal && signalIsFresh(signal, Date.parse("2026-10-28T13:56:00.000Z"))).toBe(false);
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
