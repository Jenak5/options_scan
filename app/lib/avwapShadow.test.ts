import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as shadowGet } from "@/app/api/avwap-shadow/route";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  advanceAvwapPaper,
  avwapPnl,
  emptyAvwapPaperBook,
  parseAvwapPaperBook,
  type AvwapMark,
  type AvwapSnapshot,
} from "@/app/lib/avwapPaper";
import { runAvwapPaper, type AvwapPaperDeps } from "@/app/lib/avwapPaperRun";
import {
  AVWAP_SHADOW_BOOK_IDS,
  AVWAP_SHADOW_CUTOFF_MINUTE,
  advanceAvwapShadows,
  avwapShadowSection,
  emptyAvwapShadowBook,
  mergeQuoteRequests,
  nyWeekday,
  parseAvwapShadowBook,
  serializeAvwapShadowBook,
  shadowQuoteRequests,
  signalBarClosesBefore945,
  signalBarIsMonday,
  type AvwapShadowTrade,
} from "@/app/lib/avwapShadow";
import { recordAvwapShadows } from "@/app/lib/avwapShadowRun";
import * as repeatJob from "@/app/lib/avwapRepeatJob";
import { addCalendarDays, newYorkDate } from "@/app/lib/flow";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { clearMemoryStoreForTests, readAvwapShadowText } from "@/app/lib/schwabStore";
import * as telegram from "@/app/lib/telegram";

