import { describe, expect, it } from "vitest";
import { JG_VWAP_BUDGET_DOLLARS, JG_VWAP_TEST } from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import type { OptionContract } from "@/app/lib/contract";
import {
  advanceJgVwap,
  emptyJgVwapBook,
  formatJgVwapAlert,
  jgChainRoots,
  jgImpliedMove,
  jgSessionVwap,
  jgSpreadTooWide,
  jgStopUnderlying,
  jgVwapPnl,
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
    const move = jgImpliedMove(500, 0.16);
    expect(move).not.toBeNull();
    const distance = 0.75 * (move as number);
    expect(jgStopUnderlying("call", 500, move as number)).toBeCloseTo(500 - distance, 6);
    expect(jgStopUnderlying("put", 500, move as number)).toBeCloseTo(500 + distance, 6);
    expect(move).toBeCloseTo(500 * 0.16 * Math.sqrt(1 / 365), 8);
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
    expect(first.opened).toBe(2);
    expect(first.saved).toBe(true);
    expect(first.spxRoot).toBe("SPXW");
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.startsWith("<b>PAPER TEST - JG-VWAP</b>"))).toBe(true);
    expect(messages.some((message) => message.includes("Over budget"))).toBe(true);

    const book = parseJgVwapBook(deps.text());
    const qqq = book.trades.find((trade) => trade.ticker === "QQQ");
    const spx = book.trades.find((trade) => trade.ticker === "SPX");
    expect(qqq).toMatchObject({ contracts: 4, overBudget: false, putCall: "call", root: "QQQ" });
    expect(spx).toMatchObject({ contracts: 1, overBudget: true, root: "SPXW" });

    const card = jgVwapSection(book);
    expect(card.label).toBe("JG-VWAP paper test");
    expect(card.buckets.find((bucket) => bucket.key === "QQQ")).toMatchObject({ trades: 0, open: 1 });
    expect(card.buckets.find((bucket) => bucket.key === "SPX")).toMatchObject({ trades: 0, open: 0 });
    expect(card.buckets.find((bucket) => bucket.key === "SPX-over-budget")).toMatchObject({ open: 1 });
    expect(card.note).toContain("SPXW");

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
    const spx = parseJgVwapBook(deps.text()).trades.find((trade) => trade.ticker === "SPX");
    expect(spx).toMatchObject({ root: "SPX", putCall: "put", overBudget: false });
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
    expect(trade.stopUnderlying).toBeCloseTo(102 - 0.75 * (jgImpliedMove(102, 0.2) as number), 6);

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
    expect(formatJgVwapAlert(trade)).toContain("PAPER TEST - JG-VWAP");
    expect(formatJgVwapAlert(trade)).toContain("outside the daily A/B alert cap");
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
    expect(parseJgVwapBook(await readJgVwapBookText()).spxRoot).toBe("SPXW");
    expect(await updateJgVwapBook(() => "{")).toBe(true);
    expect(await updateJgVwapBook(() => serializeJgVwapBook(book))).toBe(false);
    expect(await readJgVwapBookText()).toBe("{");
  });
});

function snapshot(
  ticker: "QQQ" | "SPX",
  root: string,
  spot: number,
  vwap: number,
  contracts: OptionContract[],
): JgSnapshot {
  return { ticker, root, spot, vwap, contracts };
}

function sampleTrade(partial: {
  id: string;
  ticker: "QQQ" | "SPX";
  pnl?: number | null;
  closedAt?: number;
  overBudget?: boolean;
  root?: string;
  expiration?: string;
}): JgVwapTrade {
  const closed = partial.pnl != null;
  return {
    id: partial.id,
    ticker: partial.ticker,
    root: partial.root ?? partial.ticker,
    putCall: "call",
    strike: 100,
    expiration: partial.expiration ?? partial.id.slice(-10),
    openedAt: partial.closedAt ?? 1,
    contracts: 1,
    overBudget: partial.overBudget === true,
    entryAsk: 2,
    entryBid: 1.9,
    entryUnderlying: 102,
    vwap: 100,
    iv: 0.2,
    impliedMove: 1,
    stopUnderlying: 101,
    status: closed ? "closed" : "open",
    closedAt: closed ? partial.closedAt ?? 1 : null,
    exitBid: closed ? 2 : null,
    exitReason: closed ? "flat" : null,
    pnlDollars: closed ? partial.pnl ?? 0 : null,
  };
}

function memoryDeps(input: {
  history: (symbol: string) => CandleBar[];
  chain: (symbol: string) => ChainParseResult;
  send?: (message: string) => boolean;
}): { deps: JgVwapDeps; text: () => string | null } {
  let stored: string | null = null;
  const deps: JgVwapDeps = {
    history: async (symbol) => input.history(symbol),
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
