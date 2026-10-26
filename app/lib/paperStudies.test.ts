import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { TIME_STOP_60, VWAP_PUT_TEST } from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import { SHADOW_QUOTES_PER_RUN, type FlowRow } from "@/app/lib/flow";
import { analyzeLearning } from "@/app/lib/learn";
import { chicagoDate } from "@/app/lib/marketHours";
import { tastytradeStreamerSymbol } from "@/app/lib/optionStreamer";
import { EMPTY_PRINTS } from "@/app/lib/prints";
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
  advancePaperRows,
  firstVwapReject,
  VWAP_PAPER_RULE,
  VWAP_PUT_SECTION_NOTE,
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
  it("keeps the older cross-down row on the live quote exit", () => {
    const shadow = legacyVwap();
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

  it("logs the backtested put once per name and leaves it out of the A and B totals", async () => {
    const bars = rejectSession();
    const signal = firstVwapReject(bars, NOW.getTime());
    expect(signal).not.toBeNull();
    if (!signal) return;
    const rich = tastytradeStreamerSymbol({ ticker: "SPY", expiration: "2026-10-21", strike: 11, putCall: "put" });
    const cheap = tastytradeStreamerSymbol({ ticker: "SPY", expiration: "2026-10-21", strike: 10, putCall: "put" });
    expect(rich && cheap).toBeTruthy();
    if (!rich || !cheap) return;
    const candles = new Map<string, CandleBar[]>([["SPY", bars]]);
    const optionBars = new Map<string, CandleBar[]>([
      [rich, [{ t: signal.entryAt, o: 20, h: 20, l: 20, c: 20 }]],
      [cheap, [{ t: signal.entryAt, o: 2, h: 2, l: 2, c: 2 }]],
    ]);
    const rows = [
      putRow({ ticker: "SPY", strike: 11, expiration: "2026-10-21", id: "SPY|2026-10-21|11|put" }),
      putRow({ ticker: "SPY", strike: 10, expiration: "2026-10-21", id: "SPY|2026-10-21|10|put" }),
    ];
    const savedPuts = await saveVwapPuts(rows, candles, NOW, {
      premarketHigh: new Map([["SPY", signal.vwap]]),
      optionBars,
    });
    expect(savedPuts).toEqual({ opened: 9, saved: true });
    expect(await readTradeLogText()).toBeNull();
    const book = parseShadowBook(await readShadowBookText());
    expect(book.records).toHaveLength(9);
    expect(book.records.every((row) => row.cohort === "vwap-put" && row.paperRuleVersion === VWAP_PAPER_RULE)).toBe(true);
    const priced = book.records.find((row) => row.ticker === "SPY" && row.expiryType === "0DTE");
    expect(priced?.strike).toBe(10);
    expect(priced?.entryPrice).toBe(2);
    expect(priced?.entryWindow).toBe("9:30-10");
    expect(priced?.levelLinedUp).toBe(true);
    expect(priced?.signalAt).toBe(signal.signalAt);
    expect(priced?.entryAt).toBe(signal.entryAt);
    expect(book.records.filter((row) => row.ticker === "SPY" && row.noContract)).toHaveLength(2);
    expect(book.records.filter((row) => row.ticker === "SPX" && row.noContract)).toHaveLength(3);
    expect(book.records.filter((row) => row.ticker === "XSP" && row.noContract)).toHaveLength(3);

    const card = summarizeShadows(book.records, new Set(), NOW);
    expect(card.resolved).toBe(0);
    expect(card.open).toBe(0);
    expect(card.byGrade.every((bucket) => bucket.closed === 0)).toBe(true);
    expect(card.vwapPuts.label).toBe(VWAP_PUT_TEST.label);
    expect(card.vwapPuts.label).toBe("Paper - backtested VWAP put rule");
    expect(card.vwapPuts.note).toBe(VWAP_PUT_SECTION_NOTE);
    expect(card.vwapPuts.open).toBe(1);
    expect(card.vwapPuts.byExpiry?.find((bucket) => bucket.key === "0DTE")).toMatchObject({
      trades: 1,
      open: 1,
      noContract: 2,
    });
    expect(card.vwapPuts.byExpiry?.find((bucket) => bucket.key === "1DTE")?.noContract).toBe(3);
    expect(card.vwapPuts.byExpiry?.find((bucket) => bucket.key === "weekly")?.noContract).toBe(3);
    expect(card.vwapPuts.byLevel?.find((bucket) => bucket.key === "lined")).toMatchObject({ trades: 1, noContract: 8 });
    expect(card.timeStop60.open).toBe(0);

    expect(await saveVwapPuts(rows, candles, NOW, { optionBars })).toEqual({ opened: 0, saved: true });
    expect(await saveVwapPuts(rows, candles, new Date("2026-10-21T20:30:00.000Z"), { optionBars })).toEqual({
      opened: 0,
      saved: true,
    });

    const holidayBars = bars.map((item) => ({
      ...item,
      t: item.t + (Date.parse("2026-11-26T14:30:00.000Z") - SESSION_OPEN),
    }));
    expect(await saveVwapPuts(rows, new Map([["SPY", holidayBars]]), new Date("2026-11-26T15:30:00.000Z"), {
      optionBars,
    })).toEqual({ opened: 0, saved: true });

    const streamer = priced?.optionStreamer;
    expect(streamer).toBe(cheap);
    if (!streamer || priced?.entryAt == null) return;
    const later = new Date("2026-10-21T20:30:00.000Z");
    const advanced = advancePaperRows(book.records, new Map([[streamer, [{
      t: priced.entryAt + 5 * MINUTE,
      o: 2,
      h: 2.8,
      l: 2,
      c: 2.8,
    }]]]), [], later);
    expect(advanced.updated).toBe(1);
    const flat = advanced.records.find((row) => row.id === priced.id);
    expect(flat?.exit60?.reason).toBe("profit");
    expect(flat?.exitFlat?.reason).toBe("profit");
    expect(flat?.pnlDollars).toBeCloseTo(70.06, 2);
    const withLegacy = advanced.records.concat([vwapClosed()]);
    const scored = summarizeShadows(withLegacy, new Set(), later);
    expect(scored.resolved).toBe(0);
    expect(scored.open).toBe(0);
    expect(scored.vwapPuts.resolved).toBe(1);
    expect(scored.vwapPuts.wins).toBe(1);
    expect(scored.vwapPuts.totalPnl).toBeCloseTo(70.06, 2);
    expect(scored.vwapPuts.rows.some((row) => row.id === "vwap-legacy-spy-0001")).toBe(false);
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

function rejectSession(): CandleBar[] {
  const bars: CandleBar[] = [{ t: SESSION_OPEN, o: 20, h: 20, l: 20, c: 20, v: 1 }];
  for (let i = 1; i <= 15; i++) {
    bars.push({ t: SESSION_OPEN + i * MINUTE, o: 10, h: 10, l: 10, c: 10, v: 1 });
  }
  bars.push({ t: SESSION_OPEN + 16 * MINUTE, o: 10, h: 30, l: 10, c: 10, v: 1 });
  bars.push({ t: SESSION_OPEN + 17 * MINUTE, o: 10.5, h: 10.6, l: 10.4, c: 10.5, v: 1 });
  return bars;
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

function legacyVwap(): ShadowTrade {
  return {
    id: "vwap-legacy-spy-0001",
    alertId: "vwap-legacy-spy-0001",
    openedAt: NOW.getTime(),
    ticker: "SPY",
    putCall: "put",
    strike: 100,
    expiration: "2026-11-20",
    grade: "test",
    cohort: "vwap-put",
    experimentLabel: "Test: VWAP rejection puts",
    probeGrade: null,
    features: null,
    rulesVersion: null,
    marks: [],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
    contracts: 1,
    entryPrice: 2,
    entryPriceSource: "ask",
    status: "open",
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    exitQuote: null,
    exitStale: false,
    pnlDollars: null,
    pnlFraction: null,
    tradingDaysHeld: null,
    lastMark: null,
    lastMarkSource: null,
    lastMarkedAt: null,
  };
}

function vwapOpen(): ShadowTrade {
  return legacyVwap();
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
