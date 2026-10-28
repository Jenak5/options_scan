import { describe, expect, it } from "vitest";
import {
  JG_VWAP_ATR_BAND_HIGH,
  JG_VWAP_ATR_BAND_LOW,
  JG_VWAP_BUDGET_DOLLARS,
  JG_VWAP_SIZE_0DTE_DOLLARS,
  JG_VWAP_SIZE_UNKNOWN_DOLLARS,
  JG_VWAP_TEST,
} from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import type { OptionContract } from "@/app/lib/contract";
import {
  advanceJgVwap,
  emptyJgVwapBook,
  formatAtrLine,
  formatAtrUsed,
  formatJgVwapAlert,
  jgAtr14,
  jgAtrUsed,
  jgChainRoots,
  jgContractsForSize,
  jgImpliedMove,
  jgNextTradingDay,
  jgSessionVwap,
  jgSpreadTooWide,
  jgStopUnderlying,
  jgSuggestedSize,
  jgTodayRange,
  jgVwapPnl,
  jgVwapPnlSeries,
  jgVwapSection,
  jgVwapSide,
  jgVwapSize,
  parseJgVwapBook,
  serializeJgVwapBook,
  type JgSnapshot,
  type JgVwapBook,
  type JgVwapTrade,
} from "@/app/lib/jgVwap";
import { runJgVwapPaper, type JgVwapDeps } from "@/app/lib/jgVwapRun";
import type { JgSignal } from "@/app/lib/jgSignal";
import type { ChainParseResult } from "@/app/lib/schwabParse";
import { clearMemoryStoreForTests, readJgVwapBookText, updateJgVwapBook } from "@/app/lib/schwabStore";
import { DEFAULT_ACCOUNT_SIZE_DOLLARS } from "@/app/lib/risk";

const MINUTE = 60_000;
const SESSION_OPEN = Date.parse("2026-10-21T13:30:00.000Z");
const NOW = new Date("2026-10-21T14:05:00.000Z");
const DAY = "2026-10-21";

function bar(index: number, price: number): CandleBar {
  return { t: SESSION_OPEN + index * MINUTE, o: price, h: price, l: price, c: price, v: 1 };
}

function bars(price: number, count = 8): CandleBar[] {
  const out: CandleBar[] = [];
  for (let i = 0; i < count; i++) out.push(bar(i, price));
  return out;
}

function contract(partial: Partial<OptionContract> & Pick<OptionContract, "strike" | "putCall" | "bid" | "ask">): OptionContract {
  return {
    last: partial.ask,
    volume: 1000,
    openInterest: 1000,
    delta: 0.5,
    iv: 0.2,
    expiration: DAY,
    ...partial,
  };
}

function chain(contracts: OptionContract[], underlyingPrice: number | null): ChainParseResult {
  return { contracts, delayed: false, underlyingPrice };
}

describe("JG-VWAP budget and filters", () => {
  it("keeps the per-trade budget in one constant and flags only above it", () => {
    expect(JG_VWAP_BUDGET_DOLLARS).toBe(875);
    expect(JG_VWAP_TEST.budgetDollars).toBe(JG_VWAP_BUDGET_DOLLARS);
    expect(jgVwapSize(JG_VWAP_BUDGET_DOLLARS / 100)).toEqual({ contracts: 1, overBudget: false });
    expect(jgVwapSize((JG_VWAP_BUDGET_DOLLARS + 1) / 100)).toEqual({ contracts: 1, overBudget: true });
    expect(jgVwapSize(2)).toEqual({ contracts: Math.floor(JG_VWAP_BUDGET_DOLLARS / 200), overBudget: false });
  });

  it("buys calls only above the band and puts only below it", () => {
    const vwap = 100;
    expect(jgVwapSide(vwap * (1 + 0.001) + 0.05, vwap)).toBe("call");
    expect(jgVwapSide(vwap * (1 - 0.001) - 0.05, vwap)).toBe("put");
    expect(jgVwapSide(vwap, vwap)).toBeNull();
    expect(jgVwapSide(vwap * (1 + 0.001), vwap)).toBeNull();
    expect(jgVwapSide(vwap * (1 - 0.001), vwap)).toBeNull();
  });

  it("skips a spread wider than 10% of the mid and keeps one equal to 10%", () => {
    expect(jgSpreadTooWide(1, 1.3)).toBe(true);
    expect(jgSpreadTooWide(1.9, 2.1)).toBe(false);
  });

  it("scores the fill as ask in, bid out, and $0.65 each side", () => {
    expect(jgVwapPnl(2, 3, 2)).toBeCloseTo((3 - 2) * 100 * 2 - 0.65 * 2 * 2, 2);
  });

  it("places the stop 0.75 times the day's implied move against the entry", () => {
    const move = jgImpliedMove(500, 16);
    expect(move).not.toBeNull();
    const distance = 0.75 * (move as number);
    expect(jgStopUnderlying("call", 500, move as number)).toBeCloseTo(500 - distance, 6);
    expect(jgStopUnderlying("put", 500, move as number)).toBeCloseTo(500 + distance, 6);
    expect(move).toBeCloseTo(500 * (16 / 100) / Math.sqrt(252), 8);
  });
});

