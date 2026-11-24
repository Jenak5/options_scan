import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CandleBar } from "@/app/lib/candleTypes";
import { GET as trialGet } from "@/app/api/avwap-trial/route";
import {
  AVWAP_SYMBOLS,
  advanceAvwapPaper,
  emptyAvwapPaperBook,
  formatAvwapPaperAlert,
  type AvwapSnapshot,
} from "@/app/lib/avwapPaper";
import {
  AVWAP_REPEAT_GAP_MS,
  acknowledgeAvwapAlert,
  emptyAvwapRepeatBook,
  planAvwapRepeats,
} from "@/app/lib/avwapRepeat";
import { closedAvwapTradeIds } from "@/app/lib/avwapRepeatJob";
import { clearMemoryStoreForTests, updateAvwapTrial } from "@/app/lib/schwabStore";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { formatAvwapTrialLog, formatAvwapTrialLogNote, runAvwapTrial, type AvwapTrialDeps } from "@/app/lib/avwapTrialRun";
import {
  AVWAP_TRIAL_SYMBOLS,
  advanceAvwapTrial,
  avwapCallCrosses,
  emptyAvwapTrialBook,
  formatAvwapTrialAlert,
  latestAvwapCallCross,
  serializeAvwapTrialBook,
  trialSymbolsLeaveLiveBookAlone,
  type AvwapTrialBook,
  type AvwapTrialMark,
  type AvwapTrialMarket,
  type AvwapTrialTrade,
} from "@/app/lib/avwapTrial";

const NOW = new Date("2026-10-28T13:40:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearMemoryStoreForTests();
});

describe("AVWAP trial signals", () => {
  it("fires a call when a 5-minute close is above AVWAP after a close at or below it", () => {
    const now = Date.parse("2026-10-28T13:40:00.000Z");
    const bars = callBars();
    const signal = latestAvwapCallCross(bars, "2026-10-28", now);
    expect(signal).not.toBeNull();
    expect(signal && signal.priorClose <= signal.priorVwap).toBe(true);
    expect(signal && signal.close > signal.vwap).toBe(true);
    expect(avwapCallCrosses(putBars(), "2026-10-28", now)).toHaveLength(0);
  });

  it("opens an AMD put on the same cross the live book uses, and leaves the live names alone", () => {
    expect(AVWAP_SYMBOLS).toEqual(["SPY", "IWM", "QQQ", "NVDA", "AAPL", "TSLA", "PLTR"]);
    expect(trialSymbolsLeaveLiveBookAlone()).toBe(true);
    expect(AVWAP_TRIAL_SYMBOLS).toEqual(["AMD", "MSFT", "AMZN"]);
    const opened = advanceAvwapTrial(emptyAvwapTrialBook(), [market("AMD", putBars(), quote(90, "put", 2, 2.2))], NOW);
    expect(opened.opened).toHaveLength(1);
    expect(opened.opened[0]).toMatchObject({ symbol: "AMD", putCall: "put", strike: 90, status: "open" });
    expect(opened.book.checks.AMD?.put.outcome).toBe("entered");
    const live = advanceAvwapPaper(emptyAvwapPaperBook(), [liveSnapshot()], NOW);
    expect(live.opened[0]?.putCall).toBe("put");
    expect(formatAvwapPaperAlert(live.opened[0])).toContain("<b>PAPER ONLY</b>");
    expect(formatAvwapPaperAlert(live.opened[0])).not.toContain("PAPER TRIAL");
  });

  it("skips a contract over $875 and still records the reason", () => {
    const opened = advanceAvwapTrial(emptyAvwapTrialBook(), [market("AMD", putBars(), quote(90, "put", 9, 10))], NOW);
    expect(opened.opened).toHaveLength(0);
    expect(opened.book.checks.AMD?.put.outcome).toBe("skipped");
    expect(opened.book.checks.AMD?.put.reason).toContain("$875");
    expect(opened.book.skips.some((skip) => skip.reason.includes("$875"))).toBe(true);
  });

  it("sells at the bid once it is 50% above the entry ask and does not send Telegram", async () => {
    const seed = emptyAvwapTrialBook();
    seed.trades = [openTrade("call", 2)];
    const hit = advanceAvwapTrial(seed, [market("AMD", [], quote(110, "call", 3, 3.2))], NOW);
    expect(hit.closed[0]).toMatchObject({ exitReason: "target50", status: "closed" });
    const deliver = vi.fn(async () => ({ sent: true, saved: true }));
    const sendPlain = vi.fn(async () => true);
    const ran = await runAvwapTrial(NOW, deps(seed, deliver, sendPlain, quote(110, "call", 3, 3.2)));
    expect(ran.closed).toBe(1);
    expect(ran.opened).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(sendPlain).not.toHaveBeenCalled();
    expect(ran.logNote).toContain("call closed AMD 110C 2026-11-04 @ bid 3.00");
    expect(formatAvwapTrialLog(ran)).toContain("call closed AMD 110C 2026-11-04 @ bid 3.00");
  });

  it("exits on the expiry-day final scan and does not send Telegram", async () => {
    const expiryNow = new Date("2026-11-04T20:55:00.000Z");
    const seed = emptyAvwapTrialBook();
    seed.trades = [openTrade("put", 2)];
    const hit = advanceAvwapTrial(seed, [market("AMD", [], quote(90, "put", 1, 1.1))], expiryNow);
    expect(hit.closed[0]?.exitReason).toBe("expiry");
    const deliver = vi.fn(async () => ({ sent: true, saved: true }));
    const sendPlain = vi.fn(async () => true);
    const ran = await runAvwapTrial(expiryNow, deps(seed, deliver, sendPlain, quote(90, "put", 1, 1.1)));
    expect(ran.closed).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(sendPlain).not.toHaveBeenCalled();
    expect(ran.logNote).toContain("put closed AMD 90P 2026-11-04 @ bid 1.00");
  });

  it("blocks new trial entries after two losing closes and does not block the live book", () => {
    const book = emptyAvwapTrialBook();
    book.trades = [loss("loss-a", -20), loss("loss-b", -15)];
    const trial = advanceAvwapTrial(book, [market("MSFT", putBars(), quote(90, "put", 2, 2.2))], NOW);
    expect(trial.opened).toHaveLength(0);
    expect(trial.book.checks.MSFT?.put.reason).toContain("two losing");
    const live = advanceAvwapPaper(emptyAvwapPaperBook(), [liveSnapshot()], NOW);
    expect(live.opened).toHaveLength(1);
  });

  it("allows only one open trial position per symbol", () => {
    const book = emptyAvwapTrialBook();
    book.trades = [openTrade("put", 2)];
    const next = advanceAvwapTrial(book, [market("AMD", callBars(), quote(110, "call", 2, 2.2))], NOW);
    expect(next.opened).toHaveLength(0);
    expect(next.book.trades.filter((trade) => trade.status === "open")).toHaveLength(1);
    expect(next.book.checks.AMD?.call.reason).toContain("one paper position");
  });
});

