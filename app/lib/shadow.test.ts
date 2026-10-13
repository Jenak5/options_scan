import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { TRADE_RULES } from "@/app/lib/alertConfig";
import { planExits } from "@/app/lib/exits";
import {
  PATH_MARK_QUOTES_PER_RUN,
  replayExit,
  selectPathMarkShadows,
  shadowPathStillNeeded,
  WHAT_IF_SCENARIOS,
  whatIfFromShadows,
} from "@/app/lib/exitWhatIf";
import { SHADOW_QUOTES_PER_RUN } from "@/app/lib/flow";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import {
  clearMemoryStoreForTests,
  readShadowBookText,
  updateAlertBook,
  updateShadowBook,
  updateTradeLog,
} from "@/app/lib/schwabStore";
import {
  addMissingShadows,
  appendShadowPathMark,
  applyShadowQuote,
  emptyShadowBook,
  LAST_WEEK_CALENDAR_DAYS,
  markFromQuote,
  mergeShadowBooks,
  parseShadowBook,
  SHADOW_MARK_CAP,
  shadowFromAlert,
  shadowsToCsv,
  shadowsToQuote,
  summarizeShadows,
  type ShadowTrade,
} from "@/app/lib/shadow";
import { loadShadowPage, openMissingShadows, openScanTickers, runShadowPass, shadowCsv } from "@/app/lib/shadowStore";
import * as tradeQuotes from "@/app/lib/tradeQuotes";
import { addTrade, buildTrade, emptyTradeLog } from "@/app/lib/trades";

const OPEN = new Date("2026-10-01T15:00:00Z");
const THREE_DAYS = new Date("2026-10-06T15:00:00Z");

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "SCHWAB_CLIENT_ID",
  "SCHWAB_CLIENT_SECRET",
  "SCHWAB_REDIRECT_URI",
  "NODE_ENV",
] as const;

const saved: Record<string, string | undefined> = {};

function alert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "1727790000000-SPY|2026-10-16|670|call",
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: OPEN.getTime(),
    tradingDay: "2026-10-01",
    ticker: "SPY",
    putCall: "call",
    strike: 670,
    expiration: "2026-10-16",
    bid: 1.9,
    ask: 2,
    mid: 1.95,
    underlyingPrice: 670,
    volume: 800,
    openInterest: 500,
    flowScore: 10,
    liquidityPasses: true,
    side: "estimated at ask",
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "A",
    reasons: ["Flow"],
    note: "",
    levels: null,
    levelsNote: null,
    eventLine: null,
    maxContracts: 4,
    checkpoints: {
      m15: emptyCheckpoint(),
      h1: emptyCheckpoint(),
      close: emptyCheckpoint(),
    },
    outcome: "pending",
    ...over,
  };
}

function openShadow(over: Partial<ShadowTrade> = {}): ShadowTrade {
  const row = shadowFromAlert(alert());
  if (!row) throw new Error("expected a shadow");
  return { ...row, ...over };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearMemoryStoreForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearMemoryStoreForTests();
});