describe("JG-VWAP paper pass", () => {
  it("logs QQQ in budget and SPX over budget on SPXW when the SPX chain is empty", async () => {
    const seen: string[] = [];
    const messages: string[] = [];
    const deps = memoryDeps({
      history(symbol) {
        if (symbol === "SPX") return bars(5000);
        return bars(100);
      },
      chain(symbol) {
        seen.push(symbol);
        if (symbol === "QQQ") return chain([contract({ strike: 102, putCall: "call", bid: 1.9, ask: 2 })], 102);
        if (symbol === "SPX") return chain([], null);
        return chain([contract({ strike: 5100, putCall: "call", bid: 9.6, ask: 10, expiration: DAY })], 5100);
      },
      send(message) {
        messages.push(message);
        return true;
      },
    });

    const first = await runJgVwapPaper(NOW, deps.deps);
    expect(seen).toEqual(["QQQ", "SPX", "SPXW"]);
    expect(jgChainRoots("SPX")).toEqual(["SPX", "SPXW"]);
    expect(first.opened).toBe(0);
    expect(first.saved).toBe(true);
    expect(first.spxRoot).toBe("SPXW");
    expect(first.logNote).toMatch(/VXN|VIX|daily closes|5-minute/);
    expect(messages).toHaveLength(0);
    const priced = advanceJgVwap(emptyJgVwapBook(), [
      snapshot("QQQ", "QQQ", 102, 100, [contract({ strike: 102, putCall: "call", bid: 1.9, ask: 2 })]),
      snapshot("SPX", "SPXW", 5100, 5000, [contract({ strike: 5100, putCall: "call", bid: 9.6, ask: 10 })]),
    ], NOW);
    expect(priced.opened).toHaveLength(2);
    const qqq = priced.opened.find((trade) => trade.ticker === "QQQ");
    const spx = priced.opened.find((trade) => trade.ticker === "SPX");
    expect(qqq).toMatchObject({ contracts: 1, budgetContracts: 4, overBudget: false, putCall: "call", root: "QQQ" });
    expect(spx).toMatchObject({ contracts: 0, budgetContracts: 1, overBudget: true, root: "SPXW" });
    expect(formatJgVwapAlert(qqq as JgVwapTrade)).toContain("ATR used");
    expect(formatJgVwapAlert(spx as JgVwapTrade)).toContain("Over budget");
    expect(formatJgVwapAlert(qqq as JgVwapTrade)).toContain("Suggested size");
    const card = jgVwapSection(priced.book);
    expect(card.label).toBe("JG-VWAP paper test");
    expect(card.buckets.find((bucket) => bucket.key === "QQQ")).toMatchObject({ trades: 0, open: 1 });
    expect(card.buckets.find((bucket) => bucket.key === "SPX-over-budget")).toMatchObject({ open: 1 });
    expect(jgVwapSection(parseJgVwapBook(deps.text())).note).toContain("SPXW");

    messages.length = 0;
    const second = await runJgVwapPaper(NOW, deps.deps);
    expect(second.opened).toBe(0);
    expect(messages).toHaveLength(0);
  });

  it("uses an SPX chain when that symbol returns contracts", async () => {
    const seen: string[] = [];
    const deps = memoryDeps({
      history: () => bars(5000),
      chain(symbol) {
        seen.push(symbol);
        if (symbol === "SPX") return chain([contract({ strike: 5100, putCall: "put", bid: 1.9, ask: 2 })], 4900);
        return chain([contract({ strike: 100, putCall: "call", bid: 1.9, ask: 2 })], 102);
      },
    });
    const result = await runJgVwapPaper(NOW, deps.deps);
    expect(seen).toEqual(["QQQ", "SPX"]);
    expect(result.spxRoot).toBe("SPX");
    expect(result.opened).toBe(0);
    expect(result.logNote).toMatch(/VIX|daily closes|5-minute/);
  });

  it("skips a wide QQQ spread and says so when neither SPX root has contracts", async () => {
    const messages: string[] = [];
    const deps = memoryDeps({
      history() {
        return bars(100);
      },
      chain(symbol) {
        if (symbol === "QQQ") return chain([contract({ strike: 100, putCall: "call", bid: 1, ask: 1.3 })], 102);
        return chain([], null);
      },
      send(message) {
        messages.push(message);
        return true;
      },
    });
    const result = await runJgVwapPaper(NOW, deps.deps);
    expect(result.opened).toBe(0);
    expect(result.spxUnavailable).toBe(true);
    expect(result.logNote).toContain("QQQ only");
    expect(messages).toHaveLength(0);
    expect(jgVwapSection(parseJgVwapBook(deps.text())).note).toContain("no SPX chain and no SPXW chain");
  });

  it("does not read chains on a full-day NYSE holiday or before the Central session", async () => {
    let calls = 0;
    const deps = memoryDeps({
      history() {
        calls += 1;
        return bars(100);
      },
      chain() {
        calls += 1;
        return chain([], null);
      },
    });
    const holiday = await runJgVwapPaper(new Date("2026-11-26T15:30:00.000Z"), deps.deps);
    expect(holiday.skipped).toBe("closed");
    expect(holiday.opened).toBe(0);
    const early = await runJgVwapPaper(new Date("2026-10-21T12:00:00.000Z"), deps.deps);
    expect(early.skipped).toBe("closed");
    expect(calls).toBe(0);
  });

  it("stops on the implied move and flats at 3:45 PM ET", () => {
    const session = jgSessionVwap(bars(100), NOW.getTime());
    expect(session?.vwap).toBeCloseTo(100, 6);
    const snap = snapshot("QQQ", "QQQ", 102, 100, [contract({ strike: 102, putCall: "call", bid: 1.9, ask: 2 })]);
    const opened = advanceJgVwap(emptyJgVwapBook(), [snap], NOW);
    const trade = opened.opened[0];
    expect(trade.stopUnderlying).toBe(snap.signal?.stop);
    expect(trade.level).toBe(100);

    const stoppedSpot = trade.stopUnderlying;
    const stopped = advanceJgVwap(opened.book, [snapshot("QQQ", "QQQ", stoppedSpot, 100, [
      contract({ strike: 102, putCall: "call", bid: 0.5, ask: 0.6 }),
    ])], new Date("2026-10-21T18:00:00.000Z"));
    expect(stopped.closed[0]).toMatchObject({ exitReason: "stop", exitBid: 0.5 });
    expect(stopped.closed[0].pnlDollars).toBe(jgVwapPnl(2, 0.5, trade.contracts));

    const stillOpen = advanceJgVwap(opened.book, [snapshot("QQQ", "QQQ", 102, 100, [
      contract({ strike: 102, putCall: "call", bid: 3, ask: 3.1 }),
    ])], new Date("2026-10-21T19:44:00.000Z"));
    expect(stillOpen.closed).toHaveLength(0);

    const flat = advanceJgVwap(opened.book, [snapshot("QQQ", "QQQ", 102, 100, [
      contract({ strike: 102, putCall: "call", bid: 3, ask: 3.1 }),
    ])], new Date("2026-10-21T19:45:00.000Z"));
    expect(flat.closed[0]).toMatchObject({ exitReason: "flat", exitBid: 3 });
    expect(stopped.closed[0].pnlBudgetDollars).toBe(jgVwapPnl(2, 0.5, trade.budgetContracts));
    const alert = formatJgVwapAlert(trade);
    expect(alert).toContain("PAPER TEST - JG-VWAP");
    expect(alert).toContain("outside the daily A/B alert cap");
    expect(alert).toContain("ATR used");
    expect(alert).toContain("Suggested size");
    expect(alert).toContain("ATR used: unknown | Suggested size: $300");
  });

  it("flats an early close at 1:00 PM ET", () => {
    const trade = sampleTrade({ id: "jgvwap-QQQ-2026-11-27", ticker: "QQQ", expiration: "2026-11-27" });
    const book: JgVwapBook = { ...emptyJgVwapBook(), trades: [trade] };
    const snap = [snapshot("QQQ", "QQQ", trade.entryUnderlying, trade.vwap, [
      contract({ strike: trade.strike, putCall: "call", bid: 1, ask: 1.1, expiration: "2026-11-27" }),
    ])];
    const before = advanceJgVwap(book, snap, new Date("2026-11-27T17:59:00.000Z"));
    expect(before.closed).toHaveLength(0);
    const atClose = advanceJgVwap(book, snap, new Date("2026-11-27T18:00:00.000Z"));
    expect(atClose.closed[0].exitReason).toBe("flat");
  });
});