describe("AVWAP trial Telegram", () => {
  it("sends the open alert through the repeat path with a PAPER TRIAL label", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "fixture-webhook-secret");
    const deliver = vi.fn(async (_text: string, _tradeId: string) => ({ sent: true, saved: true }));
    const sendPlain = vi.fn(async (_text: string) => true);
    const ran = await runAvwapTrial(NOW, deps(emptyAvwapTrialBook(), deliver, sendPlain, quote(110, "call", 2, 2.2), callBars()));
    expect(ran.opened).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const text = String(deliver.mock.calls[0][0]);
    expect(text.startsWith("<b>PAPER TRIAL: AMD CALL</b>")).toBe(true);
    expect(text.split("\n")[1]).toBe("AMD <b>CALL</b> $110.00 exp 2026-11-04");
    expect(text).toContain("exp 2026-11-04");
    expect(text).not.toContain("<b>PAPER ONLY</b>");
    expect(deliver.mock.calls[0][1]).toContain("avwap-trial-AMD-call-");
    expect(sendPlain).not.toHaveBeenCalled();
    expect(ran.logNote).toContain("call entered AMD 110C 2026-11-04 @ ask 2.20");
    expect(formatAvwapTrialLog(ran)).toContain("AVWAP trial: 1 new entry");
    expect(formatAvwapTrialLog(ran)).toContain("call entered AMD 110C 2026-11-04 @ ask 2.20");
  });

  it("names the strike and expiration under the paper trial header", () => {
    const trade = {
      ...openTrade("call", 8.5),
      symbol: "MSFT" as const,
      strike: 480,
      expiration: "2026-12-18",
      entryAsk: 8.5,
      entryBid: 7.95,
      contracts: 1,
    };
    const text = formatAvwapTrialAlert(trade);
    const lines = text.split("\n");
    expect(lines[0]).toBe("<b>PAPER TRIAL: MSFT CALL</b>");
    expect(lines[1]).toBe("MSFT <b>CALL</b> $480.00 exp 2026-12-18");
    expect(text).toContain("$480.00");
    expect(text).toContain("exp 2026-12-18");
    expect(text).toContain("Paper only. No order is placed. This is not a live AVWAP book alert.");
    expect(text).toContain("Buy <b>1</b> at the ask $8.50 (bid $7.95)");
    expect(text).toContain("Gap-day anchored VWAP.");
    expect(text).toContain("Sell at the bid when the bid is at least $12.75 (+50%).");
    const put = formatAvwapTrialAlert({ ...openTrade("put", 2), expiration: "2026-11-04&<>" });
    expect(put.split("\n")[1]).toBe("AMD <b>PUT</b> $90.00 exp 2026-11-04&amp;&lt;&gt;");
    expect(put).not.toContain("2026-11-04&<>");
    const note = formatAvwapTrialLogNote(
      {
        MSFT: {
          at: trade.openedAt,
          put: { outcome: "no-signal", reason: "no cross" },
          call: { outcome: "entered", reason: "paper entry, 1 call contract" },
        },
      },
      [trade],
      [],
    );
    expect(note).toContain("MSFT: put no-signal, call entered MSFT 480C 2026-12-18 @ ask 8.50");
    const closed = formatAvwapTrialLogNote({}, [], [{ ...trade, status: "closed", exitBid: 12.75, exitReason: "target50" }]);
    expect(closed).toContain("call closed MSFT 480C 2026-12-18 @ bid 12.75");
    expect(closed).not.toMatch(/token|secret|bearer/i);
  });

  it("stops repeats on ack and when the trial trade is closed", async () => {
    const trade = openTrade("call", 2);
    const text = formatAvwapTrialAlert(trade);
    const first = Date.parse("2026-10-28T14:00:00.000Z");
    const pending = {
      id: "trialalert1",
      tradeId: trade.id,
      text,
      isTest: false,
      firstSentAt: first,
      repeatsSent: 0,
      lastSentAt: first,
      acknowledged: false,
      acknowledgedAt: null,
      ackVia: null,
      messageIds: [4],
      stop: null,
      claimToken: null,
    };
    const due = planAvwapRepeats({ version: 1, alerts: [pending], lockUntil: null }, first + AVWAP_REPEAT_GAP_MS, new Set(), "token");
    expect(due.claims).toHaveLength(1);
    expect(due.claims[0].text).toContain("REPEAT 1 of 5");
    expect(due.claims[0].text).toContain("PAPER TRIAL: AMD CALL");
    expect(due.claims[0].text).toContain("AMD <b>CALL</b> $110.00 exp 2026-11-04");
    expect(due.claims[0].text).toContain("exp 2026-11-04");
    const acked = acknowledgeAvwapAlert(due.book, "trialalert1", first + AVWAP_REPEAT_GAP_MS, "button");
    expect(planAvwapRepeats(acked.book, first + 2 * AVWAP_REPEAT_GAP_MS, new Set(), "next").claims).toHaveLength(0);
    const closed = planAvwapRepeats(
      { version: 1, alerts: [pending], lockUntil: null },
      first + AVWAP_REPEAT_GAP_MS,
      new Set([trade.id]),
      "closed",
    );
    expect(closed.claims).toHaveLength(0);
    expect(closed.book.alerts[0].stop).toBe("closed");

    clearMemoryStoreForTests();
    const stored: AvwapTrialBook = { ...emptyAvwapTrialBook(), trades: [{ ...trade, status: "closed", closedAt: first, pnlDollars: 10 }] };
    await updateAvwapTrial(() => serializeAvwapTrialBook(stored));
    const ids = await closedAvwapTradeIds();
    expect(ids.has(trade.id)).toBe(true);
    expect(emptyAvwapRepeatBook().alerts).toHaveLength(0);
  });
});

