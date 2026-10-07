import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/brief/route";
import { emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { emptyFeatures } from "@/app/lib/alertFeatures";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/app/lib/auth";
import {
  MARKS_NOTE,
  NO_STORED_MARK_NOTE,
  NO_TRADES_NOTE,
  OPENING_UNRECORDED,
  buildMarketBrief,
} from "@/app/lib/brief";
import { buildHealthReport } from "@/app/lib/healthReport";
import { chicagoDate } from "@/app/lib/marketHours";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import {
  clearMemoryStoreForTests,
  updateAlertBook,
  updateShadowBook,
  updateTradeLog,
  writeScanHealth,
} from "@/app/lib/schwabStore";
import { shadowFromAlert, type ShadowTrade } from "@/app/lib/shadow";
import * as schwab from "@/app/lib/schwab";
import * as quotes from "@/app/lib/tradeQuotes";
import { addTrade, buildTrade, closeTrade, emptyTradeLog, type StoredTrade } from "@/app/lib/trades";
import { middleware } from "@/middleware";

const NOW = new Date("2026-10-07T18:00:00Z");
const ACCOUNT = "99887766";
const LEAK = `account ${ACCOUNT} bot-token-do-not-leak`;

const ENV_KEYS = [
  "HEALTH_TOKEN",
  "CRON_SECRET",
  "SESSION_SECRET",
  "TASTYTRADE_ENABLED",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
  "TASTYTRADE_ACCOUNT_NUMBER",
] as const;

function alert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "1727790000000-SPY|2026-10-16|670|call",
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: Date.parse("2026-10-07T17:30:00.000Z"),
    tradingDay: "2026-10-07",
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
    last: 2,
    flowScore: 4,
    liquidityPasses: true,
    side: "estimated at ask",
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "A",
    reasons: ["do not leak this reason"],
    note: LEAK,
    levels: null,
    levelsNote: null,
    eventLine: null,
    features: {
      ...emptyFeatures(),
      capturedAtAlert: true,
      flowPremium: 162_000,
      likelySide: "buyers",
      openingCheck: "closing",
    },
    rulesVersion: 3,
    openingCheck: {
      status: "closing",
      priorOpenInterest: 500,
      volume: 800,
      nextOpenInterest: 600,
      checkedOn: "2026-10-06",
    },
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

function shadow(over: Partial<ShadowTrade> = {}): ShadowTrade {
  const row = shadowFromAlert(alert({ id: over.id ?? alert().id, ticker: over.ticker ?? "SPY", grade: "A" }));
  if (!row) throw new Error("expected a shadow");
  return { ...row, ...over };
}

function closedPaper(input: {
  id: string;
  ticker: string;
  strike: number;
  expiration: string;
  entry: number;
  exit: number;
  openedAt: number;
  closedAt: number;
  alertId?: string | null;
  grade?: "A" | "B";
}): StoredTrade {
  const built = buildTrade({
    ticker: input.ticker,
    putCall: "call",
    strike: input.strike,
    expiration: input.expiration,
    contracts: 1,
    entryPrice: input.entry,
    alertId: input.alertId ?? null,
    alertGrade: input.grade ?? "B",
    alertVerdict: "TAKE",
    thesis: LEAK,
  }, input.id, new Date(input.openedAt));
  if (!built.ok) throw new Error(built.error);
  const closed = closeTrade(
    addTrade(emptyTradeLog(), built.trade),
    input.id,
    { exitPrice: input.exit, closedAt: input.closedAt, exitNote: LEAK },
    new Date(input.closedAt),
  );
  if (!closed.ok) throw new Error(closed.error);
  return closed.log.trades[0];
}

function openPaper(input: {
  id: string;
  ticker: string;
  strike: number;
  expiration: string;
  entry: number;
  openedAt: number;
  alertId?: string | null;
  grade?: "A" | "B" | null;
}): StoredTrade {
  const built = buildTrade({
    ticker: input.ticker,
    putCall: "call",
    strike: input.strike,
    expiration: input.expiration,
    contracts: 1,
    entryPrice: input.entry,
    alertId: input.alertId ?? null,
    alertGrade: input.grade ?? "A",
    alertVerdict: "TAKE",
    thesis: LEAK,
  }, input.id, new Date(input.openedAt));
  if (!built.ok) throw new Error(built.error);
  return built.trade;
}

describe("market brief", () => {
  it("packs today's alerts, the previous session, open shadows, and stored marks", () => {
    const todayLate = alert();
    const todayEarly = alert({
      id: "1727790000001-QQQ|2026-10-16|500|put",
      ticker: "QQQ",
      putCall: "put",
      strike: 500,
      sentAt: Date.parse("2026-10-07T14:00:00.000Z"),
      grade: "B",
      last: null,
      features: undefined,
      openingCheck: null,
      rulesVersion: null,
      volume: 800,
      mid: 2,
      side: "estimated at bid",
    });
    const yesterday = alert({
      id: "1727790000002-IWM|2026-10-16|240|call",
      ticker: "IWM",
      tradingDay: "2026-10-06",
      sentAt: Date.parse("2026-10-06T15:00:00.000Z"),
      grade: "A",
    });
    const monday = alert({
      id: "1727790000003-XLF|2026-10-16|50|call",
      ticker: "XLF",
      tradingDay: "2026-10-05",
    });
    const skipped = alert({ id: "1727790000004-DIA|2026-10-16|400|call", ticker: "DIA", grade: "C" });

    const spy = shadow({
      openedAt: Date.parse("2026-10-01T15:00:00.000Z"),
      lastMark: 2.2,
      lastMarkSource: "mid",
      lastMarkedAt: Date.parse("2026-10-07T17:45:00.000Z"),
    });
    const flat = shadow({
      id: "1727790000005-QQQ|2026-11-20|480|call",
      alertId: "1727790000005-QQQ|2026-11-20|480|call",
      ticker: "QQQ",
      strike: 480,
      expiration: "2026-11-20",
      grade: "B",
      openedAt: Date.parse("2026-10-06T15:00:00.000Z"),
      lastMark: 2,
      lastMarkSource: "mid",
      lastMarkedAt: Date.parse("2026-10-07T17:00:00.000Z"),
    });
    const unmarked = shadow({
      id: "1727790000006-DIA|2026-11-20|400|call",
      alertId: "1727790000006-DIA|2026-11-20|400|call",
      ticker: "DIA",
      strike: 400,
      expiration: "2026-11-20",
      openedAt: Date.parse("2026-10-07T16:00:00.000Z"),
      lastMark: null,
      lastMarkedAt: null,
    });
    const experiment = shadow({
      id: "1727790000007-GLD|2026-12-18|240|call",
      alertId: "1727790000007-GLD|2026-12-18|240|call",
      ticker: "GLD",
      grade: "test",
      cohort: "experiment",
      status: "open",
      lastMark: 9,
      lastMarkedAt: NOW.getTime(),
    });
    const resolvedToday = shadow({
      id: "1727790000008-NVDA|2026-10-16|180|call",
      alertId: "1727790000008-NVDA|2026-10-16|180|call",
      ticker: "NVDA",
      strike: 180,
      expiration: "2026-10-16",
      status: "closed",
      closedAt: NOW.getTime(),
      exitReason: "profit",
      exitPrice: 2.8,
      pnlFraction: 0.4,
      pnlDollars: 80,
    });
    const resolvedMonday = shadow({
      id: "1727790000009-IWM|2026-10-16|240|call",
      alertId: "iwm-shadow-alert",
      ticker: "IWM",
      strike: 240,
      expiration: "2026-10-16",
      status: "closed",
      closedAt: Date.parse("2026-10-05T18:00:00.000Z"),
      exitReason: "stop",
      exitPrice: 1.5,
      pnlFraction: -0.25,
      pnlDollars: -50,
    });
    const resolvedLastWeek = shadow({
      id: "1727790000010-XLE|2026-10-16|90|call",
      alertId: "1727790000010-XLE|2026-10-16|90|call",
      ticker: "XLE",
      strike: 90,
      expiration: "2026-10-16",
      status: "closed",
      closedAt: Date.parse("2026-10-02T18:00:00.000Z"),
      exitReason: "flat",
      pnlFraction: 0,
      pnlDollars: 0,
    });

    const spyPaper = openPaper({
      id: "t_brief_spy_open1",
      ticker: "SPY",
      strike: 670,
      expiration: "2026-10-16",
      entry: 2,
      openedAt: Date.parse("2026-10-01T15:00:00.000Z"),
      alertId: spy.alertId,
      grade: "A",
    });
    const amdPaper = openPaper({
      id: "t_brief_amd_open1",
      ticker: "AMD",
      strike: 160,
      expiration: "2026-11-20",
      entry: 3,
      openedAt: Date.parse("2026-10-07T15:00:00.000Z"),
      grade: "B",
    });
    const mondayClose = closedPaper({
      id: "t_brief_iwm_close",
      ticker: "META",
      strike: 700,
      expiration: "2026-11-20",
      entry: 2,
      exit: 1,
      openedAt: Date.parse("2026-10-05T14:00:00.000Z"),
      closedAt: Date.parse("2026-10-05T19:00:00.000Z"),
      alertId: "iwm-shadow-alert",
    });

    const scan = buildHealthReport({
      health: {
        ...emptyScanHealth(),
        lastRunAt: Date.parse("2026-10-07T17:00:00.000Z"),
        lastOutcome: "success",
      },
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [todayLate, todayEarly, yesterday],
      openShadows: 3,
      resolvedShadows: 2,
      now: NOW,
    });
    const brief = buildMarketBrief({
      alerts: [todayEarly, skipped, monday, yesterday, todayLate],
      shadows: [spy, flat, unmarked, experiment, resolvedToday, resolvedMonday, resolvedLastWeek],
      trades: [mondayClose, amdPaper, spyPaper],
      scan,
      now: NOW,
    });

    expect(brief.asOf).toBe("2026-10-07T18:00:00.000Z");
    expect(brief.tradingDay).toBe("2026-10-07");
    expect(brief.previousTradingDay).toBe("2026-10-06");
    expect(brief.marksNote).toBe(MARKS_NOTE);
    expect(brief.alerts.today.map((row) => row.ticker)).toEqual(["SPY", "QQQ"]);
    expect(brief.alerts.previousTradingDay.map((row) => row.ticker)).toEqual(["IWM"]);
    expect(brief.alerts.today[0]).toMatchObject({
      ticker: "SPY",
      grade: "A",
      contract: { type: "call", strike: 670, expiry: "2026-10-16", dte: 9 },
      flowPremium: 162_000,
      bid: 1.9,
      ask: 2,
      last: 2,
      likelySide: "buyers",
      likelySideLabel: "Buyers paying up",
      openingCheck: "closing",
      openingCheckLabel: "Likely closing",
      rulesVersion: 3,
      savedAt: "2026-10-07T17:30:00.000Z",
    });
    expect(brief.alerts.today[1]).toMatchObject({
      ticker: "QQQ",
      grade: "B",
      contract: { type: "put", strike: 500 },
      flowPremium: 160_000,
      last: null,
      likelySide: "sellers",
      openingCheck: null,
      openingCheckLabel: OPENING_UNRECORDED,
      rulesVersion: null,
    });

    expect(brief.shadows.open.map((row) => row.ticker)).toEqual(["DIA", "QQQ", "SPY"]);
    expect(brief.shadows.exitRules).toEqual({
      targetPercent: 40,
      stopPercent: 25,
      flatAfterTradingDays: 3,
      flatBandDollars: 1,
    });
    const spyRow = brief.shadows.open.find((row) => row.ticker === "SPY");
    expect(spyRow).toMatchObject({
      grade: "A",
      entryPrice: 2,
      entryAt: "2026-10-01T15:00:00.000Z",
      mark: 2.2,
      markAt: "2026-10-07T17:45:00.000Z",
      daysHeld: 4,
      flat: false,
      flatDayCount: 0,
      paperTrade: true,
    });
    expect(spyRow?.changePercent).toBeCloseTo(10, 6);
    expect(spyRow?.targetPrice).toBeCloseTo(2.8, 6);
    expect(spyRow?.stopPrice).toBeCloseTo(1.5, 6);
    expect(spyRow?.distanceToTarget).toBeCloseTo(0.6, 6);
    expect(spyRow?.distanceToStop).toBeCloseTo(0.7, 6);
    expect(spyRow?.distanceToTargetPercent).toBeCloseTo(30, 6);
    expect(spyRow?.distanceToStopPercent).toBeCloseTo(35, 6);

    const flatRow = brief.shadows.open.find((row) => row.ticker === "QQQ");
    expect(flatRow).toMatchObject({ flat: true, flatDayCount: 1, daysHeld: 1, changePercent: 0, paperTrade: false });
    expect(flatRow?.distanceToTargetPercent).toBeCloseTo(40, 6);
    expect(flatRow?.distanceToStopPercent).toBeCloseTo(25, 6);

    const bare = brief.shadows.open.find((row) => row.ticker === "DIA");
    expect(bare).toMatchObject({
      mark: null,
      markAt: null,
      changePercent: null,
      distanceToTarget: null,
      distanceToStop: null,
      flat: null,
      flatDayCount: null,
      daysHeld: 0,
      targetPrice: 2.8,
    });

    expect(brief.shadows.resolvedToday.map((row) => row.ticker)).toEqual(["NVDA"]);
    expect(brief.shadows.resolvedToday[0]).toMatchObject({
      exitReason: "profit",
      exitLabel: "Profit target",
      resultPercent: 40,
      pnlDollars: 80,
      closedAt: "2026-10-07T18:00:00.000Z",
      paperTrade: false,
    });
    expect(brief.shadows.resolvedThisWeek.map((row) => row.ticker)).toEqual(["NVDA", "IWM"]);
    expect(brief.shadows.resolvedThisWeek[1]).toMatchObject({
      exitReason: "stop",
      exitLabel: "Stop",
      resultPercent: -25,
      paperTrade: true,
    });

    expect(brief.paper.note).toBeNull();
    expect(brief.paper.loggedTrades).toBe(3);
    expect(brief.paper.open.map((row) => row.ticker)).toEqual(["AMD", "SPY"]);
    expect(brief.paper.open[1]).toMatchObject({
      grade: "A",
      mark: 2.2,
      markSource: "stored-shadow",
      unrealizedPnlDollars: 20,
      note: null,
    });
    expect(brief.paper.open[1].changePercent).toBeCloseTo(10, 6);
    expect(brief.paper.open[0]).toMatchObject({
      mark: null,
      markAt: null,
      markSource: null,
      unrealizedPnlDollars: null,
      changePercent: null,
      note: NO_STORED_MARK_NOTE,
    });
    expect(brief.paper.week).toEqual({
      from: "2026-10-05",
      through: "2026-10-07",
      realizedPnlDollars: -100,
      closed: 1,
      drawdownWarningDollars: 1250,
      flagged: false,
      dollarsUntilWarning: 1150,
    });
    expect(brief.paper.todayLossStreak).toBe(0);
    expect(brief.paper.dailyStop).toBe(false);
    expect(brief.paper.dailyStopAfter).toBe(2);
    expect(brief.scan).toEqual(scan);

    const text = JSON.stringify(brief);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain("do not leak");
    expect(text).not.toContain("bot-token");
    expect(text).not.toContain("token");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("GLD");
    expect(text).not.toContain("XLE");
    expect(text).not.toContain("XLF");
  });

  it("uses the newer stored mark and leaves a test-shadow quote unused", () => {
    const older = shadow({
      id: "1727790000011-SPY|2026-10-16|670|call",
      lastMark: 1.5,
      lastMarkedAt: Date.parse("2026-10-06T15:00:00.000Z"),
    });
    const newer = shadow({
      id: "1727790000012-SPY|2026-10-16|670|call",
      alertId: "1727790000012-SPY|2026-10-16|670|call",
      lastMark: 2.2,
      lastMarkedAt: Date.parse("2026-10-07T17:45:00.000Z"),
    });
    const testOnly = shadow({
      id: "1727790000013-AMD|2026-11-20|160|call",
      alertId: "1727790000013-AMD|2026-11-20|160|call",
      ticker: "AMD",
      strike: 160,
      expiration: "2026-11-20",
      grade: "test",
      cohort: "experiment",
      lastMark: 9,
      lastMarkedAt: NOW.getTime(),
    });
    const amd = openPaper({
      id: "t_brief_amd_mark1",
      ticker: "AMD",
      strike: 160,
      expiration: "2026-11-20",
      entry: 3,
      openedAt: Date.parse("2026-10-07T15:00:00.000Z"),
    });
    const spy = openPaper({
      id: "t_brief_spy_mark1",
      ticker: "SPY",
      strike: 670,
      expiration: "2026-10-16",
      entry: 2,
      openedAt: Date.parse("2026-10-06T15:00:00.000Z"),
    });
    const brief = buildMarketBrief({
      alerts: [],
      shadows: [older, newer, testOnly],
      trades: [amd, spy],
      scan: buildHealthReport({
        health: emptyScanHealth(),
        schwabConnected: false,
        tastytradeEnabled: false,
        alerts: [],
        openShadows: 0,
        resolvedShadows: 0,
        now: NOW,
      }),
      now: NOW,
    });
    expect(brief.paper.open.find((row) => row.ticker === "SPY")?.mark).toBe(2.2);
    expect(brief.paper.open.find((row) => row.ticker === "AMD")?.mark).toBeNull();
    expect(brief.shadows.open.map((row) => row.ticker)).toEqual(["SPY", "SPY"]);
  });

  it("keeps the daily stop after two losses and a later win", () => {
    const first = closedPaper({
      id: "t_brief_loss_one1",
      ticker: "SPY",
      strike: 600,
      expiration: "2026-11-20",
      entry: 2,
      exit: 1,
      openedAt: Date.parse("2026-10-07T14:00:00.000Z"),
      closedAt: Date.parse("2026-10-07T15:00:00.000Z"),
    });
    const second = closedPaper({
      id: "t_brief_loss_two1",
      ticker: "QQQ",
      strike: 500,
      expiration: "2026-11-20",
      entry: 2,
      exit: 1,
      openedAt: Date.parse("2026-10-07T15:10:00.000Z"),
      closedAt: Date.parse("2026-10-07T16:00:00.000Z"),
    });
    const laterWin = closedPaper({
      id: "t_brief_win_later",
      ticker: "IWM",
      strike: 240,
      expiration: "2026-11-20",
      entry: 2,
      exit: 3,
      openedAt: Date.parse("2026-10-07T16:10:00.000Z"),
      closedAt: Date.parse("2026-10-07T17:00:00.000Z"),
    });
    const brief = buildMarketBrief({
      alerts: [],
      shadows: [],
      trades: [first, second, laterWin],
      scan: emptyScan(),
      now: NOW,
    });
    expect(brief.paper.todayLossStreak).toBe(2);
    expect(brief.paper.dailyStop).toBe(true);
    expect(brief.paper.week.realizedPnlDollars).toBeCloseTo(-100, 6);
    expect(brief.paper.week.closed).toBe(3);
    expect(brief.paper.note).toBeNull();
  });

  it("flags the week at the drawdown warning and reports how far past it a deeper week is", () => {
    const atLine = closedPaper({
      id: "t_brief_draw_line",
      ticker: "SPY",
      strike: 600,
      expiration: "2026-11-20",
      entry: 20,
      exit: 7.5,
      openedAt: Date.parse("2026-10-06T15:00:00.000Z"),
      closedAt: Date.parse("2026-10-06T19:00:00.000Z"),
    });
    const atWarning = buildMarketBrief({
      alerts: [],
      shadows: [],
      trades: [atLine],
      scan: emptyScan(),
      now: NOW,
    });
    expect(atWarning.paper.week.realizedPnlDollars).toBeCloseTo(-1250, 6);
    expect(atWarning.paper.week.flagged).toBe(true);
    expect(atWarning.paper.week.dollarsUntilWarning).toBeCloseTo(0, 6);
    expect(atWarning.paper.week.drawdownWarningDollars).toBe(1250);

    const past = closedPaper({
      id: "t_brief_draw_past",
      ticker: "SPY",
      strike: 610,
      expiration: "2026-11-20",
      entry: 20,
      exit: 7,
      openedAt: Date.parse("2026-10-07T15:00:00.000Z"),
      closedAt: Date.parse("2026-10-07T17:00:00.000Z"),
    });
    const deeper = buildMarketBrief({
      alerts: [],
      shadows: [],
      trades: [past],
      scan: emptyScan(),
      now: NOW,
    });
    expect(deeper.paper.week.realizedPnlDollars).toBeCloseTo(-1300, 6);
    expect(deeper.paper.week.flagged).toBe(true);
    expect(deeper.paper.week.dollarsUntilWarning).toBeCloseTo(-50, 6);
  });

  it("returns zeros and a note when the trade log is empty", () => {
    const brief = buildMarketBrief({
      alerts: [],
      shadows: [],
      trades: [],
      scan: emptyScan(),
      now: NOW,
    });
    expect(brief.paper.note).toBe(NO_TRADES_NOTE);
    expect(brief.paper.loggedTrades).toBe(0);
    expect(brief.paper.open).toEqual([]);
    expect(brief.paper.todayLossStreak).toBe(0);
    expect(brief.paper.dailyStop).toBe(false);
    expect(brief.paper.week.realizedPnlDollars).toBe(0);
    expect(brief.paper.week.closed).toBe(0);
    expect(brief.paper.week.flagged).toBe(false);
    expect(brief.paper.week.dollarsUntilWarning).toBe(1250);
    expect(brief.alerts.today).toEqual([]);
    expect(brief.shadows.open).toEqual([]);
    expect(brief.shadows.resolvedToday).toEqual([]);
    expect(brief.shadows.resolvedThisWeek).toEqual([]);
  });
});

describe("GET /api/brief", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (!(key in saved)) continue;
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
    clearMemoryStoreForTests();
    vi.restoreAllMocks();
  });

  it("rejects a session cookie and accepts the health bearer, without calling Schwab", async () => {
    rememberEnv(saved);
    process.env.HEALTH_TOKEN = "health-token";
    process.env.CRON_SECRET = "cron-token";
    process.env.SESSION_SECRET = "session-secret-for-brief-test";
    process.env.TASTYTRADE_ENABLED = "true";
    process.env.TASTYTRADE_CLIENT_SECRET = "client-secret";
    process.env.TASTYTRADE_REFRESH_TOKEN = "refresh-token";
    process.env.TASTYTRADE_ACCOUNT_NUMBER = ACCOUNT;
    clearMemoryStoreForTests();

    const chain = vi.spyOn(schwab, "getOptionChain").mockRejectedValue(new Error("brief must not call Schwab"));
    const marked = vi.spyOn(quotes, "quoteContractMarks").mockRejectedValue(new Error("brief must not quote"));

    const day = chicagoDate(new Date());
    const row = alert({ tradingDay: day, sentAt: Date.now() });
    expect(await updateAlertBook(() => JSON.stringify({ version: 1, records: [row], dailyLoss: null }))).toBe(true);
    expect(await writeScanHealth({
      ...emptyScanHealth(),
      lastRunAt: Date.parse("2026-10-07T17:00:00.000Z"),
      lastOutcome: "success",
    })).toBe(true);

    const url = "https://options-scan.vercel.app/api/brief";
    const session = await createSessionToken();
    expect(session).toBeTruthy();
    const cookieOnly = await GET(new NextRequest(url, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
    }));
    expect(cookieOnly.status).toBe(401);
    expect(await cookieOnly.json()).toEqual({ error: "Unauthorized" });

    const cronOnly = await GET(new NextRequest(url, {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(cronOnly.status).toBe(401);

    const allowed = await GET(new NextRequest(url, {
      headers: { authorization: "Bearer health-token", cookie: `${SESSION_COOKIE_NAME}=${session}` },
    }));
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body.alerts.today).toHaveLength(1);
    expect(body.alerts.today[0].ticker).toBe("SPY");
    expect(body.scan.lastCronAt).toBe("2026-10-07T17:00:00.000Z");
    expect(body.scan.lastCronOutcome).toBe("success");
    expect(body.scan.schwabConnected).toBe(false);
    expect(body.scan.tastytradeEnabled).toBe(true);
    expect(body.scan.rulesVersion).toBe(3);
    expect(body.paper.note).toBe(NO_TRADES_NOTE);
    expect(body.marksNote).toBe(MARKS_NOTE);
    const text = JSON.stringify(body);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain("health-token");
    expect(text).not.toContain("cron-token");
    expect(text).not.toContain("refresh-token");
    expect(text).not.toContain("client-secret");
    expect(text).not.toContain("do not leak");
    expect(text).not.toContain("token");
    expect(text).not.toContain("secret");
    expect(chain).not.toHaveBeenCalled();
    expect(marked).not.toHaveBeenCalled();
  });

  it("accepts CRON_SECRET only when HEALTH_TOKEN is unset", async () => {
    rememberEnv(saved);
    delete process.env.HEALTH_TOKEN;
    process.env.CRON_SECRET = "cron-token";
    clearMemoryStoreForTests();
    const url = "https://options-scan.vercel.app/api/brief";
    const missing = await GET(new NextRequest(url));
    expect(missing.status).toBe(401);
    const cron = await GET(new NextRequest(url, {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(cron.status).toBe(200);
    const health = await GET(new NextRequest(url, {
      headers: { authorization: "Bearer health-token" },
    }));
    expect(health.status).toBe(401);
  });
});

describe("brief middleware", () => {
  it("lets the brief through so the route can require the health bearer", async () => {
    const brief = await middleware(new NextRequest("https://options-scan.vercel.app/api/brief"));
    expect(brief.status).not.toBe(401);
    expect(brief.headers.get("location")).toBeNull();
    const trades = await middleware(new NextRequest("https://options-scan.vercel.app/api/trades"));
    expect(trades.status).toBe(401);
  });
});

function emptyScan() {
  return buildHealthReport({
    health: emptyScanHealth(),
    schwabConnected: false,
    tastytradeEnabled: false,
    alerts: [],
    openShadows: 0,
    resolvedShadows: 0,
    now: NOW,
  });
}

function rememberEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (!(key in saved)) saved[key] = process.env[key];
  }
}
