import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import { buildMarketBrief } from "@/app/lib/brief";
import {
  CALLS_BUDGET_DOLLARS,
  CALLS_DRAWDOWN_FLAG_DOLLARS,
  CALLS_FEE_PER_SIDE,
  CALLS_FLUSH_FRACTION,
  advanceCallsPaper,
  callsContractCount,
  callsDailyStop,
  callsDrawdown,
  callsPaperBrief,
  callsPaperHealth,
  callsQuotePlan,
  callsSessionOpen,
  callsSpreadCount,
  deltaNearTarget,
  emptyCallsPaperBook,
  emptyCallsPaperHealth,
  formatCallsPaperAlert,
  longCallPnl,
  parseCallsPaperBook,
  quoteSpreadTooWide,
  reclaimedPriorClose,
  scanFlushReclaim,
  selectBullCallSpread,
  selectLongCall,
  serializeCallsPaperBook,
  sessionLevels,
  signalIsFresh,
  spreadPnl,
  tradedBelowOpen,
  type CallsContractQuote,
  type CallsPaperTrade,
  type CallsSnapshot,
} from "@/app/lib/callsPaper";
import { CALLS_MARKET_DATA_PATHS, runCallsPaper, type CallsPaperDeps } from "@/app/lib/callsPaperRun";
import { buildHealthReport } from "@/app/lib/healthReport";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { clearMemoryStoreForTests, readCallsPaperBookText, resolveStoreKind, updateCallsPaperBook } from "@/app/lib/schwabStore";

const NOW = new Date("2026-10-28T13:45:00.000Z");
const EXP = "2026-11-02";

function bar(iso: string, o: number, h: number, l: number, c: number, v?: number): CandleBar {
  return { t: Date.parse(iso), o, h, l, c, v };
}

function daily() {
  return [
    { date: "2026-10-27", open: 98, close: 99 },
    { date: "2026-10-28", open: 100, close: 100 },
  ];
}

function signalBars(): CandleBar[] {
  return [
    bar("2026-10-28T13:30:00.000Z", 100, 100.2, 99.4, 98.8, 1000),
    bar("2026-10-28T13:40:00.000Z", 98.8, 99.3, 98.7, 99.1, 1000),
  ];
}

function ladder(over: Partial<CallsContractQuote> & { strike: number } = { strike: 97 }): CallsContractQuote[] {
  const rows: CallsContractQuote[] = [
    { expiration: EXP, strike: 97, bid: 2, ask: 2.2, delta: 0.3 },
    { expiration: EXP, strike: 99, bid: 3.8, ask: 4, delta: 0.55 },
    { expiration: EXP, strike: 100, bid: 1, ask: 1.1, delta: 0.12 },
    { expiration: EXP, strike: 101, bid: 1, ask: 1.1, delta: 0.12 },
    { expiration: EXP, strike: 102, bid: 1, ask: 1.1, delta: 0.12 },
    { expiration: EXP, strike: 103, bid: 1, ask: 1.1, delta: 0.12 },
    { expiration: EXP, strike: 104, bid: 0.4, ask: 0.5, delta: 0.08 },
  ];
  return rows.map((row) => (row.strike === over.strike ? { ...row, ...over } : row));
}

function snapshot(over: Partial<CallsSnapshot> = {}): CallsSnapshot {
  return {
    symbol: "SPY",
    daily: daily(),
    bars: signalBars(),
    quotes: ladder(),
    chainProblem: null,
    ...over,
  };
}

function closedTrade(setup: "A" | "S", id: string, closedAt: string, pnl: number, symbol: CallsPaperTrade["symbol"] = "IWM"): CallsPaperTrade {
  const at = Date.parse(closedAt);
  const long = {
    side: "long" as const,
    strike: 100,
    expiration: EXP,
    delta: 0.3,
    entryBid: 2,
    entryAsk: 2.2,
    exitBid: 1,
    exitAsk: 1.1,
    lastBid: 1,
    lastAsk: 1.1,
  };
  const short = {
    side: "short" as const,
    strike: 105,
    expiration: EXP,
    delta: 0.1,
    entryBid: 0.4,
    entryAsk: 0.5,
    exitBid: 0.3,
    exitAsk: 0.4,
    lastBid: 0.3,
    lastAsk: 0.4,
  };
  return {
    id,
    setup,
    symbol,
    openedAt: at - 60_000,
    signalAt: at - 300_000,
    signalDay: "2026-10-28",
    sessionOpen: 100,
    priorClose: 99,
    flushLow: 99.4,
    signalClose: 99.1,
    spot: 99.1,
    expiration: EXP,
    dte: 5,
    contracts: 1,
    entryDebit: setup === "A" ? 2.2 : 1.8,
    legs: setup === "A" ? [long] : [long, short],
    status: "closed",
    closedAt: at,
    exitReason: "nextDay",
    exitNote: null,
    pnlDollars: pnl,
    lastQuoteAt: at,
  } as CallsPaperTrade;
}

