import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { TIME_STOP_60, VWAP_PUT_TEST } from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import { SHADOW_QUOTES_PER_RUN, type FlowRow } from "@/app/lib/flow";
import { analyzeLearning } from "@/app/lib/learn";
import { chicagoDate, isChicagoMarketHours } from "@/app/lib/marketHours";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import {
  clearMemoryStoreForTests,
  readShadowBookText,
  readTradeLogText,
  updateAlertBook,
  updateShadowBook,
} from "@/app/lib/schwabStore";
import {
  addMissingShadows,
  applyShadowQuote,
  parseShadowBook,
  shadowExitLabel,
  shadowFromAlert,
  shadowsToCsv,
  shadowsToQuote,
  summarizeShadows,
  type ShadowTrade,
} from "@/app/lib/shadow";
import { openMissingShadows, refineStoredTimeStops, saveVwapPuts } from "@/app/lib/shadowStore";
import {
  addTimeStopShadows,
  refineTimeStop,
  syncTimeStops,
  timeStopFromShadow,
  TIME_STOP_MS,
} from "@/app/lib/timeStop60";
import {
  chooseVwapPuts,
  completedSessionMinutes,
  vwapPutShadow,
  vwapRejection,
} from "@/app/lib/vwapPut";

/** Wednesday, 9:05 AM Central. Inside the regular session. */
const NOW = new Date("2026-10-21T14:05:00.000Z");
const MINUTE = 60_000;
const SESSION_OPEN = Date.parse("2026-10-21T13:30:00.000Z");

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