describe("shadow exits", () => {
  it("buys one contract at the ask and ignores a C", () => {
    const row = shadowFromAlert(alert());
    expect(row?.contracts).toBe(1);
    expect(row?.entryPrice).toBe(2);
    expect(row?.entryPriceSource).toBe("ask");
    expect(shadowFromAlert(alert({ grade: "C" }))).toBeNull();
    const added = addMissingShadows(emptyShadowBook(), [alert(), alert(), alert({ grade: "B", id: "1727790000000-QQQ|2026-10-16|500|put", ticker: "QQQ", putCall: "put" })]);
    expect(added.opened).toBe(2);
    expect(addMissingShadows(added.book, [alert()]).opened).toBe(0);
  });

  it("prefers the midpoint and falls back to the bid", () => {
    expect(markFromQuote({ mid: 2.1, bid: 2 })?.source).toBe("mid");
    expect(markFromQuote({ mid: null, bid: 1.8 })?.source).toBe("bid");
    expect(markFromQuote({ mid: 0, bid: 0 })).toBeNull();
  });

  it("closes the whole contract at the profit target", () => {
    const plan = planExits({ premium: 2, contracts: 1, structure: "single" });
    expect(plan?.takeContracts).toBe(1);
    expect(plan?.profitPrice).toBeCloseTo(2 * (1 + TRADE_RULES.profitTargetFraction), 6);
    const closed = applyShadowQuote(openShadow(), { mid: plan?.profitPrice ?? 0, bid: 2.7 }, OPEN);
    expect(closed.status).toBe("closed");
    expect(closed.exitReason).toBe("profit");
    expect(closed.exitQuote).toBe("mid");
    expect(closed.pnlDollars).toBeCloseTo((closed.exitPrice! - 2) * 100, 6);
    expect(closed.pnlFraction).toBeCloseTo(TRADE_RULES.profitTargetFraction, 6);
    expect(closed.pnlDollars).toBeCloseTo(80, 6);
  });

  it("stops at 25 percent, and tightens the stop when that loss would pass $875", () => {
    const small = planExits({ premium: 2, contracts: 1, structure: "single" });
    expect(small?.stopTightened).toBe(false);
    const stopped = applyShadowQuote(openShadow(), { mid: small?.stopPrice ?? 0, bid: 1.4 }, OPEN);
    expect(stopped.exitReason).toBe("stop");
    expect(stopped.pnlDollars).toBeCloseTo(-50, 6);

    const wide = planExits({ premium: 40, contracts: 1, structure: "single" });
    expect(wide?.stopTightened).toBe(true);
    expect(wide?.stopDollars).toBe(MAX_LOSS_DOLLARS);
    const held = applyShadowQuote(openShadow({ entryPrice: 40 }), { mid: (wide?.stopPrice ?? 0) + 0.05, bid: 31 }, OPEN);
    expect(held.status).toBe("open");
    const capped = applyShadowQuote(openShadow({ entryPrice: 40 }), { mid: wide?.stopPrice ?? 0, bid: 30 }, OPEN);
    expect(capped.exitReason).toBe("stop");
    expect(capped.pnlDollars).toBeCloseTo(-MAX_LOSS_DOLLARS, 4);
  });

  it("exits a flat shadow after 3 trading days and before the last week", () => {
    const flat = applyShadowQuote(openShadow(), { mid: 2, bid: 1.95 }, THREE_DAYS);
    expect(flat.exitReason).toBe("flat");
    expect(flat.tradingDaysHeld).toBe(3);
    expect(flat.pnlDollars).toBe(0);

    const early = applyShadowQuote(openShadow(), { mid: 2, bid: 1.95 }, new Date("2026-10-02T15:00:00Z"));
    expect(early.status).toBe("open");

    const lastWeek = applyShadowQuote(
      openShadow({ expiration: "2026-10-08" }),
      { mid: 2.2, bid: 2.1 },
      OPEN,
    );
    expect(LAST_WEEK_CALENDAR_DAYS).toBe(7);
    expect(lastWeek.exitReason).toBe("expiration");

    const stillRoom = applyShadowQuote(
      openShadow({ expiration: "2026-10-09" }),
      { mid: 2.2, bid: 2.1 },
      OPEN,
    );
    expect(stillRoom.status).toBe("open");

    const stale = applyShadowQuote(
      openShadow({ expiration: "2026-09-20", lastMark: 1.2, lastMarkSource: "bid" }),
      null,
      OPEN,
    );
    expect(stale.exitReason).toBe("expiration");
    expect(stale.exitStale).toBe(true);
    expect(stale.exitPrice).toBe(1.2);
    expect(stale.exitQuote).toBe("bid");
  });

  it("does not tick the 3-day flat stop on Thanksgiving, and does tick the half day", () => {
    const opened = new Date("2026-11-24T15:00:00Z");
    const friday = new Date("2026-11-27T15:00:00Z");
    const monday = new Date("2026-11-30T15:00:00Z");
    const shadow = openShadow({ openedAt: opened.getTime(), expiration: "2026-12-18" });
    const halfDay = applyShadowQuote(shadow, { mid: 2, bid: 1.95 }, friday);
    expect(halfDay.status).toBe("open");
    const closed = applyShadowQuote(shadow, { mid: 2, bid: 1.95 }, monday);
    expect(closed.exitReason).toBe("flat");
    expect(closed.tradingDaysHeld).toBe(3);
  });
});