describe("flush then reclaim", () => {
  it("fires on the first 5-minute close above the prior close after a 0.5% flush", () => {
    expect(CALLS_FLUSH_FRACTION).toBe(0.005);
    expect(tradedBelowOpen(99.5, 100)).toBe(true);
    expect(tradedBelowOpen(99.51, 100)).toBe(false);
    expect(reclaimedPriorClose(99, 99)).toBe(false);
    expect(reclaimedPriorClose(99.01, 99)).toBe(true);

    const scan = scanFlushReclaim(signalBars(), 100, 99, "2026-10-28", NOW.getTime());
    expect(scan.flushed).toBe(true);
    expect(scan.reclaimOutsideWindow).toBe(false);
    expect(scan.signal).toMatchObject({
      at: Date.parse("2026-10-28T13:40:00.000Z"),
      close: 99.1,
      flushLow: 99.4,
      sessionOpen: 100,
      priorClose: 99,
    });
    expect(scan.signal && signalIsFresh(scan.signal, NOW.getTime())).toBe(true);
    expect(scan.signal && signalIsFresh(scan.signal, Date.parse("2026-10-28T13:56:00.000Z"))).toBe(false);
  });

  it("keeps the first reclaim and ignores a later one", () => {
    const bars = [
      ...signalBars(),
      bar("2026-10-28T13:45:00.000Z", 99.1, 99.4, 98.5, 99.3, 1000),
    ];
    const scan = scanFlushReclaim(bars, 100, 99, "2026-10-28", Date.parse("2026-10-28T13:50:00.000Z"));
    expect(scan.signal?.at).toBe(Date.parse("2026-10-28T13:40:00.000Z"));
  });

  it("does not take a reclaim that finishes before 9:45 ET, even if a later close is higher", () => {
    const bars = [
      bar("2026-10-28T13:30:00.000Z", 100, 100.2, 99.4, 99.2, 1000),
      bar("2026-10-28T13:40:00.000Z", 99.2, 100, 99, 99.8, 1000),
    ];
    const scan = scanFlushReclaim(bars, 100, 99, "2026-10-28", Date.parse("2026-10-28T13:50:00.000Z"));
    expect(scan.reclaimOutsideWindow).toBe(true);
    expect(scan.signal).toBeNull();
  });

  it("counts a same-bar flush and reclaim inside the check window", () => {
    const bars = [bar("2026-10-28T13:40:00.000Z", 100, 100.2, 99.4, 99.2, 1000)];
    const scan = scanFlushReclaim(bars, 100, 99, "2026-10-28", NOW.getTime());
    expect(scan.signal).toMatchObject({ at: Date.parse("2026-10-28T13:40:00.000Z"), flushLow: 99.4, close: 99.2 });
  });

  it("leaves a premarket flush out and uses the daily open, not the first bar open", () => {
    const bars = [
      bar("2026-10-28T12:00:00.000Z", 100, 100, 98, 99, 1000),
      bar("2026-10-28T13:40:00.000Z", 101, 101, 99.6, 99.8, 1000),
    ];
    expect(scanFlushReclaim(bars, 100, 99, "2026-10-28", NOW.getTime()).flushed).toBe(false);
    expect(sessionLevels([{ date: "2026-10-27", open: 98, close: 99 }], bars, "2026-10-28", NOW.getTime())).toEqual({
      open: 101,
      priorClose: 99,
    });
    expect(sessionLevels(daily(), bars, "2026-10-28", NOW.getTime())?.open).toBe(100);
  });

  it("accepts the 3:25 PM ET check and rejects 3:30, and stops at 12:25 on an early close", () => {
    const late = [
      bar("2026-10-28T13:30:00.000Z", 100, 100, 99.4, 98.8, 10),
      bar("2026-10-28T19:20:00.000Z", 98.8, 99.4, 98.8, 99.2, 10),
    ];
    expect(scanFlushReclaim(late, 100, 99, "2026-10-28", Date.parse("2026-10-28T19:25:00.000Z")).signal?.at)
      .toBe(Date.parse("2026-10-28T19:20:00.000Z"));
    const tooLate = [
      bar("2026-10-28T13:30:00.000Z", 100, 100, 99.4, 98.8, 10),
      bar("2026-10-28T19:25:00.000Z", 98.8, 99.4, 98.8, 99.2, 10),
    ];
    expect(scanFlushReclaim(tooLate, 100, 99, "2026-10-28", Date.parse("2026-10-28T19:30:00.000Z")).reclaimOutsideWindow).toBe(true);

    const early = [
      bar("2026-11-27T14:30:00.000Z", 100, 100, 99.4, 98.8, 10),
      bar("2026-11-27T17:20:00.000Z", 98.8, 99.4, 98.8, 99.2, 10),
    ];
    expect(scanFlushReclaim(early, 100, 99, "2026-11-27", Date.parse("2026-11-27T17:25:00.000Z")).signal?.at)
      .toBe(Date.parse("2026-11-27T17:20:00.000Z"));
    const afterEarly = [
      bar("2026-11-27T14:30:00.000Z", 100, 100, 99.4, 98.8, 10),
      bar("2026-11-27T17:25:00.000Z", 98.8, 99.4, 98.8, 99.2, 10),
    ];
    expect(scanFlushReclaim(afterEarly, 100, 99, "2026-11-27", Date.parse("2026-11-27T17:30:00.000Z")).signal).toBeNull();
  });
});