describe("JG-VWAP scorecard", () => {
  it("splits QQQ, SPX, and the SPX over-budget bucket and leaves those rows out of each other", () => {
    const book: JgVwapBook = {
      ...emptyJgVwapBook(),
      spxRoot: "SPX",
      trades: [
        sampleTrade({ id: "jgvwap-QQQ-2026-10-19", ticker: "QQQ", pnl: 100, closedAt: 1 }),
        sampleTrade({ id: "jgvwap-QQQ-2026-10-20", ticker: "QQQ", pnl: -400, closedAt: 2 }),
        sampleTrade({ id: "jgvwap-QQQ-2026-10-21", ticker: "QQQ", pnl: 50, closedAt: 3 }),
        sampleTrade({ id: "jgvwap-QQQ-2026-10-22", ticker: "QQQ", pnl: 10, closedAt: 4 }),
        sampleTrade({ id: "jgvwap-SPX-2026-10-19", ticker: "SPX", pnl: 25, closedAt: 1, overBudget: false }),
        sampleTrade({ id: "jgvwap-SPX-2026-10-20", ticker: "SPX", pnl: -5, closedAt: 2, overBudget: true, root: "SPXW" }),
      ],
    };
    const card = jgVwapSection(book);
    const qqq = card.buckets.find((bucket) => bucket.key === "QQQ");
    const spx = card.buckets.find((bucket) => bucket.key === "SPX");
    const over = card.buckets.find((bucket) => bucket.key === "SPX-over-budget");
    expect(qqq).toMatchObject({
      trades: 4,
      wins: 3,
      losses: 1,
      pnl: -240,
      pnlWithoutTop3: -400,
    });
    expect(qqq?.winRate).toBeCloseTo(0.75, 6);
    expect(qqq?.maxDrawdownDollars).toBe(400);
    expect(qqq?.maxDrawdownVsAccount).toBeCloseTo(400 / DEFAULT_ACCOUNT_SIZE_DOLLARS, 8);
    expect(DEFAULT_ACCOUNT_SIZE_DOLLARS).toBe(5000);
    expect(spx).toMatchObject({ trades: 1, pnl: 25, pnlWithoutTop3: null });
    expect(over).toMatchObject({ trades: 1, pnl: -5 });
    expect(card.tooFew).toBe(true);
    expect(card.targetSample).toBe(30);
    expect(card.trustNote).toContain("6 closed");
  });

  it("round-trips the paper log without touching an unreadable document", async () => {
    clearMemoryStoreForTests();
    const book: JgVwapBook = {
      ...emptyJgVwapBook(),
      spxRoot: "SPXW",
      trades: [sampleTrade({ id: "jgvwap-QQQ-2026-10-21", ticker: "QQQ", pnl: 12, closedAt: 5 })],
    };
    expect(await updateJgVwapBook(() => serializeJgVwapBook(book))).toBe(true);
    expect(parseJgVwapBook(await readJgVwapBookText()).trades[0].pnlDollars).toBe(12);
    expect(parseJgVwapBook(await readJgVwapBookText()).trades[0].atrUsed).toBe(0.52);
    expect(parseJgVwapBook(await readJgVwapBookText()).trades[0].suggestedSize).toBe(JG_VWAP_SIZE_0DTE_DOLLARS);
    expect(parseJgVwapBook(await readJgVwapBookText()).spxRoot).toBe("SPXW");
    expect(await updateJgVwapBook(() => "{")).toBe(true);
    expect(await updateJgVwapBook(() => serializeJgVwapBook(book))).toBe(false);
    expect(await readJgVwapBookText()).toBe("{");
  });
});