describe("VWAP rejection puts", () => {
  it("fires on a completed minute that closes back under session VWAP", () => {
    expect(isChicagoMarketHours(NOW)).toBe(true);
    expect(vwapRejection(rejectionBars(), NOW.getTime())).toBe(true);
    expect(vwapRejection(rejectionBars().slice(0, 1), NOW.getTime())).toBe(false);

    const stayed = rejectionBars();
    stayed[1] = { ...stayed[1], h: 103, l: 102, c: 102.5 };
    expect(vwapRejection(stayed, NOW.getTime())).toBe(false);

    const later = rejectionBars();
    later.push({ t: SESSION_OPEN + 2 * MINUTE, o: 99, h: 100, l: 98, c: 98.5, v: 100 });
    expect(vwapRejection(later, NOW.getTime())).toBe(false);

    const forming = rejectionBars().slice(0, 1);
    forming.push({ t: NOW.getTime() - 20_000, o: 90, h: 90, l: 89, c: 89, v: 100 });
    expect(completedSessionMinutes(forming, NOW.getTime())).toHaveLength(1);
    expect(vwapRejection(forming, NOW.getTime())).toBe(false);

    const quiet = rejectionBars();
    quiet[1] = { ...quiet[1], v: 0 };
    expect(vwapRejection(quiet, NOW.getTime())).toBe(false);

    const premarket = rejectionBars().map((bar) => ({ ...bar, t: bar.t - 3 * 60 * MINUTE }));
    expect(vwapRejection(premarket, NOW.getTime())).toBe(false);
  });

  it("paper-buys the nearest put on a core ticker and skips the rest", () => {
    const candles = new Map<string, CandleBar[]>([
      ["SPY", rejectionBars()],
      ["QQQ", rejectionBars()],
      ["IWM", rejectionBars()],
      ["HOOD", rejectionBars()],
    ]);
    const rows = [
      putRow({ ticker: "HOOD", id: "HOOD|2026-11-20|40|put", strike: 40 }),
      putRow({ ticker: "SPY", strike: 102, ask: 3, id: "SPY|2026-11-20|102|put" }),
      putRow({ ticker: "SPY", strike: 98, ask: 1.5, dte: 6, expiration: "2026-10-27", id: "SPY|2026-10-27|98|put" }),
      putRow({ ticker: "SPY", strike: 98, ask: 0.4, id: "SPY|2026-11-20|98|cheap" }),
      putRow({ ticker: "SPY", strike: 99, ask: 9, id: "SPY|2026-11-20|99|rich" }),
      putRow({ ticker: "SPY", strike: 99, ask: 2, dte: 21, id: "SPY|2026-11-11|99|put", expiration: "2026-11-11" }),
      putRow({ ticker: "SPY", strike: 99, ask: 2.2, dte: 30, id: "SPY|2026-11-20|99|put" }),
      putRow({ ticker: "QQQ", id: "QQQ|2026-11-20|100|put" }),
      putRow({ ticker: "IWM", id: "IWM|2026-11-20|100|put" }),
      putRow({ ticker: "SPY", putCall: "call", id: "SPY|2026-11-20|100|call" }),
    ];
    const picked = chooseVwapPuts({ rows, candles, now: NOW, existing: [] });
    expect(picked.map((row) => row.ticker)).toEqual(["SPY", "QQQ"]);
    expect(picked[0].id).toBe("SPY|2026-11-11|99|put");
    expect(picked[0].ask * 100).toBeLessThanOrEqual(MAX_LOSS_DOLLARS);
    expect(picked.every((row) => row.putCall === "put" && (row.dte ?? 0) >= VWAP_PUT_TEST.minDte)).toBe(true);

    const closed = new Date("2026-10-21T20:30:00.000Z");
    expect(isChicagoMarketHours(closed)).toBe(false);
    expect(chooseVwapPuts({ rows, candles, now: closed, existing: [] })).toEqual([]);

    const shadow = vwapPutShadow(picked[0], NOW);
    expect(shadow?.cohort).toBe("vwap-put");
    expect(shadow?.grade).toBe("test");
    expect(shadow?.entryPrice).toBe(picked[0].ask);
    expect(shadow?.entryPriceSource).toBe("ask");
    const again = chooseVwapPuts({
      rows,
      candles,
      now: NOW,
      existing: shadow ? [shadow] : [],
    });
    expect(again.map((row) => row.ticker)).toEqual(["QQQ", "IWM"]);
  });

  it("stops, targets, and flats by the same Central close", () => {
    const shadow = vwapPutShadow(putRow(), NOW);
    expect(shadow).not.toBeNull();
    if (!shadow) return;
    const beforeClose = new Date("2026-10-21T19:00:00.000Z");
    const holding = applyShadowQuote(shadow, { mid: 2.2, bid: 2.1 }, beforeClose);
    expect(holding.status).toBe("open");

    const target = applyShadowQuote(shadow, { mid: 2.8, bid: 2.7 }, beforeClose);
    expect(target.exitReason).toBe("profit");
    expect(shadowExitLabel(target.exitReason, target.cohort)).toContain("Profit target");

    const stopped = applyShadowQuote(shadow, { mid: 1.5, bid: 1.45 }, beforeClose);
    expect(stopped.exitReason).toBe("stop");

    const close = new Date("2026-10-21T20:00:00.000Z");
    expect(chicagoDate(close)).toBe("2026-10-21");
    const flat = applyShadowQuote(holding, { mid: 2.15, bid: 2.1 }, close);
    expect(flat.status).toBe("closed");
    expect(flat.exitReason).toBe("flat");
    expect(flat.exitPrice).toBeCloseTo(2.15, 6);
    expect(flat.exitStale).toBe(false);
    expect(shadowExitLabel(flat.exitReason, flat.cohort)).toBe("Flat by the close the same day.");

    const nextDay = applyShadowQuote(holding, { mid: 2.4, bid: 2.3 }, new Date("2026-10-22T15:00:00.000Z"));
    expect(nextDay.exitReason).toBe("flat");
    expect(nextDay.exitPrice).toBeCloseTo(2.2, 6);
    expect(nextDay.exitStale).toBe(true);
  });

  it("saves a few paper puts and does not write a trade", async () => {
    const candles = new Map<string, CandleBar[]>([
      ["SPY", rejectionBars()],
      ["QQQ", rejectionBars()],
      ["IWM", rejectionBars()],
    ]);
    const rows = [
      putRow({ ticker: "SPY", id: "SPY|2026-11-20|100|put" }),
      putRow({ ticker: "QQQ", id: "QQQ|2026-11-20|100|put" }),
      putRow({ ticker: "IWM", id: "IWM|2026-11-20|100|put" }),
    ];
    const savedPuts = await saveVwapPuts(rows, candles, NOW);
    expect(savedPuts).toEqual({ opened: 2, saved: true });
    expect(await readTradeLogText()).toBeNull();
    const book = parseShadowBook(await readShadowBookText());
    expect(book.records).toHaveLength(2);
    expect(book.records.every((row) => row.cohort === "vwap-put" && row.grade === "test")).toBe(true);
    const card = summarizeShadows(book.records, new Set(), NOW);
    expect(await saveVwapPuts(rows, candles, NOW)).toEqual({ opened: 1, saved: true });
    expect(await saveVwapPuts(rows, candles, NOW)).toEqual({ opened: 0, saved: true });
    const filled = parseShadowBook(await readShadowBookText());
    expect(filled.records).toHaveLength(3);
    expect(filled.records.map((row) => row.ticker).sort()).toEqual(["IWM", "QQQ", "SPY"]);
    expect(card.resolved).toBe(0);
    expect(card.open).toBe(0);
    expect(card.byGrade.every((bucket) => bucket.closed === 0)).toBe(true);
    expect(card.vwapPuts.open).toBe(2);
    expect(card.vwapPuts.label).toBe("Test: VWAP rejection puts");
    expect(card.timeStop60.open).toBe(0);
  });
});