describe("size, delta, and spread strikes", () => {
  it("buys whole contracts and whole spreads inside $875", () => {
    expect(CALLS_BUDGET_DOLLARS).toBe(875);
    expect(CALLS_FEE_PER_SIDE).toBe(0.65);
    expect(callsContractCount(4)).toBe(2);
    expect(callsContractCount(8.75)).toBe(1);
    expect(callsContractCount(8.76)).toBe(0);
    expect(callsContractCount(2.2)).toBe(3);
    expect(callsSpreadCount(3, 1)).toBe(4);
    expect(callsSpreadCount(10, 1)).toBe(0);
    expect(callsSpreadCount(1, 1.2)).toBeNull();
    expect(longCallPnl(2.2, 4.4, 3)).toBeCloseTo(660 - CALLS_FEE_PER_SIDE * 2 * 3, 2);
    expect(spreadPnl(1.5, 1.3, 5)).toBeCloseTo(-100 - CALLS_FEE_PER_SIDE * 4 * 5, 2);
  });

  it("keeps a 25% bid/ask and skips a wider one, and stays inside the 0.30 delta band", () => {
    expect(quoteSpreadTooWide(0.75, 1)).toBe(false);
    expect(quoteSpreadTooWide(0.74, 1)).toBe(true);
    expect(deltaNearTarget(0.2)).toBe(true);
    expect(deltaNearTarget(0.4)).toBe(true);
    expect(deltaNearTarget(0.19)).toBe(false);
    expect(deltaNearTarget(0.41)).toBe(false);
    expect(deltaNearTarget(0.55)).toBe(false);

    const pick = selectLongCall(ladder(), "2026-10-28");
    expect(pick.reason).toBe("ok");
    expect(pick.quote).toMatchObject({ strike: 97, delta: 0.3, expiration: EXP });
    expect(pick.contracts).toBe(3);

    const wide = selectLongCall(ladder({ strike: 97, bid: 1, ask: 2, delta: 0.3 }), "2026-10-28");
    expect(wide.reason).toMatch(/wider than 25%/);
    const expensive = selectLongCall(ladder({ strike: 97, bid: 8.8, ask: 9, delta: 0.3 }), "2026-10-28");
    expect(expensive.reason).toMatch(/\$875/);
    expect(expensive.contracts).toBe(0);

    const fridayAsk = { expiration: "2026-10-30", strike: 97, bid: 8.8, ask: 9, delta: 0.3 };
    const thursday = { expiration: "2026-10-29", strike: 96, bid: 1.9, ask: 2, delta: 0.31 };
    expect(selectLongCall([fridayAsk, thursday], "2026-10-26").reason).toMatch(/\$875/);
    expect(selectLongCall([thursday], "2026-10-26").quote?.expiration).toBe("2026-10-29");
  });

  it("sells the call five listed strikes above the money and skips Thanksgiving", () => {
    const spread = selectBullCallSpread(ladder(), "2026-10-28", 99.1);
    expect(spread.reason).toBe("ok");
    expect(spread.long?.strike).toBe(99);
    expect(spread.short?.strike).toBe(104);
    expect(spread.contracts).toBe(2);
    expect(spread.debit).toBeCloseTo(3.6, 8);

    const gapped = selectBullCallSpread([
      { expiration: EXP, strike: 99, bid: 3.8, ask: 4, delta: 0.5 },
      { expiration: EXP, strike: 100, bid: 3, ask: 3.2, delta: 0.45 },
      { expiration: EXP, strike: 102, bid: 2, ask: 2.2, delta: 0.4 },
      { expiration: EXP, strike: 103, bid: 1.5, ask: 1.6, delta: 0.35 },
      { expiration: EXP, strike: 104, bid: 1, ask: 1.1, delta: 0.3 },
      { expiration: EXP, strike: 105, bid: 0.6, ask: 0.7, delta: 0.2 },
      { expiration: EXP, strike: 106, bid: 0.4, ask: 0.5, delta: 0.15 },
    ], "2026-10-28", 99.1);
    expect(gapped.long?.strike).toBe(99);
    expect(gapped.short?.strike).toBe(105);

    const holiday = selectLongCall([
      { expiration: "2026-11-26", strike: 97, bid: 2, ask: 2.2, delta: 0.3 },
      { expiration: "2026-11-27", strike: 98, bid: 2, ask: 2.1, delta: 0.29 },
    ], "2026-11-23");
    expect(holiday.quote).toMatchObject({ expiration: "2026-11-27", strike: 98 });
  });
});