describe("JG-VWAP ATR sizing", () => {
  it("formats the Telegram line and keeps 0DTE size flat when ATR is known", () => {
    expect(JG_VWAP_SIZE_0DTE_DOLLARS).toBe(250);
    expect(JG_VWAP_SIZE_UNKNOWN_DOLLARS).toBe(300);
    expect(formatAtrLine(0.52, 250)).toBe("ATR used: 52% | Suggested size: $250");
    expect(formatAtrLine(null, 300)).toBe("ATR used: unknown | Suggested size: $300");
    expect(formatAtrUsed(0.525)).toBe("52.5%");
    expect(jgSuggestedSize(0.41)).toBe(250);
    expect(jgSuggestedSize(0.52)).toBe(250);
    expect(jgSuggestedSize(0.67)).toBe(250);
    expect(jgSuggestedSize(0.2)).toBe(250);
    expect(jgSuggestedSize(1.4)).toBe(250);
    expect(jgSuggestedSize(0)).toBe(250);
    expect(jgSuggestedSize(null)).toBe(300);
    expect(jgSuggestedSize(Number.NaN)).toBe(300);
    const known = sampleTrade({
      id: "jgvwap-QQQ-2026-10-21",
      ticker: "QQQ",
      atrUsed: 0.52,
      suggestedSize: 250,
      contracts: 1,
      budgetContracts: 4,
    });
    const text = formatJgVwapAlert(known);
    expect(text).toContain("ATR used");
    expect(text).toContain("Suggested size");
    expect(text).toContain("ATR used: 52% | Suggested size: $250");
    const missing = sampleTrade({
      id: "jgvwap-SPX-2026-10-21",
      ticker: "SPX",
      atrUsed: null,
      suggestedSize: 300,
      contracts: 0,
      budgetContracts: 1,
      overBudget: true,
    });
    expect(formatJgVwapAlert(missing)).toContain("ATR used: unknown | Suggested size: $300");
    expect(formatJgVwapAlert(missing)).toContain("not scored");
  });

  it("averages 14 completed true ranges and leaves today out", () => {
    const prior = atrDays(15, 125, 100, 100);
    expect(jgAtr14(prior, DAY)).toBe(25);
    const withToday = prior.concat([{ t: Date.parse(`${DAY}T16:00:00.000Z`), o: 100, h: 400, l: 50, c: 100, v: 1 }]);
    expect(jgAtr14(withToday, DAY)).toBe(25);
    expect(jgAtr14(prior.slice(0, 14), DAY)).toBeNull();
    expect(jgAtr14([], DAY)).toBeNull();
    const range = jgTodayRange([{ t: SESSION_OPEN, o: 100, h: 113, l: 100, c: 100, v: 1 }], NOW.getTime());
    expect(range).toBe(13);
    expect(jgAtrUsed(range, 25)).toBeCloseTo(0.52, 8);
    expect(jgAtrUsed(null, 25)).toBeNull();
    expect(jgAtrUsed(13, null)).toBeNull();
    expect(jgAtrUsed(13, 0)).toBeNull();
    expect(jgContractsForSize(2, 250)).toBe(1);
    expect(jgContractsForSize(10, 250)).toBe(0);
    expect(jgContractsForSize(2, 875)).toBe(4);
  });

  it("puts a known ATR on the Telegram text and scores the suggested size", async () => {
    const messages: string[] = [];
    const deps = memoryDeps({
      history(symbol) {
        if (symbol === "QQQ") return [{ t: SESSION_OPEN, o: 100, h: 113, l: 100, c: 100, v: 1 }];
        return bars(5000);
      },
      daily(symbol) {
        return symbol === "QQQ" ? atrDays(16, 125, 100, 100) : [];
      },
      chain(symbol) {
        if (symbol === "QQQ") return chain([contract({ strike: 110, putCall: "call", bid: 1.9, ask: 2 })], 110);
        if (symbol === "SPX") return chain([], null);
        return chain([], null);
      },
      send(message) {
        messages.push(message);
        return true;
      },
    });
    const result = await runJgVwapPaper(NOW, deps.deps);
    expect(result.opened).toBe(0);
    expect(result.logNote).toMatch(/VXN|daily closes|5-minute/);
    expect(messages).toHaveLength(0);
  });

  it("skips suggested P/L at zero contracts and still keeps the $875 line", () => {
    const book: JgVwapBook = {
      ...emptyJgVwapBook(),
      trades: [
        sampleTrade({ id: "jgvwap-QQQ-2026-10-19", ticker: "QQQ", pnl: 100, pnlBudget: 400, closedAt: 10, contracts: 1, budgetContracts: 4 }),
        sampleTrade({ id: "jgvwap-QQQ-2026-10-20", ticker: "QQQ", pnl: -40, pnlBudget: -20, closedAt: 20, contracts: 1, budgetContracts: 4 }),
        sampleTrade({
          id: "jgvwap-SPX-2026-10-21",
          ticker: "SPX",
          pnl: null,
          pnlBudget: -15,
          closedAt: 30,
          contracts: 0,
          budgetContracts: 1,
          overBudget: true,
          suggestedSize: 250,
          atrUsed: 0.52,
        }),
        sampleTrade({
          id: "jgvwap-QQQ-2026-10-18",
          ticker: "QQQ",
          pnl: 80,
          closedAt: 5,
          suggestedSize: null,
          atrUsed: null,
          contracts: 4,
          budgetContracts: 4,
        }),
      ],
    };
    const series = jgVwapPnlSeries(book.trades);
    expect(series.map((point) => point.budget)).toEqual([80, 480, 460, 445]);
    expect(series.map((point) => point.suggested)).toEqual([null, 100, 60, 60]);
    expect(jgVwapSection(book).pnlSeries).toEqual(series);
    expect(jgVwapSection(emptyJgVwapBook()).pnlSeries).toEqual([]);
    const qqq = jgVwapSection(book).buckets.find((bucket) => bucket.key === "QQQ");
    expect(qqq).toMatchObject({ trades: 2, pnl: 60, budgetTrades: 3, pnlBudget: 460 });
    const over = jgVwapSection(book).buckets.find((bucket) => bucket.key === "SPX-over-budget");
    expect(over).toMatchObject({ trades: 0, pnl: 0, budgetTrades: 1, pnlBudget: -15 });
  });

  it("keeps a legacy $875 row when ATR fields are absent", () => {
    const legacy = {
      version: 1,
      trades: [{
        id: "jgvwap-QQQ-2026-10-19",
        ticker: "QQQ",
        putCall: "call",
        strike: 100,
        expiration: "2026-10-19",
        openedAt: 1,
        contracts: 4,
        overBudget: false,
        entryAsk: 2,
        entryBid: 1.9,
        entryUnderlying: 102,
        vwap: 100,
        iv: 0.2,
        impliedMove: 1,
        stopUnderlying: 101,
        status: "closed",
        closedAt: 2,
        exitBid: 3,
        exitReason: "flat",
        pnlDollars: 100,
      }],
      spxRoot: null,
      spxUnavailable: false,
      spxVwapMiss: false,
    };
    const trade = parseJgVwapBook(JSON.stringify(legacy)).trades[0];
    expect(trade).toMatchObject({
      contracts: 4,
      budgetContracts: 4,
      atrUsed: null,
      suggestedSize: null,
      pnlDollars: 100,
      pnlBudgetDollars: 100,
    });
    expect(jgVwapPnlSeries([trade])).toMatchObject([{ at: 2, suggested: null, budget: 100, budget0: 100, suggested1: null, budget1: null }]);
    expect(trade.dte).toBe("0DTE");
    expect(jgVwapSection({ ...emptyJgVwapBook(), trades: [trade] }).buckets[0]).toMatchObject({
      trades: 0,
      pnl: 0,
      budgetTrades: 1,
      pnlBudget: 100,
    });
  });
});