describe("AVWAP trial route", () => {
  it("requires a session or bearer and returns the trial book without secrets", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    const denied = await trialGet(new NextRequest("https://options-scan.vercel.app/api/avwap-trial"));
    expect(denied.status).toBe(401);
    const allowed = await trialGet(new NextRequest("https://options-scan.vercel.app/api/avwap-trial", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body.label).toBe("AVWAP trial: AMD, MSFT, AMZN (paper)");
    expect(body.paperOnly).toBe(true);
    expect(body.symbols).toEqual(["AMD", "MSFT", "AMZN"]);
    expect(JSON.stringify(body)).not.toContain("fixture");
    const cron = readFileSync(resolve(process.cwd(), "app/api/cron/route.ts"), "utf8");
    expect(cron.indexOf("await runAvwapTrial")).toBeGreaterThan(cron.indexOf("await runAvwapPaper"));
    expect(cron).toContain("AVWAP trial update failed");
  });
});

function bar(iso: string, c: number): CandleBar {
  return { t: Date.parse(iso), o: c, h: c, l: c, c, v: 100 };
}

function callBars(): CandleBar[] {
  return [bar("2026-10-28T13:30:00.000Z", 100), bar("2026-10-28T13:35:00.000Z", 110)];
}

function putBars(): CandleBar[] {
  return [bar("2026-10-28T13:30:00.000Z", 100), bar("2026-10-28T13:35:00.000Z", 90)];
}