describe("entries and exits", () => {
  it("opens one long call and one bull call spread on the fresh signal", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
    expect(opened.opened.map((trade) => trade.setup).sort()).toEqual(["A", "S"]);
    const call = opened.opened.find((trade) => trade.setup === "A");
    const spread = opened.opened.find((trade) => trade.setup === "S");
    expect(call).toMatchObject({
      symbol: "SPY",
      contracts: 3,
      expiration: EXP,
      dte: 5,
      entryDebit: 2.2,
      status: "open",
      signalDay: "2026-10-28",
    });
    expect(call?.legs[0]).toMatchObject({ side: "long", strike: 97, entryAsk: 2.2, entryBid: 2, delta: 0.3 });
    expect(spread).toMatchObject({ contracts: 2, entryDebit: 3.6, status: "open" });
    expect(spread?.legs.map((leg) => leg.strike)).toEqual([99, 104]);
    expect(formatCallsPaperAlert(call!)).toContain("PAPER ONLY");
    expect(formatCallsPaperAlert(call!)).toContain("No order is placed");
    expect(formatCallsPaperAlert(spread!)).toContain("BULL CALL SPREAD");
    expect(formatCallsPaperAlert(spread!)).toContain("PAPER ONLY");
    expect(opened.book.updatedAt).toBe(NOW.getTime());
    expect(callsPaperHealth(opened.book, NOW).lastCheckAt).toBe(NOW.toISOString());
  });

  it("sells the long call at the bid on +100% and leaves a bid just under it open", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
    const under = advanceCallsPaper(opened.book, [snapshot({
      quotes: ladder({ strike: 97, bid: 4.39, ask: 4.5, delta: 0.3 }),
    })], new Date("2026-10-28T14:00:00.000Z"));
    expect(under.closed).toHaveLength(0);
    expect(under.book.trades.find((trade) => trade.setup === "A")?.status).toBe("open");

    const hit = advanceCallsPaper(opened.book, [snapshot({
      quotes: ladder({ strike: 97, bid: 4.4, ask: 4.5, delta: 0.3 }),
    })], new Date("2026-10-28T14:00:00.000Z"));
    const closed = hit.closed.find((trade) => trade.setup === "A");
    expect(closed).toMatchObject({
      status: "closed",
      exitReason: "target100",
      pnlDollars: longCallPnl(2.2, 4.4, 3),
    });
    expect(closed?.legs[0]).toMatchObject({ exitBid: 4.4, exitAsk: 4.5 });
    expect(hit.book.trades.find((trade) => trade.setup === "S")?.status).toBe("open");
    expect(hit.opened).toHaveLength(0);
  });

  it("closes the spread at +25% of the debit and at -50% of the debit", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
    const spread = opened.opened.find((trade) => trade.setup === "S");
    if (!spread) throw new Error("expected a spread");
    const targetBid = spread.entryDebit * 1.25 + 0.5;
    const hit = advanceCallsPaper(opened.book, [snapshot({
      quotes: ladder({ strike: 99, bid: targetBid, ask: targetBid + 0.1, delta: 0.55 }),
    })], new Date("2026-10-28T14:00:00.000Z"));
    expect(hit.closed.find((trade) => trade.setup === "S")).toMatchObject({
      exitReason: "target25",
      pnlDollars: spreadPnl(spread.entryDebit, targetBid - 0.5, spread.contracts),
    });

    const stopBid = spread.entryDebit * 0.5 + 0.5;
    const stopped = advanceCallsPaper(opened.book, [snapshot({
      quotes: ladder({ strike: 99, bid: stopBid, ask: stopBid + 0.1, delta: 0.55 }),
    })], new Date("2026-10-28T14:00:00.000Z"));
    const stop = stopped.closed.find((trade) => trade.setup === "S");
    expect(stop?.exitReason).toBe("stop50");
    expect(stop?.legs.find((leg) => leg.side === "long")?.exitBid).toBeCloseTo(stopBid, 8);
    expect(stop?.legs.find((leg) => leg.side === "short")?.exitAsk).toBe(0.5);
  });

  it("holds to the next trading day's final scan and uses the early close after Thanksgiving", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
    const before = advanceCallsPaper(opened.book, [snapshot()], new Date("2026-10-29T19:50:00.000Z"));
    expect(before.closed).toHaveLength(0);
    const due = advanceCallsPaper(opened.book, [snapshot()], new Date("2026-10-29T19:55:00.000Z"));
    expect(due.closed.map((trade) => trade.exitReason).sort()).toEqual(["nextDay", "nextDay"]);
    expect(due.closed.find((trade) => trade.setup === "A")?.pnlDollars).toBe(longCallPnl(2.2, 2, 3));

    const missing = advanceCallsPaper(opened.book, [snapshot({ quotes: [] })], new Date("2026-10-29T19:55:00.000Z"));
    expect(missing.closed).toHaveLength(0);
    const later = advanceCallsPaper(missing.book, [snapshot()], new Date("2026-10-30T14:00:00.000Z"));
    expect(later.closed).toHaveLength(2);

    const wednesday = advanceCallsPaper(emptyCallsPaperBook(), [snapshot({
      daily: [
        { date: "2026-11-24", open: 98, close: 99 },
        { date: "2026-11-25", open: 100, close: 100 },
      ],
      bars: [
        bar("2026-11-25T14:30:00.000Z", 100, 100.2, 99.4, 98.8, 1000),
        bar("2026-11-25T14:40:00.000Z", 98.8, 99.3, 98.7, 99.1, 1000),
      ],
      quotes: ladder().map((quote) => ({ ...quote, expiration: "2026-11-30" })),
    })], new Date("2026-11-25T14:45:00.000Z"));
    expect(wednesday.opened).toHaveLength(2);
    expect(wednesday.opened[0]?.expiration).toBe("2026-11-30");
    const holiday = advanceCallsPaper(wednesday.book, [snapshot()], new Date("2026-11-26T17:55:00.000Z"));
    expect(holiday.closed).toHaveLength(0);
    expect(holiday.book.updatedAt).toBe(wednesday.book.updatedAt);
    const tooSoon = advanceCallsPaper(wednesday.book, [snapshot({
      quotes: ladder().map((quote) => ({ ...quote, expiration: "2026-11-30" })),
    })], new Date("2026-11-27T17:54:00.000Z"));
    expect(tooSoon.closed).toHaveLength(0);
    const early = advanceCallsPaper(wednesday.book, [snapshot({
      quotes: ladder().map((quote) => ({ ...quote, expiration: "2026-11-30" })),
    })], new Date("2026-11-27T17:55:00.000Z"));
    expect(early.closed).toHaveLength(2);
    expect(early.closed.every((trade) => trade.exitReason === "nextDay")).toBe(true);
  });

  it("stops one setup after two losing closes and flags a $1,500 drawdown for that setup only", () => {
    const book = {
      ...emptyCallsPaperBook(),
      trades: [
        closedTrade("A", "a1", "2026-10-28T13:10:00.000Z", -10),
        closedTrade("A", "a2", "2026-10-28T13:20:00.000Z", -12),
      ],
    };
    expect(callsDailyStop(book.trades, "A", NOW)).toMatchObject({ dailyStop: true, consecutiveLosses: 2 });
    expect(callsDailyStop(book.trades, "S", NOW).dailyStop).toBe(false);
    const blocked = advanceCallsPaper(book, [snapshot()], NOW);
    expect(blocked.opened.map((trade) => trade.setup)).toEqual(["S"]);
    expect(blocked.book.notes.SPY).toMatch(/A: daily stop/);

    const cleared = {
      ...book,
      trades: [
        closedTrade("A", "a1", "2026-10-28T13:10:00.000Z", -10),
        closedTrade("A", "a2", "2026-10-28T13:20:00.000Z", -12),
        closedTrade("A", "a3", "2026-10-28T13:25:00.000Z", 5),
      ],
    };
    expect(callsDailyStop(cleared.trades, "A", NOW).dailyStop).toBe(true);
    expect(advanceCallsPaper(cleared, [snapshot()], NOW).opened.map((trade) => trade.setup)).toEqual(["S"]);

    expect(callsDrawdown([closedTrade("A", "a", "2026-10-28T15:00:00.000Z", -1500)], "A").flagged).toBe(false);
    expect(callsDrawdown([closedTrade("A", "a", "2026-10-28T15:00:00.000Z", -1500.01)], "A").flagged).toBe(true);
    expect(callsDrawdown([closedTrade("A", "a", "2026-10-28T15:00:00.000Z", -1500.01)], "S").flagged).toBe(false);
    expect(CALLS_DRAWDOWN_FLAG_DOLLARS).toBe(1500);
    const deep = callsDrawdown([
      closedTrade("S", "a", "2026-10-01T15:00:00.000Z", 100),
      closedTrade("S", "b", "2026-10-02T15:00:00.000Z", -800),
      closedTrade("S", "c", "2026-10-05T15:00:00.000Z", -900),
    ], "S");
    expect(deep.maxDrawdownDollars).toBeGreaterThan(1500);
    expect(deep.flagged).toBe(true);
  });

  it("keeps one open position per setup and one signal per symbol per day", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
    const again = advanceCallsPaper(opened.book, [snapshot()], new Date("2026-10-28T13:50:00.000Z"));
    expect(again.opened).toHaveLength(0);
    expect(again.book.notes.SPY).toMatch(/already open/);

    const closed = advanceCallsPaper(opened.book, [snapshot({
      quotes: ladder({ strike: 97, bid: 4.4, ask: 4.5, delta: 0.3 }),
    })], new Date("2026-10-28T13:50:00.000Z"));
    const later = advanceCallsPaper(closed.book, [snapshot()], new Date("2026-10-28T13:50:00.000Z"));
    expect(later.opened.filter((trade) => trade.setup === "A")).toHaveLength(0);
    expect(later.book.notes.SPY).toMatch(/already papered/);

    const stale = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], new Date("2026-10-28T14:30:00.000Z"));
    expect(stale.opened).toHaveLength(0);
    expect(stale.book.notes.SPY).toMatch(/older than this scan/);
  });

  it("skips a wide long call without blocking the spread, and round-trips the book", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot({
      quotes: ladder({ strike: 97, bid: 1, ask: 2, delta: 0.3 }),
    })], NOW);
    expect(opened.opened.map((trade) => trade.setup)).toEqual(["S"]);
    expect(opened.book.notes.SPY).toMatch(/wider than 25%/);

    const parsed = parseCallsPaperBook(serializeCallsPaperBook(opened.book));
    expect(parsed.trades[0]?.entryDebit).toBe(3.6);
    expect(parseCallsPaperBook("{").trades).toEqual([]);
    expect(callsSessionOpen(new Date("2026-11-26T15:30:00.000Z"))).toBe(false);
    expect(advanceCallsPaper(opened.book, [snapshot()], new Date("2026-11-26T15:30:00.000Z")).opened).toEqual([]);
    const brief = callsPaperBrief(opened.book, NOW);
    expect(brief.paperOnly).toBe(true);
    expect(brief.lastCheckAt).toBe(NOW.toISOString());
    expect(brief.openRows[0]).toMatchObject({ setup: "S", symbol: "SPY", status: "open" });
    const plan = callsQuotePlan(emptyCallsPaperBook(), [snapshot()], NOW);
    expect(plan.chainSymbols).toEqual(["SPY"]);
    expect(plan.marks).toEqual([]);
    const marked = callsQuotePlan(opened.book, [snapshot()], new Date("2026-10-28T14:00:00.000Z"));
    expect(marked.chainSymbols).toEqual([]);
    expect(marked.marks.length).toBeGreaterThan(0);
    expect(marked.marks.every((item) => item.occ.includes("C"))).toBe(true);
    expect(callsQuotePlan(emptyCallsPaperBook(), [snapshot()], new Date("2026-11-26T15:30:00.000Z"))).toEqual({
      chainSymbols: [],
      marks: [],
    });
  });

  it("does not paper a delayed chain", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot({ chainProblem: "delayed", quotes: [] })], NOW);
    expect(opened.opened).toHaveLength(0);
    expect(opened.book.notes.SPY).toMatch(/delayed/);
  });

  it("does not exit a spread when one leg has no quote", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
    const partial = advanceCallsPaper(opened.book, [snapshot({
      quotes: [{ expiration: EXP, strike: 99, bid: 1, ask: 1.1, delta: 0.55 }],
    })], new Date("2026-10-29T19:55:00.000Z"));
    expect(partial.book.trades.find((trade) => trade.setup === "S")?.status).toBe("open");
    expect(partial.book.trades.find((trade) => trade.setup === "A")?.status).toBe("open");
  });
});