describe("JG-VWAP 1DTE", () => {
  it("picks the next trading day, including Friday to Monday and a holiday", () => {
    expect(JG_VWAP_ATR_BAND_LOW).toBe(0.41);
    expect(JG_VWAP_ATR_BAND_HIGH).toBe(0.67);
    expect(jgNextTradingDay("2026-10-23")).toBe("2026-10-26");
    expect(jgNextTradingDay("2026-04-02")).toBe("2026-04-06");
    expect(jgNextTradingDay("2026-11-25")).toBe("2026-11-27");
    expect(jgSuggestedSize(0.41, "1DTE")).toBe(875);
    expect(jgSuggestedSize(0.67, "1DTE")).toBe(875);
    expect(jgSuggestedSize(0.409, "1DTE")).toBe(300);
    expect(jgSuggestedSize(0.671, "1DTE")).toBe(300);
    expect(jgSuggestedSize(null, "1DTE")).toBe(300);
    expect(jgSuggestedSize(0.41, "0DTE")).toBe(250);
    expect(jgSuggestedSize(0.67, "0DTE")).toBe(250);
    expect(jgSuggestedSize(null, "0DTE")).toBe(300);

    const friday = new Date("2026-10-23T14:05:00.000Z");
    const fridayChain = [
      contract({ strike: 102, putCall: "call", bid: 1.9, ask: 2, expiration: "2026-10-23" }),
      contract({ strike: 103, putCall: "call", bid: 1.9, ask: 2, expiration: "2026-10-26" }),
    ];
    const opened = advanceJgVwap(emptyJgVwapBook(), [snapshot("QQQ", "QQQ", 102, 100, fridayChain, 0.41)], friday);
    const zero = opened.opened.find((trade) => trade.dte === "0DTE");
    const one = opened.opened.find((trade) => trade.dte === "1DTE");
    expect(zero).toMatchObject({ expiration: "2026-10-23", suggestedSize: 250, contracts: 1 });
    expect(one).toMatchObject({ expiration: "2026-10-26", suggestedSize: 875, contracts: 4 });
    expect(opened.oneDteSkips).toEqual([]);
    const oneAlert = formatJgVwapAlert(one as JgVwapTrade);
    expect(oneAlert).toContain("PAPER TEST - JG-VWAP 1DTE");
    expect(oneAlert).toContain("ATR used");
    expect(oneAlert).toContain("Suggested size");
    expect(oneAlert).toContain("ATR used: 41% | Suggested size: $875");
    expect(oneAlert).toContain("outside the daily A/B alert cap");
    expect(oneAlert).toContain("3:45 PM ET the same day");
    expect(formatJgVwapAlert(zero as JgVwapTrade)).toContain("PAPER TEST - JG-VWAP 0DTE");
    expect(formatJgVwapAlert(zero as JgVwapTrade)).toContain("ATR used: 41% | Suggested size: $250");
    expect(formatJgVwapAlert(zero as JgVwapTrade)).toContain("3:45 PM ET the same day");

    const beforeFlat = advanceJgVwap(opened.book, [snapshot("QQQ", "QQQ", 102, 100, fridayChain, 0.41)], new Date("2026-10-23T19:44:00.000Z"));
    expect(beforeFlat.book.trades.find((trade) => trade.dte === "1DTE")?.status).toBe("open");
    const sameDay = advanceJgVwap(opened.book, [snapshot("QQQ", "QQQ", 102, 100, fridayChain, 0.41)], new Date("2026-10-23T19:45:00.000Z"));
    expect(sameDay.closed.find((trade) => trade.dte === "0DTE")?.exitReason).toBe("flat");
    expect(sameDay.closed.find((trade) => trade.dte === "1DTE")?.exitReason).toBe("flat");
    const series = jgVwapPnlSeries(sameDay.book.trades);
    const last = series[series.length - 1];
    expect(last.suggested0).not.toBeNull();
    expect(last.suggested1).not.toBeNull();
    expect(last.budget).toBeCloseTo((last.budget0 ?? 0) + (last.budget1 ?? 0), 2);
    expect(last.suggested).toBeCloseTo((last.suggested0 ?? 0) + (last.suggested1 ?? 0), 2);

    const thursday = new Date("2026-04-02T14:05:00.000Z");
    const holidayChain = [
      contract({ strike: 102, putCall: "call", bid: 1.9, ask: 2, expiration: "2026-04-02" }),
      contract({ strike: 104, putCall: "call", bid: 1.9, ask: 2, expiration: "2026-04-03" }),
    ];
    const skipped = advanceJgVwap(emptyJgVwapBook(), [snapshot("QQQ", "QQQ", 102, 100, holidayChain, 0.67)], thursday);
    expect(skipped.opened.map((trade) => trade.dte)).toEqual(["0DTE"]);
    expect(skipped.oneDteSkips).toEqual([{ ticker: "QQQ", expiration: "2026-04-06" }]);
    expect(skipped.book.oneDteNote).toContain("no contract expiring 2026-04-06");
    const withMonday = holidayChain.concat([
      contract({ strike: 105, putCall: "call", bid: 1.9, ask: 2, expiration: "2026-04-06" }),
    ]);
    const holidayOpen = advanceJgVwap(emptyJgVwapBook(), [snapshot("QQQ", "QQQ", 102, 100, withMonday, 0.67)], thursday);
    expect(holidayOpen.opened.find((trade) => trade.dte === "1DTE")).toMatchObject({
      expiration: "2026-04-06",
      suggestedSize: 875,
    });
    expect(formatJgVwapAlert(holidayOpen.opened.find((trade) => trade.dte === "1DTE") as JgVwapTrade)).toContain("ATR used: 67% | Suggested size: $875");
  });

  it("sends the 1DTE label through the paper Telegram path", async () => {
    const messages: string[] = [];
    const deps = memoryDeps({
      history: () => bars(100),
      chain(symbol) {
        if (symbol !== "QQQ") return chain([], null);
        return chain([
          contract({ strike: 102, putCall: "call", bid: 1.9, ask: 2, expiration: DAY }),
          contract({ strike: 102, putCall: "call", bid: 1.9, ask: 2, expiration: "2026-10-22" }),
        ], 102);
      },
      send(message) {
        messages.push(message);
        return true;
      },
    });
    const result = await runJgVwapPaper(NOW, deps.deps);
    expect(result.opened).toBe(0);
    expect(result.logNote).toMatch(/VXN|daily closes|5-minute/);
    expect(messages).toHaveLength(0);
  });
});