describe("60-minute time stop", () => {
  it("records one shadow for a new A or B and leaves older alerts and C grades alone", async () => {
    const saved = alert();
    const existing = shadowFromAlert(saved);
    expect(existing).not.toBeNull();
    if (!existing) return;
    expect(await updateAlertBook(() => JSON.stringify({ version: 1, records: [saved], dailyLoss: null }))).toBe(true);
    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: [existing] }))).toBe(true);
    expect(await openMissingShadows()).toEqual({ opened: 0, saved: true });
    expect(parseShadowBook(await readShadowBookText()).records.map((row) => row.cohort)).toEqual(["ab"]);

    const fresh = alert({ id: "1727790000001-QQQ|2026-10-16|500|put", ticker: "QQQ", putCall: "put", strike: 500 });
    const gradeC = alert({
      id: "1727790000002-IWM|2026-10-16|250|call",
      ticker: "IWM",
      strike: 250,
      grade: "C",
      verdict: "SKIP",
      verdictLabel: "SKIP",
    });
    expect(shadowFromAlert(gradeC)).toBeNull();
    expect(await updateAlertBook(() => JSON.stringify({ version: 1, records: [saved, fresh, gradeC], dailyLoss: null }))).toBe(true);
    const opened = await openMissingShadows();
    expect(opened.opened).toBe(1);
    const records = parseShadowBook(await readShadowBookText()).records;
    const twin = records.find((row) => row.cohort === "time-60");
    const live = records.find((row) => row.id === fresh.id);
    expect(records.filter((row) => row.cohort === "ab")).toHaveLength(2);
    expect(twin?.alertId.startsWith("t60-")).toBe(true);
    expect(twin?.grade).toBe("test");
    expect(twin?.entryPrice).toBe(fresh.ask);
    expect(live?.cohort).toBe("ab");
    expect(live?.grade).toBe("A");
    expect(addTimeStopShadows(records, []).opened).toBe(0);
    expect(await readTradeLogText()).toBeNull();
  });

  it("exits at the target, the stop, or 60 minutes, and a candle stop replaces a live time exit", () => {
    const base = shadowFromAlert(alert());
    expect(base).not.toBeNull();
    if (!base) return;
    const row = timeStopFromShadow(base);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(base.cohort).toBe("ab");
    const openedAt = row.openedAt;

    const target = syncTimeStops([marked(row, openedAt + 10 * MINUTE, 2.8)], new Date(openedAt + 15 * MINUTE))[0];
    expect(target.exitReason).toBe("profit");
    expect(target.studySource).toBe("live");
    expect(base.status).toBe("open");

    const stopped = syncTimeStops([marked(row, openedAt + 10 * MINUTE, 1.5)], new Date(openedAt + 15 * MINUTE))[0];
    expect(stopped.exitReason).toBe("stop");
    expect(stopped.exitPrice).toBeCloseTo(1.5, 6);

    const held = marked(row, openedAt + 30 * MINUTE, 2.1);
    const tooSoon = syncTimeStops([held], new Date(openedAt + 50 * MINUTE))[0];
    expect(tooSoon.status).toBe("open");
    const timed = syncTimeStops([held], new Date(openedAt + TIME_STOP_MS + MINUTE))[0];
    expect(timed.exitReason).toBe("flat");
    expect(timed.exitPrice).toBeCloseTo(2.1, 6);
    expect(timed.closedAt).toBe(openedAt + TIME_STOP_MS);
    expect(shadowExitLabel(timed.exitReason, timed.cohort)).toBe("Flat at 60 minutes.");

    const late = marked(marked(row, openedAt + 10 * MINUTE, 2.1), openedAt + TIME_STOP_MS + MINUTE, 1);
    const ignored = syncTimeStops([late], new Date(openedAt + TIME_STOP_MS + 2 * MINUTE))[0];
    expect(ignored.exitReason).toBe("flat");
    expect(ignored.exitPrice).toBeCloseTo(2.1, 6);

    const stale = syncTimeStops([marked(row, openedAt + TIME_STOP_MS + MINUTE, 1.8)], new Date(openedAt + TIME_STOP_MS + 2 * MINUTE))[0];
    expect(stale.exitReason).toBe("flat");
    expect(stale.exitStale).toBe(true);
    expect(stale.exitPrice).toBeCloseTo(1.8, 6);

    const still = applyShadowQuote(base, { mid: 2.1, bid: 2 }, new Date(openedAt + TIME_STOP_MS + MINUTE));
    expect(still.status).toBe("open");
    expect(still.exitReason).toBeNull();

    const both = {
      t: openedAt + 20 * MINUTE,
      o: 2,
      h: 3,
      l: 1,
      c: 2,
    };
    const fromCandle = refineTimeStop(held, [both], new Date(openedAt + TIME_STOP_MS + MINUTE), true);
    expect(fromCandle.exitReason).toBe("stop");
    expect(fromCandle.exitPrice).toBeCloseTo(1.5, 6);
    expect(fromCandle.studySource).toBe("1m");
    const locked = refineTimeStop(fromCandle, [{ t: openedAt + 5 * MINUTE, o: 3, h: 3, l: 2.9, c: 3 }], new Date(openedAt + TIME_STOP_MS + MINUTE), true);
    expect(locked).toBe(fromCandle);

    const partial = refineTimeStop(
      held,
      [{ t: openedAt + 5 * MINUTE, o: 2.1, h: 2.2, l: 2, c: 2.05 }],
      new Date(openedAt + TIME_STOP_MS + MINUTE),
      false,
    );
    expect(partial.status).toBe("open");
  });

  it("copies the live quote, then prices from stored candles without changing the A or B row", async () => {
    const base = shadowFromAlert(alert());
    expect(base).not.toBeNull();
    if (!base) return;
    const twin = timeStopFromShadow(base);
    expect(twin).not.toBeNull();
    if (!twin) return;
    const quoted = applyShadowQuote(base, { mid: 2.1, bid: 2 }, new Date(base.openedAt + 15 * MINUTE));
    const copied = syncTimeStops([quoted, twin], new Date(base.openedAt + 20 * MINUTE));
    expect(copied[0]).toBe(quoted);
    expect(copied[1].marks?.map((mark) => mark.price)).toEqual([2.1]);
    expect(copied[1].status).toBe("open");

    const due = shadowsToQuote([quoted, copied[1], vwapOpen()]);
    expect(due.map((row) => row.cohort).sort()).toEqual(["ab", "vwap-put"]);
    expect(SHADOW_QUOTES_PER_RUN).toBe(16);

    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: [quoted, copied[1]] }))).toBe(true);
    await refineStoredTimeStops([{
      key: "SPY|2026-10-16|670|call",
      bars: [{ t: base.openedAt + 10 * MINUTE, o: 2, h: 2.1, l: 1.2, c: 1.4 }],
    }], new Date(base.openedAt + TIME_STOP_MS + MINUTE));
    const savedRows = parseShadowBook(await readShadowBookText()).records;
    const live = savedRows.find((row) => row.cohort === "ab");
    const study = savedRows.find((row) => row.cohort === "time-60");
    expect(live?.status).toBe("open");
    expect(live?.exitReason).toBeNull();
    expect(live?.pnlDollars).toBeNull();
    expect(study?.exitReason).toBe("stop");
    expect(study?.studySource).toBe("1m");
    expect(study?.exitPrice).toBeCloseTo(1.5, 6);

    const card = summarizeShadows(savedRows, new Set(), new Date(base.openedAt + TIME_STOP_MS));
    expect(card.open).toBe(1);
    expect(card.resolved).toBe(0);
    expect(card.byGrade.every((bucket) => bucket.closed === 0)).toBe(true);
    expect(card.timeStop60.resolved).toBe(1);
    expect(card.timeStop60.losses).toBe(1);
    expect(card.timeStop60.label).toBe(TIME_STOP_60.label);
    const csv = shadowsToCsv(savedRows, new Set());
    expect(csv).toContain("time-60");
    expect(csv).toContain(",no");
    const liveLine = csv.split("\n").find((line) => line.startsWith(quoted.id));
    expect(liveLine?.endsWith(",yes") || liveLine?.endsWith(",no")).toBe(true);
    expect(liveLine?.includes(",ab,")).toBe(true);

    const report = analyzeLearning({
      shadows: savedRows.concat([vwapClosed()]),
      alerts: [],
      trades: [],
      checksByTradeId: new Map(),
      now: new Date(base.openedAt + TIME_STOP_MS),
    });
    expect(report.resolved).toBe(0);
    expect(report.testResolved).toBe(0);
    expect(report.testOpen).toBe(0);
  });
});