describe("calls paper scan", () => {
  afterEach(() => {
    clearMemoryStoreForTests();
    vi.restoreAllMocks();
  });

  it("does not read the market on a NYSE holiday", async () => {
    const dailyBars = vi.fn(async () => []);
    const chain = vi.fn(async (_symbol: string, _now: Date) => ({
      quotes: [] as CallsContractQuote[],
      problem: null as "delayed" | "unavailable" | null,
    }));
    const deps = memoryDeps(dailyBars, chain);
    const holiday = await runCallsPaper(new Date("2026-11-26T15:30:00.000Z"), deps.deps);
    expect(holiday.skipped).toBe("holiday");
    expect(dailyBars).not.toHaveBeenCalled();
    expect(chain).not.toHaveBeenCalled();
    expect(deps.sent).not.toHaveBeenCalled();
  });

  it("records both paper setups from price history and a call chain, then exits on the quotes", async () => {
    const deps = memoryDeps();
    const first = await runCallsPaper(NOW, deps.deps);
    expect(first.opened).toBe(2);
    expect(first.openedA).toBe(1);
    expect(first.openedS).toBe(1);
    expect(first.saved).toBe(true);
    expect(deps.chain).toHaveBeenCalledTimes(1);
    expect(deps.chain).toHaveBeenCalledWith("SPY", NOW);
    expect(deps.quotes).not.toHaveBeenCalled();
    expect(deps.sent).toHaveBeenCalledTimes(2);
    expect(deps.sent.mock.calls[0][0]).toContain("PAPER ONLY");
    expect(deps.sent.mock.calls[0][0]).toContain("No order is placed");
    expect(deps.sent.mock.calls[1][0]).toContain("PAPER ONLY");

    const second = await runCallsPaper(new Date("2026-10-28T14:00:00.000Z"), deps.deps);
    expect(second.closed).toBe(2);
    const stored = parseCallsPaperBook(deps.text());
    expect(stored.trades.find((trade) => trade.setup === "A")).toMatchObject({
      status: "closed",
      exitReason: "target100",
      pnlDollars: longCallPnl(2.2, 4.4, 3),
    });
    const spread = stored.trades.find((trade) => trade.setup === "S");
    expect(spread?.exitReason).toBe("target25");
    expect(spread?.legs.find((leg) => leg.side === "short")?.exitAsk).toBe(0.5);
  });

  it("skips the long call when one contract is over $875", async () => {
    const deps = memoryDeps();
    deps.longAsk = 9;
    deps.longBid = 8.8;
    const result = await runCallsPaper(NOW, deps.deps);
    expect(result.openedA).toBe(0);
    expect(result.openedS).toBe(1);
    expect(parseCallsPaperBook(deps.text()).notes.SPY).toMatch(/\$875/);
  });

  it("persists the paper log in the memory store", async () => {
    const keys = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "BLOB_READ_WRITE_TOKEN", "VERCEL"];
    const saved: Record<string, string | undefined> = {};
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      clearMemoryStoreForTests();
      expect(resolveStoreKind()).toBe("memory");
      const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
      const wrote = await updateCallsPaperBook(() => serializeCallsPaperBook(opened.book));
      expect(wrote).toBe(true);
      expect(parseCallsPaperBook(await readCallsPaperBookText()).trades).toHaveLength(2);
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      clearMemoryStoreForTests();
    }
  });
});