function quote(strike: number, putCall: "put" | "call", bid: number, ask: number): AvwapTrialMark {
  return { expiration: "2026-11-04", strike, bid, ask, putCall };
}

function market(symbol: "AMD" | "MSFT" | "AMZN", bars: CandleBar[], mark: AvwapTrialMark): AvwapTrialMarket {
  return {
    symbol,
    daily: [
      { date: "2026-10-27", open: 100, close: 100 },
      { date: "2026-10-28", open: 102, close: 100 },
    ],
    bars,
    quotes: [mark],
  };
}

function openTrade(putCall: "put" | "call", entryAsk: number): AvwapTrialTrade {
  return {
    id: `avwap-trial-AMD-${putCall}-1`,
    symbol: "AMD",
    putCall,
    strike: putCall === "call" ? 110 : 90,
    expiration: "2026-11-04",
    dte: 7,
    contracts: 1,
    openedAt: NOW.getTime() - 60_000,
    signalAt: 1,
    anchorDate: "2026-10-28",
    gap: 0.02,
    spot: putCall === "call" ? 110 : 90,
    signalClose: putCall === "call" ? 110 : 90,
    signalVwap: 100,
    entryAsk,
    entryBid: entryAsk - 0.1,
    lastBid: entryAsk - 0.1,
    lastAsk: entryAsk,
    lastQuoteAt: NOW.getTime() - 60_000,
    status: "open",
    closedAt: null,
    exitBid: null,
    exitAsk: null,
    exitReason: null,
    exitNote: null,
    pnlDollars: null,
  };
}

function loss(id: string, pnl: number): AvwapTrialTrade {
  const trade = openTrade("put", 2);
  return { ...trade, id, status: "closed", closedAt: NOW.getTime() - 120_000, pnlDollars: pnl, exitReason: "expiry" };
}

function deps(
  seed: AvwapTrialBook,
  deliver: AvwapTrialDeps["deliver"],
  sendPlain: AvwapTrialDeps["sendPlain"],
  mark: AvwapTrialMark,
  bars: CandleBar[] = [],
): AvwapTrialDeps {
  let text: string | null = serializeAvwapTrialBook(seed);
  return {
    daily: async (symbol) => symbol === "AMD"
      ? [bar("2026-10-27T14:00:00.000Z", 100), bar("2026-10-28T13:30:00.000Z", 102)]
      : [],
    minutes: async (symbol) => symbol === "AMD" ? bars : [],
    quotes: async (symbols) => {
      const map = new Map<string, AvwapTrialMark>();
      for (let i = 0; i < symbols.length; i++) map.set(normalizeOptionSymbol(symbols[i]), mark);
      return map;
    },
    readBook: async () => text,
    writeBook: async (change) => {
      const next = change(text);
      if (next == null) return false;
      text = next;
      return true;
    },
    deliver,
    sendPlain,
    repeatsOn: () => true,
  };
}

function liveSnapshot(): AvwapSnapshot {
  return {
    symbol: "SPY",
    daily: [
      { t: Date.parse("2026-10-27T14:00:00.000Z"), open: 440, close: 440 },
      { t: Date.parse("2026-10-28T14:00:00.000Z"), open: 450, close: 448 },
    ],
    bars: [
      { t: Date.parse("2026-10-28T13:30:00.000Z"), o: 449, h: 451, l: 449, c: 450, v: 1000 },
      { t: Date.parse("2026-10-28T13:35:00.000Z"), o: 449, h: 450, l: 447, c: 448, v: 1000 },
    ],
    quotes: [
      { expiration: "2026-11-04", strike: 448, bid: 2, ask: 2.2 },
      { expiration: "2026-11-11", strike: 448, bid: 2.1, ask: 2.3 },
    ],
  };
}