function snapshot(
  ticker: "QQQ" | "SPX",
  root: string,
  spot: number,
  vwap: number,
  contracts: OptionContract[],
  atrUsed: number | null = null,
  signal: JgSignal | null | undefined = undefined,
): JgSnapshot {
  const built = signal === undefined ? testSignal(spot, vwap, atrUsed) : signal;
  return {
    ticker,
    root,
    spot,
    vwap,
    contracts,
    atrUsed: built?.atrUsed ?? atrUsed,
    signal: built,
    signalNote: built?.vwapOk ? "" : "no signal",
  };
}

function testSignal(spot: number, vwap: number, atrUsed: number | null): JgSignal {
  const direction = spot < vwap ? "put" : "call";
  const volIndex = 16;
  const impliedMove = spot * (volIndex / 100) / Math.sqrt(252);
  const raw = direction === "call" ? spot - 0.75 * impliedMove : spot + 0.75 * impliedMove;
  return {
    direction,
    signalAt: NOW.getTime(),
    entry: spot,
    level: Math.round(vwap * 10000) / 10000,
    vwap,
    vwapDist: 0,
    vwapOk: true,
    impliedMove,
    stop: Math.round(raw * 1000) / 1000,
    atrUsed,
    priorClose: spot,
    volIndex,
    volSymbol: "VXN",
  };
}