describe("reports and market-data boundary", () => {
  it("puts callsPaper and lastCheckAt on the brief and the health report", () => {
    const opened = advanceCallsPaper(emptyCallsPaperBook(), [snapshot()], NOW);
    const health = buildHealthReport({
      health: emptyScanHealth(),
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [],
      openShadows: 0,
      resolvedShadows: 0,
      callsPaper: callsPaperHealth(opened.book, NOW),
      now: NOW,
    });
    expect(health.callsPaper.lastCheckAt).toBe(NOW.toISOString());
    expect(health.callsPaper.paperOnly).toBe(true);
    expect(health.callsPaper.setups.A.open).toBe(1);
    expect(health.callsPaper.setups.S.open).toBe(1);
    expect(emptyCallsPaperHealth().lastCheckAt).toBeNull();

    const brief = buildMarketBrief({
      alerts: [],
      shadows: [],
      trades: [],
      scan: health,
      now: NOW,
      callsBook: opened.book,
    });
    expect(brief.callsPaper.lastCheckAt).toBe(NOW.toISOString());
    expect(brief.callsPaper.openRows).toHaveLength(2);
    expect(brief.callsPaper.openRows.every((row) => row.entryDebit > 0)).toBe(true);
    expect(brief.callsPaper.note).toMatch(/Paper only/);
  });

  it("reads Schwab price history, chains, and quotes, and no order endpoint", () => {
    expect(CALLS_MARKET_DATA_PATHS).toEqual(["pricehistory", "chains", "quotes"]);
    const files = [
      "app/lib/callsPaper.ts",
      "app/lib/callsPaperRun.ts",
      "app/api/calls/route.ts",
      "app/api/cron/route.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/\/orders\b/);
      expect(source).not.toMatch(/\/accounts\b/);
      expect(source).not.toMatch(/\/transactions\b/);
      expect(source).not.toMatch(/trader\/v1/);
      expect(source).not.toMatch(/placeOrder|createOrder|cancelOrder/);
    }
    const runner = readFileSync(join(process.cwd(), "app/lib/callsPaperRun.ts"), "utf8");
    expect(runner).toContain('from "@/app/lib/schwab"');
    expect(runner).toContain("getPriceHistory");
    expect(runner).toContain("getOptionChain");
    expect(runner).toContain("getQuoteEntries");
    expect(runner).not.toContain("marketData");
    expect(runner).not.toMatch(/tastytrade/i);
    const cron = readFileSync(join(process.cwd(), "app/api/cron/route.ts"), "utf8");
    expect(cron).toContain("runCallsPaper");
    const health = readFileSync(join(process.cwd(), "app/api/health/route.ts"), "utf8");
    const brief = readFileSync(join(process.cwd(), "app/api/brief/route.ts"), "utf8");
    expect(health).toContain("callsPaper");
    expect(brief).toContain("callsBook");
  });
});