describe("paper studies stay beside the live book", () => {
  it("opens one counted shadow when the alert is new, and the twin is extra", () => {
    const saved = alert();
    const added = addMissingShadows({ version: 1, records: [] }, [saved]);
    expect(added.opened).toBe(1);
    const timed = addTimeStopShadows(added.book.records, added.added);
    expect(timed.opened).toBe(1);
    expect(timed.records).toHaveLength(2);
    const card = summarizeShadows(timed.records, new Set(), NOW);
    expect(card.open).toBe(1);
    expect(card.timeStop60.open).toBe(1);
    expect(card.rows.map((row) => row.grade)).toEqual(["A"]);
  });
});

function rejectionBars(): CandleBar[] {
  return [
    { t: SESSION_OPEN, o: 100, h: 102, l: 100, c: 102, v: 100 },
    { t: SESSION_OPEN + MINUTE, o: 101, h: 101, l: 99, c: 99, v: 100 },
  ];
}

function putRow(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "SPY|2026-11-20|100|put",
    ticker: "SPY",
    putCall: "put",
    strike: 100,
    expiration: "2026-11-20",
    bid: 1.9,
    ask: 2,
    last: 2,
    volume: 100,
    openInterest: 100,
    iv: 0.2,
    delta: -0.5,
    mid: 1.95,
    notionalPremium: 1_000,
    volOiRatio: 0.2,
    volumeOiJump: 0,
    volumeExceedsOi: false,
    previousVolume: null,
    volumeJump: 0,
    otmPoints: 0,
    otmFraction: 0,
    otm: false,
    dte: 30,
    spreadFraction: 0.05,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "Estimated from the last price versus the bid and ask. Not a sweep print.",
    askFraction: 1,
    liquidityPasses: false,
    delayed: false,
    underlyingPrice: 100,
    levels: null,
    prints: EMPTY_PRINTS,
    earnings: null,
    score: 1,
    ...over,
  };
}

function alert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "1727790000000-SPY|2026-10-16|670|call",
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: Date.parse("2026-10-01T15:00:00.000Z"),
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

function marked(row: ShadowTrade, at: number, price: number): ShadowTrade {
  return {
    ...row,
    marks: (row.marks ?? []).concat([{ at, price }]),
    lastMark: price,
    lastMarkedAt: at,
  };
}

function vwapOpen(): ShadowTrade {
  const row = vwapPutShadow(putRow(), NOW);
  if (!row) throw new Error("expected a paper put");
  return row;
}

function vwapClosed(): ShadowTrade {
  const row = vwapOpen();
  return {
    ...row,
    status: "closed",
    closedAt: NOW.getTime(),
    exitPrice: 1.5,
    exitReason: "stop",
    exitQuote: "mid",
    pnlDollars: -50,
    pnlFraction: -0.25,
    tradingDaysHeld: 0,
  };
}