describe("shadow scorecard", () => {
  it("splits A and B, ticker, and call or put, and leaves out paper trades", () => {
    const win = applyShadowQuote(openShadow(), { mid: 2.8, bid: 2.7 }, OPEN);
    const loss = applyShadowQuote(openShadow({
      id: "1727790000001-QQQ|2026-10-16|500|put",
      alertId: "1727790000001-QQQ|2026-10-16|500|put",
      ticker: "QQQ",
      putCall: "put",
      grade: "B",
    }), { mid: 1.5, bid: 1.4 }, OPEN);
    const paper = applyShadowQuote(openShadow({
      id: "1727790000002-IWM|2026-10-16|240|call",
      alertId: "1727790000002-IWM|2026-10-16|240|call",
      ticker: "IWM",
    }), { mid: 2.8, bid: 2.7 }, OPEN);
    const card = summarizeShadows([win, loss, paper], new Set([paper.alertId]), OPEN);
    expect(card.resolved).toBe(2);
    expect(card.excludedPaper).toBe(1);
    expect(card.tooFew).toBe(true);
    expect(card.sampleNote).toContain("Fewer than 30");
    expect(card.wins).toBe(1);
    expect(card.losses).toBe(1);
    expect(card.winRate).toBe(0.5);
    expect(card.averageWin).toBeCloseTo(80, 6);
    expect(card.averageLoss).toBeCloseTo(50, 6);
    expect(card.totalPnl).toBeCloseTo(30, 6);
    expect(card.byGrade.find((bucket) => bucket.key === "A")?.pnlDollars).toBeCloseTo(80, 6);
    expect(card.byGrade.find((bucket) => bucket.key === "B")?.pnlDollars).toBeCloseTo(-50, 6);
    expect(card.byRight.find((bucket) => bucket.key === "call")?.closed).toBe(1);
    expect(card.byRight.find((bucket) => bucket.key === "put")?.closed).toBe(1);
    expect(card.byTicker.map((bucket) => bucket.key)).toEqual(["QQQ", "SPY"]);
    expect(card.estimateNote).toMatch(/not fills/);
    expect(card.estimateNote).not.toContain("\u2014");
    const csv = shadowsToCsv([win, paper], new Set([paper.alertId]));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("pnlPercent");
    expect(lines.find((line) => line.startsWith(win.id))?.endsWith(",yes")).toBe(true);
    expect(lines.find((line) => line.startsWith(paper.id))?.endsWith(",no")).toBe(true);
  });

  it("quotes a capped set of open contracts and does not reopen a closed shadow", () => {
    const rows: ShadowTrade[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(openShadow({
        id: `1727790000000-T${i}|2026-10-16|100|call`,
        alertId: `1727790000000-T${i}|2026-10-16|100|call`,
        ticker: `T${i}`,
      }));
    }
    expect(shadowsToQuote(rows).length).toBe(SHADOW_QUOTES_PER_RUN);
    const closed = applyShadowQuote(rows[0], { mid: 2.8, bid: 2.7 }, OPEN);
    const merged = mergeShadowBooks(
      { version: 1, records: [closed] },
      { version: 1, records: [{ ...rows[0] }] },
    );
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].status).toBe("closed");
    expect(parseShadowBook(JSON.stringify(merged)).records[0].exitReason).toBe("profit");
  });

  it("keeps marking a live -25% stop so the -35% replay can resolve, without changing the scorecard", () => {
    const stopped = applyShadowQuote(openShadow({ rulesVersion: 3 }), { mid: 1.5, bid: 1.45 }, OPEN);
    expect(stopped.status).toBe("closed");
    expect(stopped.exitReason).toBe("stop");
    expect(stopped.exitPrice).toBeCloseTo(1.5, 6);
    expect(stopped.pnlDollars).toBeCloseTo(-50, 6);
    expect(TRADE_RULES.stopLossFraction).toBe(0.25);
    expect(TRADE_RULES.profitTargetFraction).toBe(0.4);

    const replayInput = {
      entryPrice: stopped.entryPrice,
      openedAt: stopped.openedAt,
      expiration: stopped.expiration,
      marks: stopped.marks ?? [],
    };
    const stop35 = WHAT_IF_SCENARIOS.find((row) => row.id === "stop35");
    const stop25 = WHAT_IF_SCENARIOS.find((row) => row.id === "stop25");
    if (!stop35 || !stop25) throw new Error("missing scenario");
    expect(replayExit(replayInput, stop35)).toBeNull();
    expect(replayExit(replayInput, stop25)?.pnlDollars).toBeCloseTo(-50, 6);
    const before = whatIfFromShadows([stopped]);
    expect(before.scenarios.find((row) => row.id === "stop35")).toMatchObject({ resolved: 0, unresolved: 1 });

    const untouched = applyShadowQuote(stopped, { mid: 1.3, bid: 1.25 }, new Date(OPEN.getTime() + 15 * 60_000));
    expect(untouched).toBe(stopped);

    const later = new Date(OPEN.getTime() + 2 * 60 * 60_000);
    const continued = appendShadowPathMark(stopped, { mid: 1.3, bid: 1.25 }, later);
    const { marks, ...live } = stopped;
    const { marks: path, ...after } = continued;
    expect(after).toEqual(live);
    expect(marks).toEqual([{ at: OPEN.getTime(), price: 1.5 }]);
    expect(path).toEqual([
      { at: OPEN.getTime(), price: 1.5 },
      { at: later.getTime(), price: 1.3 },
    ]);
    expect(path).toHaveLength(2);

    const cardBefore = summarizeShadows([stopped], new Set(), later);
    const cardAfter = summarizeShadows([continued], new Set(), later);
    expect(cardAfter.resolved).toBe(cardBefore.resolved);
    expect(cardAfter.wins).toBe(0);
    expect(cardAfter.losses).toBe(1);
    expect(cardAfter.totalPnl).toBeCloseTo(-50, 6);
    expect(cardAfter.rows[0].exitReason).toBe("stop");
    expect(cardAfter.rows[0].exitPrice).toBeCloseTo(1.5, 6);
    expect(cardAfter.rows[0].pnlDollars).toBeCloseTo(cardBefore.rows[0].pnlDollars ?? 0, 6);
    expect(continued.rulesVersion).toBe(3);

    const continuedReplay = { ...replayInput, marks: path ?? [] };
    expect(replayExit(continuedReplay, stop25)?.pnlDollars).toBeCloseTo(-50, 6);
    expect(replayExit(continuedReplay, stop35)?.pnlDollars).toBeCloseTo(-70, 6);
    const afterReport = whatIfFromShadows([continued]);
    expect(afterReport.scenarios.find((row) => row.id === "stop35")).toMatchObject({ resolved: 1, unresolved: 0 });
    expect(afterReport.included).toBe(1);

    const blank = { ...stopped, id: "blankpath00000001", alertId: "blankpath00000001", marks: [] };
    expect(shadowPathStillNeeded(blank, later)).toBe(false);
    expect(whatIfFromShadows([blank]).skipped).toBe(1);
    expect(whatIfFromShadows([blank]).scenarios.find((row) => row.id === "stop35")?.resolved).toBe(0);
  });

  it("stops the extra path at the trading-day cap, expiry, or when every replay has an exit", () => {
    const stopped = applyShadowQuote(openShadow({ expiration: "2026-12-18", rulesVersion: 3 }), { mid: 1.5, bid: 1.45 }, OPEN);
    expect(shadowPathStillNeeded(stopped, new Date("2026-10-09T15:00:00Z"))).toBe(true);
    expect(shadowPathStillNeeded(stopped, new Date("2026-10-12T15:00:00Z"))).toBe(false);

    const thanksgivingOpen = new Date("2026-11-25T15:00:00Z");
    const overHoliday = applyShadowQuote(openShadow({
      id: "holidaypath0000001",
      alertId: "holidaypath0000001",
      openedAt: thanksgivingOpen.getTime(),
      expiration: "2026-12-18",
    }), { mid: 1.5, bid: 1.45 }, thanksgivingOpen);
    expect(shadowPathStillNeeded(overHoliday, new Date("2026-12-04T15:00:00Z"))).toBe(true);
    expect(shadowPathStillNeeded(overHoliday, new Date("2026-12-07T15:00:00Z"))).toBe(false);

    const expired = applyShadowQuote(openShadow({ expiration: "2026-10-08" }), { mid: 1.5, bid: 1.45 }, OPEN);
    expect(shadowPathStillNeeded(expired, new Date("2026-10-09T15:00:00Z"))).toBe(false);

    const resolved = appendShadowPathMark(stopped, { mid: 1.3, bid: 1.25 }, new Date(OPEN.getTime() + 15 * 60_000));
    expect(shadowPathStillNeeded(resolved, new Date(OPEN.getTime() + 15 * 60_000))).toBe(false);
    const tracked = { ...resolved, quoteTrack: true as const };
    expect(shadowPathStillNeeded(tracked, new Date(OPEN.getTime() + 15 * 60_000))).toBe(true);
    expect(shadowPathStillNeeded(tracked, new Date("2026-10-12T15:00:00Z"))).toBe(false);
    expect(summarizeShadows([tracked], new Set(), OPEN).totalPnl).toBeCloseTo(summarizeShadows([resolved], new Set(), OPEN).totalPnl, 6);

    expect(SHADOW_MARK_CAP).toBeGreaterThanOrEqual(8 * 27);
    let held = stopped;
    for (let i = 0; i < SHADOW_MARK_CAP - 1; i++) {
      held = appendShadowPathMark(held, { mid: 1.4, bid: 1.35 }, new Date(OPEN.getTime() + (i + 1) * 60_000));
    }
    expect(held.marks?.[0]).toEqual({ at: OPEN.getTime(), price: 1.5 });
    expect(held.exitPrice).toBe(stopped.exitPrice);
  });

  it("quotes resolved shadows in the open batch, without taking an open slot or inventing a path", () => {
    const stopped = applyShadowQuote(openShadow({ rulesVersion: 3 }), { mid: 1.5, bid: 1.45 }, OPEN);
    const open: ShadowTrade[] = [];
    for (let i = 0; i < SHADOW_QUOTES_PER_RUN; i++) {
      open.push(openShadow({
        id: `1727790001000-T${i}|2026-10-16|100|call`,
        alertId: `1727790001000-T${i}|2026-10-16|100|call`,
        ticker: `T${i}`,
        strike: 100 + i,
      }));
    }
    const openDue = shadowsToQuote(open.concat([stopped]));
    expect(openDue).toHaveLength(SHADOW_QUOTES_PER_RUN);
    expect(openDue.every((row) => row.status === "open")).toBe(true);
    const withFullBook = selectPathMarkShadows(open.concat([stopped]), openDue, OPEN);
    expect(withFullBook.map((row) => row.id)).toEqual([stopped.id]);

    const waiting: ShadowTrade[] = [];
    for (let i = 0; i < PATH_MARK_QUOTES_PER_RUN + 1; i++) {
      const at = OPEN.getTime() + i * 60_000;
      waiting.push(applyShadowQuote(openShadow({
        id: `pathwait${String(i).padStart(8, "0")}`,
        alertId: `pathwait${String(i).padStart(8, "0")}`,
        ticker: "IWM",
        strike: 200 + i,
        expiration: "2026-12-18",
      }), { mid: 1.5, bid: 1.45 }, new Date(at)));
    }
    const chosen = selectPathMarkShadows(waiting, [], new Date("2026-10-02T15:00:00Z"));
    expect(chosen).toHaveLength(PATH_MARK_QUOTES_PER_RUN);
    expect(chosen.map((row) => row.id)).toEqual(waiting.slice(0, PATH_MARK_QUOTES_PER_RUN).map((row) => row.id));
    expect(PATH_MARK_QUOTES_PER_RUN + SHADOW_QUOTES_PER_RUN).toBeLessThanOrEqual(20);

    const tampered = appendShadowPathMark(stopped, { mid: 1.3, bid: 1.25 }, new Date(OPEN.getTime() + 60_000));
    const merged = mergeShadowBooks(
      { version: 1, records: [stopped] },
      { version: 1, records: [{ ...tampered, exitPrice: 1.3, pnlDollars: -70, status: "open", closedAt: null, exitReason: null }] },
    );
    expect(merged.records[0].status).toBe("closed");
    expect(merged.records[0].exitPrice).toBe(stopped.exitPrice);
    expect(merged.records[0].pnlDollars).toBe(stopped.pnlDollars);
    expect(merged.records[0].marks?.map((mark) => mark.price)).toEqual([1.5, 1.3]);
    const rewritten = mergeShadowBooks(
      { version: 1, records: [stopped] },
      { version: 1, records: [{ ...stopped, marks: [{ at: OPEN.getTime() + 60_000, price: 1.3 }] }] },
    );
    expect(rewritten.records[0].marks).toEqual(stopped.marks);
  });
});