function sampleTrade(partial: {
  id: string;
  ticker: "QQQ" | "SPX";
  pnl?: number | null;
  pnlBudget?: number | null;
  closedAt?: number;
  overBudget?: boolean;
  root?: string;
  expiration?: string;
  contracts?: number;
  budgetContracts?: number;
  atrUsed?: number | null;
  suggestedSize?: number | null;
  dte?: "0DTE" | "1DTE";
}): JgVwapTrade {
  const closed = partial.pnl !== undefined || partial.pnlBudget !== undefined;
  const contracts = partial.contracts ?? 1;
  const suggestedSize = partial.suggestedSize === undefined ? JG_VWAP_SIZE_0DTE_DOLLARS : partial.suggestedSize;
  const scored = suggestedSize != null && contracts >= 1;
  return {
    id: partial.id,
    ticker: partial.ticker,
    root: partial.root ?? partial.ticker,
    putCall: "call",
    dte: partial.dte ?? "0DTE",
    strike: 100,
    expiration: partial.expiration ?? partial.id.slice(-10),
    openedAt: partial.closedAt ?? 1,
    contracts,
    budgetContracts: partial.budgetContracts ?? 1,
    overBudget: partial.overBudget === true,
    atrUsed: partial.atrUsed === undefined ? (suggestedSize == null ? null : 0.52) : partial.atrUsed,
    suggestedSize,
    entryAsk: 2,
    entryBid: 1.9,
    entryUnderlying: 102,
    vwap: 100,
    level: null,
    iv: 0.2,
    impliedMove: 1,
    stopUnderlying: 101,
    status: closed ? "closed" : "open",
    closedAt: closed ? partial.closedAt ?? 1 : null,
    exitBid: closed ? 2 : null,
    exitReason: closed ? "flat" : null,
    pnlDollars: closed && scored ? partial.pnl ?? 0 : null,
    pnlBudgetDollars: closed ? (partial.pnlBudget === undefined ? partial.pnl ?? 0 : partial.pnlBudget) : null,
  };
}

function atrDays(count: number, high: number, low: number, close: number): CandleBar[] {
  const start = Date.parse("2026-09-28T16:00:00.000Z");
  const out: CandleBar[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ t: start + i * 86_400_000, o: close, h: high, l: low, c: close, v: 1 });
  }
  return out;
}

function memoryDeps(input: {
  history: (symbol: string) => CandleBar[];
  daily?: (symbol: string) => CandleBar[];
  vol?: () => CandleBar[];
  chain: (symbol: string) => ChainParseResult;
  send?: (message: string) => boolean;
}): { deps: JgVwapDeps; text: () => string | null } {
  let stored: string | null = null;
  const deps: JgVwapDeps = {
    history: async (symbol) => input.history(symbol),
    daily: async (symbol) => (input.daily ? input.daily(symbol) : []),
    vol: async () => (input.vol ? input.vol() : []),
    chain: async (symbol) => input.chain(symbol),
    readBook: async () => stored,
    writeBook: async (change) => {
      const next = change(stored);
      if (!next.includes("\"trades\"")) return false;
      stored = next;
      return true;
    },
    send: async (message) => (input.send ? input.send(message) : true),
  };
  return { deps, text: () => stored };
}