afterEach(() => {
  clearMemoryStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("New York signal filters", () => {
  it("reads the weekday in New York, including dates that differ from UTC and both DST offsets", () => {
    expect(AVWAP_SHADOW_CUTOFF_MINUTE).toBe(9 * 60 + 45);
    const mondayEst = Date.parse("2026-11-02T14:30:00.000Z");
    const mondayEdt = Date.parse("2026-06-01T13:30:00.000Z");
    const mondayAfterSpring = Date.parse("2026-03-09T13:30:00.000Z");
    const sundayNyMondayUtc = Date.parse("2026-11-02T04:00:00.000Z");
    const mondayNyTuesdayUtc = Date.parse("2026-06-02T03:30:00.000Z");
    expect(nyWeekday(mondayEst)).toBe("Monday");
    expect(nyWeekday(mondayEdt)).toBe("Monday");
    expect(nyWeekday(mondayAfterSpring)).toBe("Monday");
    expect(signalBarIsMonday(mondayEst)).toBe(true);
    expect(nyWeekday(sundayNyMondayUtc)).toBe("Sunday");
    expect(signalBarIsMonday(sundayNyMondayUtc)).toBe(false);
    expect(newYorkDate(new Date(sundayNyMondayUtc))).toBe("2026-11-01");
    expect(nyWeekday(mondayNyTuesdayUtc)).toBe("Monday");
    expect(newYorkDate(new Date(mondayNyTuesdayUtc))).toBe("2026-06-01");
    for (const at of [mondayEst, mondayEdt, mondayAfterSpring, sundayNyMondayUtc, mondayNyTuesdayUtc]) {
      expect(nyWeekday(at)).toBe(intlWeekday(at));
    }
  });

  it("keeps a bar that closes at 9:45 New York and skips a bar that closes at 9:40, in EST and EDT", () => {
    expect(signalBarClosesBefore945(Date.parse("2026-11-02T14:40:00.000Z"))).toBe(false);
    expect(signalBarClosesBefore945(Date.parse("2026-11-02T14:35:00.000Z"))).toBe(true);
    expect(signalBarClosesBefore945(Date.parse("2026-06-01T13:40:00.000Z"))).toBe(false);
    expect(signalBarClosesBefore945(Date.parse("2026-06-01T13:35:00.000Z"))).toBe(true);
    expect(signalBarClosesBefore945(Date.parse("2026-03-09T13:40:00.000Z"))).toBe(false);
    expect(signalBarClosesBefore945(Date.parse("2026-11-04T14:39:00.000Z"))).toBe(true);
    expect(nyClockMinutes(Date.parse("2026-11-02T14:45:00.000Z"))).toBe(9 * 60 + 45);
    expect(nyClockMinutes(Date.parse("2026-06-01T13:45:00.000Z"))).toBe(9 * 60 + 45);
    expect(nyClockMinutes(Date.parse("2026-11-02T14:40:00.000Z"))).toBe(9 * 60 + 40);
    expect(nyClockMinutes(Date.parse("2026-06-01T13:40:00.000Z"))).toBe(9 * 60 + 40);
  });
});

describe("shadow book slots", () => {
  it("lets a later signal fill the slot a 9:40 close left empty, while the other book stays in its trade", () => {
    const nowEarly = new Date("2026-10-28T13:40:00.000Z");
    const earlySnap = chainSnapshot(nowEarly);
    const mainEarly = advanceAvwapPaper(emptyAvwapPaperBook(), [earlySnap], nowEarly);
    const first = advanceAvwapShadows(emptyAvwapShadowBook(), [earlySnap], mainEarly.book, nowEarly);
    expect(mainEarly.opened).toHaveLength(1);
    expect(first.byBook["skip-monday"].opened).toBe(1);
    expect(first.byBook["skip-before-945"].opened).toBe(0);
    expect(first.book.books["skip-before-945"].trades).toHaveLength(0);
    expect(first.book.books["skip-before-945"].notes.SPY).toMatch(/before 9:45/);
    const earlySignal = first.book.signals.find((row) => row.signalAt === Date.parse("2026-10-28T13:35:00.000Z"));
    expect(earlySignal).toMatchObject({
      symbol: "SPY",
      side: "put",
      dayOfWeek: "Wednesday",
      nyDate: "2026-10-28",
      gapDirection: "up",
      entryBid: 2,
      entryAsk: 2.2,
    });
    expect(earlySignal && earlySignal.gap).toBeGreaterThan(0.01);
    expect(earlySignal && earlySignal.vwapDistance).toBeLessThan(0);
    expect(earlySignal?.books.main.action).toBe("taken");
    expect(earlySignal?.books["skip-monday"].action).toBe("taken");
    expect(earlySignal?.books["skip-before-945"].action).toBe("skipped");
    const taken = first.book.books["skip-monday"].trades[0];
    expect(taken.entrySpread).toBeCloseTo(0.2, 2);
    expect(taken.marks).toEqual([{ at: nowEarly.getTime(), bid: 2, ask: 2.2, spread: 0.2 }]);
    expect(taken.side).toBe("put");

    const nowLate = new Date("2026-10-28T14:10:00.000Z");
    const lateSnap = chainSnapshot(nowLate, { bid: 2.1, ask: 2.3 });
    const mainLate = advanceAvwapPaper(mainEarly.book, [lateSnap], nowLate);
    const second = advanceAvwapShadows(first.book, [lateSnap], mainLate.book, nowLate);
    expect(mainLate.opened).toHaveLength(0);
    expect(second.byBook["skip-monday"].opened).toBe(0);
    expect(second.book.books["skip-monday"].trades.filter((trade) => trade.status === "open")).toHaveLength(1);
    expect(second.byBook["skip-before-945"].opened).toBe(1);
    const late = second.book.books["skip-before-945"].trades[0];
    expect(late.signalAt).toBe(Date.parse("2026-10-28T14:05:00.000Z"));
    expect(late.entryBid).toBe(2.1);
    expect(late.entryAsk).toBe(2.3);
    expect(late.entrySpread).toBeCloseTo(0.2, 2);
    const lateSignal = second.book.signals.find((row) => row.signalAt === late.signalAt);
    expect(lateSignal?.dayOfWeek).toBe("Wednesday");
    expect(lateSignal?.books["skip-before-945"].action).toBe("taken");
    expect(lateSignal?.books["skip-monday"].action).toBe("skipped");
    expect(lateSignal?.books.main.action).toBe("skipped");
    expect(lateSignal?.entryBid).toBe(2.1);
    expect(lateSignal?.entryAsk).toBe(2.3);
    const marked = second.book.books["skip-monday"].trades[0];
    expect(marked.marks.map((mark) => mark.at)).toEqual([nowEarly.getTime(), nowLate.getTime()]);
    expect(marked.marks[1]).toMatchObject({ bid: 2.1, ask: 2.3 });
    expect(marked.status).toBe("open");
  });

  it("leaves Monday free and takes the next session's signal in that book", () => {
    const monday = new Date("2026-10-26T13:40:00.000Z");
    const mondaySnap = chainSnapshot(monday, { anchor: "2026-10-26", prev: "2026-10-23", nextDay: "2026-10-27" });
    const first = advanceAvwapShadows(emptyAvwapShadowBook(), [mondaySnap], emptyAvwapPaperBook(), monday);
    expect(signalBarIsMonday(Date.parse("2026-10-26T13:35:00.000Z"))).toBe(true);
    expect(first.book.books["skip-monday"].trades).toHaveLength(0);
    expect(first.book.books["skip-monday"].notes.SPY).toMatch(/Monday/);
    const logged = first.book.signals[0];
    expect(logged.dayOfWeek).toBe("Monday");
    expect(logged.nyDate).toBe("2026-10-26");
    expect(logged.books["skip-monday"].action).toBe("skipped");
    expect(logged.entryBid).toBe(2);
    expect(logged.entryAsk).toBe(2.2);

    const tuesday = new Date("2026-10-27T14:10:00.000Z");
    const tuesdaySnap = chainSnapshot(tuesday, { anchor: "2026-10-26", prev: "2026-10-23", nextDay: "2026-10-27" });
    const second = advanceAvwapShadows(first.book, [tuesdaySnap], emptyAvwapPaperBook(), tuesday);
    expect(second.byBook["skip-monday"].opened).toBe(1);
    expect(second.book.books["skip-monday"].trades[0].signalAt).toBe(Date.parse("2026-10-27T14:05:00.000Z"));
    expect(nyWeekday(Date.parse("2026-10-27T14:05:00.000Z"))).toBe("Tuesday");
    const roundTrip = parseAvwapShadowBook(serializeAvwapShadowBook(second.book));
    expect(roundTrip.books["skip-monday"].trades[0].entryAsk).toBe(2.2);
    expect(parseAvwapShadowBook("{").signals).toEqual([]);
  });

  it("takes a bar that closes at exactly 9:45 AM New York in winter time", () => {
    const now = new Date("2026-11-04T14:45:00.000Z");
    const snap = boundarySnapshot();
    const main = advanceAvwapPaper(emptyAvwapPaperBook(), [snap], now);
    const result = advanceAvwapShadows(emptyAvwapShadowBook(), [snap], main.book, now);
    expect(signalBarClosesBefore945(Date.parse("2026-11-04T14:40:00.000Z"))).toBe(false);
    expect(result.byBook["skip-before-945"].opened).toBe(1);
    expect(result.book.books["skip-before-945"].trades[0].signalCloseAt).toBe(Date.parse("2026-11-04T14:45:00.000Z"));
    expect(result.book.signals[0].dayOfWeek).toBe("Wednesday");
    expect(result.book.signals[0].books["skip-before-945"].action).toBe("taken");
  });
});

describe("shadow exits", () => {
  it("records each scan quote, sells at +50%, and does not stop out on a lower bid", () => {
    const entryAt = Date.parse("2026-10-28T14:10:00.000Z");
    const book = bookWith(heldTrade(entryAt));
    const marked = advanceAvwapShadows(book, [quoteSnap(2.4, 2.55)], emptyAvwapPaperBook(), new Date("2026-10-28T15:00:00.000Z"));
    const open = marked.book.books["skip-monday"].trades[0];
    expect(open.status).toBe("open");
    expect(open.exitReason).toBeNull();
    expect(open.marks).toHaveLength(2);
    expect(open.marks[1]).toMatchObject({ bid: 2.4, ask: 2.55, spread: 0.15 });

    const stopped = advanceAvwapShadows(marked.book, [quoteSnap(0.4, 0.55)], emptyAvwapPaperBook(), new Date("2026-10-28T16:00:00.000Z"));
    expect(stopped.book.books["skip-monday"].trades[0].status).toBe("open");
    expect(stopped.closed).toBe(0);

    const targetAt = Date.parse("2026-10-28T17:00:00.000Z");
    const target = advanceAvwapShadows(stopped.book, [quoteSnap(3.3, 3.4)], emptyAvwapPaperBook(), new Date(targetAt));
    const closed = target.book.books["skip-monday"].trades[0];
    expect(closed.status).toBe("closed");
    expect(closed.exitReason).toBe("target50");
    expect(closed.exitBid).toBe(3.3);
    expect(closed.exitAsk).toBe(3.4);
    expect(closed.pnlDollars).toBe(avwapPnl(2.2, 3.3, 1));
    expect(closed.marks.map((mark) => mark.bid)).toEqual([2, 2.4, 0.4, 3.3]);
    expect(closed.marks[closed.marks.length - 1].at).toBe(targetAt);
  });

  it("sells at the expiry final scan, including 12:55 PM New York on an early close", () => {
    const regular = advanceAvwapShadows(
      bookWith(heldTrade(Date.parse("2026-11-04T15:00:00.000Z"), "2026-11-04")),
      [quoteSnap(1, 1.1, "2026-11-04")],
      emptyAvwapPaperBook(),
      new Date("2026-11-04T20:54:00.000Z"),
    );
    expect(regular.book.books["skip-monday"].trades[0].status).toBe("open");
    const expiry = advanceAvwapShadows(
      regular.book,
      [quoteSnap(1, 1.1, "2026-11-04")],
      emptyAvwapPaperBook(),
      new Date("2026-11-04T20:55:00.000Z"),
    );
    expect(expiry.book.books["skip-monday"].trades[0]).toMatchObject({ status: "closed", exitReason: "expiry", exitBid: 1, exitAsk: 1.1 });

    const earlyOpen = advanceAvwapShadows(
      bookWith(heldTrade(Date.parse("2026-11-27T15:00:00.000Z"), "2026-11-27")),
      [quoteSnap(1, 1.1, "2026-11-27")],
      emptyAvwapPaperBook(),
      new Date("2026-11-27T17:54:00.000Z"),
    );
    expect(earlyOpen.book.books["skip-monday"].trades[0].status).toBe("open");
    const early = advanceAvwapShadows(
      earlyOpen.book,
      [quoteSnap(1, 1.1, "2026-11-27")],
      emptyAvwapPaperBook(),
      new Date("2026-11-27T17:55:00.000Z"),
    );
    expect(early.book.books["skip-monday"].trades[0]).toMatchObject({ status: "closed", exitReason: "expiry", exitBid: 1 });
  });

  it("counts wins, losses, and months from closed trades", () => {
    const win = closedTrade("win", Date.parse("2026-10-28T19:00:00.000Z"), 120);
    const loss = closedTrade("loss", Date.parse("2026-11-04T20:00:00.000Z"), -40);
    const section = avwapShadowSection(bookWith(win, loss), true);
    const book = section.books[0];
    expect(section.telegram).toBe(false);
    expect(section.paperOnly).toBe(true);
    expect(book.wins).toBe(1);
    expect(book.losses).toBe(1);
    expect(book.winRate).toBe(0.5);
    expect(book.netPnlDollars).toBe(80);
    expect(book.byMonth).toEqual([
      { month: "2026-11", closed: 1, wins: 0, losses: 1, flats: 0, winRate: 0, netPnlDollars: -40 },
      { month: "2026-10", closed: 1, wins: 1, losses: 0, flats: 0, winRate: 1, netPnlDollars: 120 },
    ]);
  });
});

describe("shadow scan wiring", () => {
  it("does not send Telegram, and a dead quote read does not block the live pass", async () => {
    const send = vi.spyOn(telegram, "sendTelegramAlert").mockResolvedValue(true);
    const deliver = vi.spyOn(repeatJob, "deliverAvwapOpenAlert").mockResolvedValue({ sent: true, saved: true });
    const deps = memoryDeps();
    let quoteCalls = 0;
    const quote = deps.deps.quotes;
    deps.deps.quotes = async (symbols) => {
      quoteCalls += 1;
      return quote(symbols);
    };
    const ran = await runAvwapPaper(new Date("2026-10-28T13:40:00.000Z"), deps.deps);
    expect(ran.opened).toBe(1);
    expect(ran.shadowLog).toContain("no Telegram");
    expect(ran.shadowLog).toContain("skip-monday 1 new");
    expect(ran.shadowLog).toContain("skip-before-945 0 new");
    expect(deps.sent).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(quoteCalls).toBe(1);
    const shadow = parseAvwapShadowBook(await readAvwapShadowText());
    expect(shadow.books["skip-monday"].trades).toHaveLength(1);
    expect(shadow.books["skip-before-945"].trades).toHaveLength(0);
    const main = parseAvwapPaperBook(deps.text());
    expect(main.trades[0].id.startsWith("avwap-SPY-")).toBe(true);
    expect(main.trades[0].entryAsk).toBe(2.2);
    expect(main.trades.some((trade) => trade.id.includes("shadow"))).toBe(false);

    const dead = memoryDeps();
    dead.deps.quotes = async () => {
      throw new Error("Schwab backup down");
    };
    const blocked = await runAvwapPaper(new Date("2026-10-28T18:40:00.000Z"), dead.deps);
    expect(blocked.saved).toBe(true);
    expect(blocked.opened).toBe(0);
    expect(blocked.shadowLog).toContain("no Telegram");
    expect(dead.sent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();

    const quiet = await recordAvwapShadows(new Date("2026-10-28T13:40:00.000Z"), [], emptyAvwapPaperBook());
    expect(quiet).toContain("PAPER ONLY, no Telegram");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps shadow requests on the same put quote list and leaves the other books alone", () => {
    const now = new Date("2026-10-28T13:40:00.000Z");
    const snap = chainSnapshot(now);
    const extra = shadowQuoteRequests(emptyAvwapShadowBook(), [snap], now);
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((item) => item.occ.includes("P"))).toBe(true);
    const merged = mergeQuoteRequests([{ occ: "MAIN", symbol: "SPY", expiration: "2026-11-04", strike: 1 }], extra);
    expect(merged[0].occ).toBe("MAIN");
    expect(merged.filter((item) => item.occ === extra[0].occ)).toHaveLength(1);
    expect(AVWAP_SHADOW_BOOK_IDS).toEqual(["skip-monday", "skip-before-945"]);
    const files = [
      "app/lib/avwapShadow.ts",
      "app/lib/avwapShadowRun.ts",
      "app/api/avwap-shadow/route.ts",
      "app/components/AvwapShadowPanel.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/sendTelegram|deliverAvwap/);
      expect(source).not.toMatch(/from "@\/app\/lib\/schwab"/);
      expect(source).not.toMatch(/AVWAP_TRIAL_SYMBOLS|AMD|MSFT|AMZN/);
    }
    const cron = readFileSync(resolve(process.cwd(), "app/api/cron/route.ts"), "utf8");
    expect(cron).toContain("Scan paused: AVWAP only");
    expect(cron.indexOf("await runAvwapTrial")).toBeGreaterThan(cron.indexOf("await runAvwapPaper"));
    expect(cron).toContain("shadowLog");
    const vercel = readFileSync(resolve(process.cwd(), "vercel.json"), "utf8");
    expect(vercel).toContain('"maxDuration": 300');
  });
});

describe("AVWAP shadow route", () => {
  it("requires a session or bearer and returns both books without secrets", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    const denied = await shadowGet(new NextRequest("https://options-scan.vercel.app/api/avwap-shadow"));
    expect(denied.status).toBe(401);
    const allowed = await shadowGet(new NextRequest("https://options-scan.vercel.app/api/avwap-shadow", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body.label).toBe("AVWAP shadow paper");
    expect(body.paperOnly).toBe(true);
    expect(body.telegram).toBe(false);
    expect(body.books.map((book: { id: string }) => book.id)).toEqual(["skip-monday", "skip-before-945"]);
    expect(JSON.stringify(body)).not.toContain("cron-token");
  });
});

function intlWeekday(at: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(new Date(at));
}

function nyClockMinutes(at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

function bar(iso: string, o: number, h: number, l: number, c: number): CandleBar {
  return { t: Date.parse(iso), o, h, l, c, v: 1000 };
}

function chainBars(anchor: string, nextDay: string | null): CandleBar[] {
  const first = `${anchor}T13:30:00.000Z`;
  const second = `${anchor}T13:35:00.000Z`;
  const bars = [
    bar(first, 449, 451, 449, 450),
    bar(second, 449, 450, 447, 448),
  ];
  const laterDay = nextDay ?? anchor;
  bars.push(bar(`${laterDay}T14:00:00.000Z`, 452, 452, 452, 452));
  bars.push(bar(`${laterDay}T14:05:00.000Z`, 450, 450, 446, 447));
  return bars;
}

function ladder(anchor: string, bid: number, ask: number): AvwapMark[] {
  const marks: AvwapMark[] = [];
  for (let dte = 4; dte <= 16; dte++) {
    const expiration = addCalendarDays(anchor, dte);
    for (let strike = 440; strike <= 460; strike++) marks.push({ expiration, strike, bid, ask });
  }
  return marks;
}

function chainSnapshot(
  now: Date,
  options: { bid?: number; ask?: number; anchor?: string; prev?: string; nextDay?: string | null } = {},
): AvwapSnapshot {
  const anchor = options.anchor ?? "2026-10-28";
  const prev = options.prev ?? "2026-10-27";
  const nextDay = options.nextDay === undefined ? null : options.nextDay;
  const daily = [
    { date: prev, open: 438, close: 440 },
    { date: anchor, open: 450, close: 448 },
  ];
  if (nextDay) daily.push({ date: nextDay, open: 449, close: 447 });
  return {
    symbol: "SPY",
    daily,
    bars: chainBars(anchor, nextDay),
    quotes: ladder(anchor, options.bid ?? 2, options.ask ?? 2.2),
  };
}

function boundarySnapshot(): AvwapSnapshot {
  return {
    symbol: "SPY",
    daily: [
      { date: "2026-11-03", open: 438, close: 440 },
      { date: "2026-11-04", open: 450, close: 448 },
    ],
    bars: [
      bar("2026-11-04T14:30:00.000Z", 449, 451, 449, 450),
      bar("2026-11-04T14:40:00.000Z", 449, 450, 447, 448),
    ],
    quotes: ladder("2026-11-04", 2, 2.2),
  };
}

function heldTrade(openedAt: number, expiration = "2026-11-04"): AvwapShadowTrade {
  return {
    id: "avwap-shadow-skip-monday-SPY-1",
    bookId: "skip-monday",
    symbol: "SPY",
    side: "put",
    putCall: "put",
    strike: 448,
    expiration,
    dte: 7,
    contracts: 1,
    openedAt,
    signalAt: openedAt - 300_000,
    signalCloseAt: openedAt,
    anchorDate: "2026-10-28",
    gap: 0.02,
    spot: 448,
    signalClose: 447,
    signalVwap: 449,
    entryBid: 2,
    entryAsk: 2.2,
    entrySpread: 0.2,
    marks: [{ at: openedAt, bid: 2, ask: 2.2, spread: 0.2 }],
    lastBid: 2,
    lastAsk: 2.2,
    lastQuoteAt: openedAt,
    status: "open",
    closedAt: null,
    exitBid: null,
    exitAsk: null,
    exitReason: null,
    exitNote: null,
    pnlDollars: null,
  };
}

function closedTrade(id: string, closedAt: number, pnl: number): AvwapShadowTrade {
  return {
    ...heldTrade(closedAt - 60_000),
    id,
    status: "closed",
    closedAt,
    exitBid: 1,
    exitAsk: 1.1,
    exitReason: pnl > 0 ? "target50" : "expiry",
    pnlDollars: pnl,
  };
}

function bookWith(...trades: AvwapShadowTrade[]) {
  const book = emptyAvwapShadowBook();
  book.books["skip-monday"].trades = trades;
  return book;
}

function quoteSnap(bid: number, ask: number, expiration = "2026-11-04"): AvwapSnapshot {
  return {
    symbol: "SPY",
    daily: [],
    bars: [],
    quotes: [{ expiration, strike: 448, bid, ask }],
  };
}

function memoryDeps(): { deps: AvwapPaperDeps; text: () => string | null; sent: ReturnType<typeof vi.fn> } {
  let text: string | null = null;
  const sent = vi.fn(async () => true);
  const deps: AvwapPaperDeps = {
    daily: async (symbol) => (symbol === "SPY" ? [
      bar("2026-10-27T14:00:00.000Z", 438, 441, 437, 440),
      bar("2026-10-28T14:00:00.000Z", 450, 451, 447, 448),
    ] : [
      bar("2026-10-27T14:00:00.000Z", 100, 101, 99, 100),
      bar("2026-10-28T14:00:00.000Z", 100.4, 101, 100, 100.5),
    ]),
    minutes: async (symbol) => (symbol === "SPY" ? [
      bar("2026-10-28T13:30:00.000Z", 449, 451, 449, 450),
      bar("2026-10-28T13:35:00.000Z", 449, 450, 447, 448),
    ] : []),
    quotes: async (symbols) => {
      const map = new Map<string, { bid: number; ask: number }>();
      for (let i = 0; i < symbols.length; i++) map.set(normalizeOptionSymbol(symbols[i]), { bid: 2, ask: 2.2 });
      return map;
    },
    readBook: async () => text,
    writeBook: async (change) => {
      text = change(text);
      return true;
    },
    send: sent,
  };
  return { deps, text: () => text, sent };
}