describe("shadow store", () => {
  it("saves an A from the alert book and leaves a paper trade out of the totals", async () => {
    const saved = alert();
    expect(await updateAlertBook(() => JSON.stringify({ version: 1, records: [saved], dailyLoss: null }))).toBe(true);
    const openedOnly = await openMissingShadows();
    expect(openedOnly.opened).toBe(1);
    expect(openedOnly.saved).toBe(true);
    const again = await openMissingShadows();
    expect(again.opened).toBe(0);
    const first = await runShadowPass(OPEN);
    expect(first.opened).toBe(0);
    expect(first.saved).toBe(true);
    const second = await runShadowPass(OPEN);
    expect(second.opened).toBe(0);
    const page = await loadShadowPage(OPEN);
    expect(page.stored).toBe(true);
    expect(page.open).toBe(1);
    expect(page.resolved).toBe(0);

    const built = buildTrade({
      ticker: "SPY",
      putCall: "call",
      strike: 670,
      expiration: "2026-10-16",
      contracts: 1,
      entryPrice: 2,
      alertId: saved.id,
      alertGrade: "A",
      alertVerdict: "TAKE",
    }, "t_shadowpaper12345", OPEN);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(await updateTradeLog(() => JSON.stringify(addTrade(emptyTradeLog(), built.trade)))).toBe(true);
    const excluded = await loadShadowPage(OPEN);
    expect(excluded.excludedPaper).toBe(1);
    expect(excluded.open).toBe(0);
    const csv = await shadowCsv();
    expect(csv).toContain(saved.ticker);
    expect(csv).toContain(",no");
  });

  it("lists open shadow and paper tickers for the cron scan", async () => {
    const openHood = openShadow({ id: "shadow-hood-open", ticker: "HOOD", alertId: "alert-hood" });
    const closedSpy = openShadow({ id: "shadow-spy-closed", status: "closed", closedAt: OPEN.getTime(), exitReason: "stop", exitPrice: 1 });
    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: [openHood, closedSpy] }))).toBe(true);
    const built = buildTrade({
      ticker: "dia",
      putCall: "put",
      strike: 400,
      expiration: "2026-10-16",
      contracts: 1,
      entryPrice: 2,
      alertId: null,
      alertGrade: null,
      alertVerdict: null,
    }, "t_openscandia1234", OPEN);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const closed = { ...built.trade, id: "t_openscanclosed1", ticker: "AAPL", closedAt: OPEN.getTime(), exitPrice: 2 };
    expect(await updateTradeLog(() => JSON.stringify(addTrade(addTrade(emptyTradeLog(), built.trade), closed)))).toBe(true);
    expect(await openScanTickers()).toEqual(["HOOD", "DIA"]);
  });

  it("saves continued marks for a stopped shadow and leaves the live exit in the book", async () => {
    const stopped = applyShadowQuote(openShadow({ rulesVersion: 3 }), { mid: 1.5, bid: 1.45 }, OPEN);
    const stillOpen = openShadow({
      id: "openpath0000000001",
      alertId: "openpath0000000001",
      ticker: "QQQ",
      putCall: "put",
      strike: 500,
      expiration: "2026-11-20",
    });
    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: [stopped, stillOpen] }))).toBe(true);
    const later = new Date(OPEN.getTime() + 15 * 60_000);
    const quoted = vi.spyOn(tradeQuotes, "quoteContractMarks").mockImplementation(async (trades) => {
      expect(trades.every((trade) => trade.closedAt == null)).toBe(true);
      return {
        [stopped.id]: { mid: 1.3, bid: 1.25 },
        [stillOpen.id]: { mid: 2.1, bid: 2.05 },
      };
    });
    const first = await runShadowPass(later);
    expect(quoted).toHaveBeenCalledTimes(1);
    expect(quoted.mock.calls[0][0].map((trade) => trade.id).slice().sort()).toEqual([stillOpen.id, stopped.id].sort());
    expect(first.closed).toBe(0);
    expect(first.quoted).toBe(2);
    const saved = parseShadowBook(await readShadowBookText()).records;
    const closed = saved.find((row) => row.id === stopped.id);
    const open = saved.find((row) => row.id === stillOpen.id);
    expect(closed?.status).toBe("closed");
    expect(closed?.exitReason).toBe("stop");
    expect(closed?.exitPrice).toBeCloseTo(1.5, 6);
    expect(closed?.pnlDollars).toBeCloseTo(-50, 6);
    expect(closed?.pnlFraction).toBeCloseTo(stopped.pnlFraction ?? 0, 6);
    expect(closed?.closedAt).toBe(stopped.closedAt);
    expect(closed?.tradingDaysHeld).toBe(stopped.tradingDaysHeld);
    expect(closed?.rulesVersion).toBe(3);
    expect(closed?.marks?.map((mark) => mark.price)).toEqual([1.5, 1.3]);
    expect(open?.status).toBe("open");
    expect(open?.marks?.map((mark) => mark.price)).toEqual([2.1]);

    const again = await runShadowPass(new Date(later.getTime() + 15 * 60_000));
    expect(again.closed).toBe(0);
    expect(quoted).toHaveBeenCalledTimes(2);
    expect(quoted.mock.calls[1][0].map((trade) => trade.id)).toEqual([stillOpen.id]);
    const reread = parseShadowBook(await readShadowBookText()).records.find((row) => row.id === stopped.id);
    expect(reread?.marks?.map((mark) => mark.price)).toEqual([1.5, 1.3]);
    expect(reread?.pnlDollars).toBeCloseTo(-50, 6);
    quoted.mockRestore();
  });

  it("does not replace an unreadable scorecard", async () => {
    expect(await updateShadowBook(() => JSON.stringify(emptyShadowBook()))).toBe(true);
    expect(await updateShadowBook(() => "{")).toBe(true);
    const kept = await updateShadowBook(() => JSON.stringify(emptyShadowBook()));
    expect(kept).toBe(false);
    expect(await readShadowBookText()).toBe("{");
  });
});