function memoryDeps(
  dailyBars = vi.fn(async (symbol: string) => (symbol === "SPY" ? [
    bar("2026-10-27T14:00:00.000Z", 98, 99, 97, 99, 1_000_000),
    bar("2026-10-28T14:00:00.000Z", 100, 101, 98, 100, 1_000_000),
  ] : [
    bar("2026-10-27T14:00:00.000Z", 100, 101, 99, 100, 10),
    bar("2026-10-28T14:00:00.000Z", 100, 101, 100, 100.2, 10),
  ])),
  chain = vi.fn(async (_symbol: string, _now: Date) => ({
    quotes: ladder(),
    problem: null as "delayed" | "unavailable" | null,
  })),
): {
  deps: CallsPaperDeps;
  text: () => string | null;
  sent: ReturnType<typeof vi.fn>;
  chain: ReturnType<typeof vi.fn>;
  quotes: ReturnType<typeof vi.fn>;
  longBid: number;
  longAsk: number;
} {
  let text: string | null = null;
  const state = { longBid: 2, longAsk: 2.2 };
  const sent = vi.fn(async () => true);
  const quotes = vi.fn(async (symbols: readonly string[]) => {
    const map = new Map<string, { bid: number; ask: number; delta: number | null }>();
    for (let i = 0; i < symbols.length; i++) {
      const strike = Number(normalizeOptionSymbol(symbols[i]).slice(-8)) / 1000;
      if (strike === 97) map.set(normalizeOptionSymbol(symbols[i]), { bid: 4.4, ask: 4.5, delta: 0.3 });
      else if (strike === 99) map.set(normalizeOptionSymbol(symbols[i]), { bid: 5.2, ask: 5.3, delta: 0.55 });
      else if (strike === 104) map.set(normalizeOptionSymbol(symbols[i]), { bid: 0.4, ask: 0.5, delta: 0.08 });
    }
    return map;
  });
  const deps: CallsPaperDeps = {
    daily: dailyBars,
    minutes: async (symbol) => (symbol === "SPY" ? signalBars() : []),
    chain: async (symbol, now) => {
      const read = await chain(symbol, now);
      return {
        ...read,
        quotes: read.quotes.map((quote) => (
          quote.strike === 97 ? { ...quote, bid: state.longBid, ask: state.longAsk } : quote
        )),
      };
    },
    quotes,
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
    chain,
    quotes,
    get longBid() { return state.longBid; },
    set longBid(value: number) { state.longBid = value; },
    get longAsk() { return state.longAsk; },
    set longAsk(value: number) { state.longAsk = value; },
  };
}
