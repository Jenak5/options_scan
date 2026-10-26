import { describe, expect, it } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import { parseShadowBook, shadowsToQuote, type ShadowTrade } from "@/app/lib/shadow";
import {
  collectSignals,
  completedSessionMinutes,
  entryWindowOf,
  firstVwapReject,
  levelLinesUp,
  paperPnl,
  scorePaperExits,
  selectPut,
  VWAP_PAPER_RULE,
  vwapPaperEntriesOpen,
  weeklyFriday,
  buildPaperRows,
} from "@/app/lib/vwapPut";

const MINUTE = 60_000;
const SESSION_OPEN = Date.parse("2026-10-21T13:30:00.000Z");
const NOW = new Date("2026-10-21T14:05:00.000Z");

function bar(index: number, price: number, over: Partial<CandleBar> = {}): CandleBar {
  return { t: SESSION_OPEN + index * MINUTE, o: price, h: price, l: price, c: price, v: 1, ...over };
}

/** One bar above VWAP, then `below` closes under it, then a touch that closes back under. */
function rejectFixture(below: number, touch: Partial<CandleBar> = {}): CandleBar[] {
  const bars = [bar(0, 20)];
  for (let i = 1; i <= below; i++) bars.push(bar(i, 10));
  bars.push(bar(below + 1, 10, { h: 30, l: 10, c: 10, ...touch }));
  bars.push(bar(below + 2, 10.5));
  return bars;
}

describe("backtested VWAP rejection", () => {
  it("fires after 15 closes under VWAP when the next bar touches and closes back under", () => {
    const bars = rejectFixture(15);
    const now = bars[17].t + MINUTE;
    const signal = firstVwapReject(bars, now);
    expect(signal).not.toBeNull();
    if (!signal) return;
    expect(signal.signalAt).toBe(bars[16].t);
    expect(signal.entryAt).toBe(bars[17].t);
    expect(signal.entryOpen).toBe(10.5);
    expect(signal.ready).toBe(true);
    expect(signal.window).toBe("9:30-10");
    const touchTypical = (30 + 10 + 10) / 3;
    const vwap = (20 + 15 * 10 + touchTypical) / 17;
    expect(signal.vwap).toBeCloseTo(vwap, 6);
    expect(signal.vwap).toBeGreaterThan(10);
    expect(bars[16].h).toBeGreaterThanOrEqual(signal.vwap);
    expect(bars[16].c).toBeLessThan(signal.vwap);
  });

  it("does not fire on 14 closes, a close through VWAP, or a bar that never trades up to VWAP", () => {
    expect(firstVwapReject(rejectFixture(14), NOW.getTime())).toBeNull();

    const reset = rejectFixture(15);
    reset[8] = bar(8, 30);
    expect(firstVwapReject(reset, NOW.getTime())).toBeNull();

    const missed = rejectFixture(15, { h: 10.2, l: 10, c: 10 });
    expect(firstVwapReject(missed, NOW.getTime())).toBeNull();

    const through = rejectFixture(15, { h: 30, l: 10, c: 30 });
    expect(firstVwapReject(through, NOW.getTime())).toBeNull();
  });

  it("weights a zero-volume bar as 1 and ignores premarket and the bar still forming", () => {
    const quiet = rejectFixture(15).map((item) => ({ ...item, v: 0 }));
    const now = quiet[17].t + MINUTE;
    const signal = firstVwapReject(quiet, now);
    expect(signal?.vwap).toBeCloseTo((20 + 15 * 10 + (30 + 10 + 10) / 3) / 17, 6);

    const heavy = rejectFixture(15);
    heavy[0] = { ...heavy[0], v: 0 };
    for (let i = 1; i < heavy.length; i++) heavy[i] = { ...heavy[i], v: 100 };
    const mixed = firstVwapReject(heavy, now);
    const touchTypical = (30 + 10 + 10) / 3;
    const floored = (20 * 1 + 15 * 10 * 100 + touchTypical * 100) / (1 + 15 * 100 + 100);
    const skipped = (15 * 10 * 100 + touchTypical * 100) / (15 * 100 + 100);
    expect(mixed?.vwap).toBeCloseTo(floored, 4);
    expect(mixed?.vwap).not.toBeCloseTo(skipped, 2);

    const premarket = rejectFixture(15).map((item) => ({ ...item, t: item.t - 3 * 60 * MINUTE }));
    expect(firstVwapReject(premarket, NOW.getTime())).toBeNull();

    const forming = rejectFixture(15);
    expect(completedSessionMinutes(forming, forming[16].t + 30_000)).toHaveLength(16);
    expect(firstVwapReject(forming, forming[16].t + 30_000)).toBeNull();
  });

  it("keeps the first signal of the day and stops new signals at 2:30 PM Central", () => {
    const bars = rejectFixture(15);
    const laterTouch = bar(30, 10, { h: 40, l: 10, c: 10 });
    bars.push(laterTouch);
    const signal = firstVwapReject(bars, laterTouch.t + 2 * MINUTE);
    expect(signal?.signalAt).toBe(bars[16].t);

    const late = sessionUntil(361, { h: 40, l: 10, c: 10 });
    expect(firstVwapReject(late, late[late.length - 1].t + 2 * MINUTE)).toBeNull();

    const last = sessionUntil(360, { h: 40, l: 10, c: 10 });
    const caught = firstVwapReject(last, last[360].t + 2 * MINUTE);
    expect(caught?.signalAt).toBe(last[360].t);
  });

  it("buckets the signal minute in Eastern time", () => {
    expect(entryWindowOf(Date.parse("2026-10-21T13:30:00.000Z"))).toBe("9:30-10");
    expect(entryWindowOf(Date.parse("2026-10-21T14:00:00.000Z"))).toBe("10-11:30");
    expect(entryWindowOf(Date.parse("2026-10-21T15:30:00.000Z"))).toBe("11:30-2");
    expect(entryWindowOf(Date.parse("2026-10-21T18:00:00.000Z"))).toBe("2-close");
  });

  it("copies SPY onto SPX and XSP and lines a level up within 0.15 percent", () => {
    const bars = rejectFixture(15);
    const now = new Date(bars[17].t + MINUTE);
    const signals = collectSignals({ candles: new Map([["SPY", bars]]), now, existing: [] });
    expect(signals.map((row) => row.ticker)).toEqual(["SPY", "SPX", "XSP"]);
    expect(signals.map((row) => row.root)).toEqual(["SPY", "SPXW", "XSP"]);
    expect(signals[1].spot).toBeNull();
    expect(signals[0].spot).toBe(10.5);
    expect(signals.every((row) => row.levelLinedUp === false)).toBe(true);

    const lined = collectSignals({
      candles: new Map([["SPY", bars]]),
      now,
      existing: [],
      premarketHigh: new Map([["SPY", signals[0].vwap]]),
    });
    expect(lined.every((row) => row.levelLinedUp)).toBe(true);

    const again = collectSignals({
      candles: new Map([["SPY", bars]]),
      now,
      existing: lined.map((row) => ({
        ticker: row.ticker,
        cohort: "vwap-put" as const,
        paperRuleVersion: VWAP_PAPER_RULE,
        signalAt: row.signalAt,
        openedAt: row.entryAt,
      })),
    });
    expect(again).toEqual([]);

    expect(levelLinesUp(100, 100.15, null)).toBe(true);
    expect(levelLinesUp(100, 100.16, null)).toBe(false);
    expect(levelLinesUp(100, null, 99.85)).toBe(true);
    expect(levelLinesUp(0, 100, 100)).toBe(false);
  });

  it("walks from the higher ATM strike until the premium is inside the band", () => {
    const picked = selectPut([11, 10], 10.5, (strike) => (strike === 11 ? 20 : 2));
    expect(picked).toEqual({ strike: 10, premium: 2 });
    expect(selectPut([11, 10], 10.5, (strike) => (strike === 11 ? null : 2))).toEqual({ strike: 10, premium: 2 });
    expect(selectPut([10, 9], 10, (strike) => (strike === 10 ? 20 : 0.1))).toBeNull();
    expect(selectPut([10], 10, () => 9)).toBeNull();
  });

  it("prices the spread and fees, and a same-bar stop beats the target", () => {
    expect(paperPnl(2, 2)).toBeCloseTo(-8.5, 6);
    expect(paperPnl(2, 1.5)).toBeCloseTo(-57.6, 6);
    expect(paperPnl(2, 2.8)).toBeCloseTo(70.06, 6);

    const entryAt = Date.parse("2026-10-21T14:00:00.000Z");
    const both = scorePaperExits({
      entryAt,
      entry: 2,
      now: entryAt + 30 * MINUTE,
      flatAt: entryAt + 5 * 60 * MINUTE,
      bars: [{ t: entryAt + 10 * MINUTE, o: 2, h: 3, l: 1.4, c: 2 }],
    });
    expect(both.exit60?.reason).toBe("stop");
    expect(both.exit60?.price).toBeCloseTo(1.5, 6);
    expect(both.exitFlat?.reason).toBe("stop");

    const gap = scorePaperExits({
      entryAt,
      entry: 2,
      now: entryAt + 30 * MINUTE,
      flatAt: entryAt + 5 * 60 * MINUTE,
      bars: [{ t: entryAt + 10 * MINUTE, o: 1, h: 1.2, l: 0.9, c: 1.1 }],
    });
    expect(gap.exit60?.reason).toBe("stop");
    expect(gap.exit60?.price).toBeCloseTo(1, 6);

    const timed = scorePaperExits({
      entryAt,
      entry: 2,
      now: entryAt + 60 * MINUTE,
      flatAt: entryAt + 6 * 60 * MINUTE,
      bars: [
        { t: entryAt, o: 2, h: 2, l: 2, c: 2.1 },
        { t: entryAt + 59 * MINUTE, o: 2, h: 2.2, l: 2, c: 2.4 },
        { t: entryAt + 60 * MINUTE, o: 3, h: 3, l: 3, c: 3 },
      ],
    });
    expect(timed.exit60?.reason).toBe("time");
    expect(timed.exit60?.price).toBeCloseTo(2.4, 6);
    expect(timed.exitFlat).toBeNull();

    const target = scorePaperExits({
      entryAt,
      entry: 2,
      now: entryAt + 20 * MINUTE,
      flatAt: entryAt + 6 * 60 * MINUTE,
      bars: [{ t: entryAt + 5 * MINUTE, o: 2, h: 2.8, l: 2, c: 2.8 }],
    });
    expect(target.exit60?.reason).toBe("profit");
    expect(target.exitFlat?.reason).toBe("profit");
    expect(target.exitFlat?.pnlDollars).toBeCloseTo(70.06, 2);
  });

  it("stays closed after 3:00 PM Central and on a full NYSE holiday", () => {
    expect(vwapPaperEntriesOpen(NOW)).toBe(true);
    expect(vwapPaperEntriesOpen(new Date("2026-10-21T19:59:00.000Z"))).toBe(true);
    expect(vwapPaperEntriesOpen(new Date("2026-10-21T20:00:00.000Z"))).toBe(false);
    expect(vwapPaperEntriesOpen(new Date("2026-11-26T15:30:00.000Z"))).toBe(false);
    expect(weeklyFriday("2026-10-21")).toBe("2026-10-30");
    expect(weeklyFriday("2026-10-23")).toBe("2026-10-30");
  });

  it("round-trips a paper row and leaves it out of the quote list", () => {
    const bars = rejectFixture(15);
    const now = new Date(bars[17].t + MINUTE);
    const signals = collectSignals({
      candles: new Map([["SPY", bars]]),
      now,
      existing: [],
      premarketHigh: new Map([["SPY", 1]]),
    });
    const spy = signals.find((row) => row.ticker === "SPY");
    expect(spy).toBeTruthy();
    if (!spy) return;
    const streamer = ".SPY261021P10";
    const rows = buildPaperRows({
      signals: [spy],
      puts: [
        { root: "SPY", expiration: "2026-10-21", strike: 11 },
        { root: "SPY", expiration: "2026-10-21", strike: 10 },
      ],
      optionBars: new Map([
        [".SPY261021P11", [{ t: spy.entryAt, o: 20, h: 20, l: 20, c: 20 }]],
        [streamer, [{ t: spy.entryAt, o: 2, h: 2, l: 2, c: 2 }]],
      ]),
      now,
    });
    expect(rows).toHaveLength(3);
    const priced = rows.find((row) => row.expiryType === "0DTE");
    expect(priced?.strike).toBe(10);
    expect(priced?.entryPrice).toBe(2);
    expect(priced?.noContract).toBe(false);
    expect(priced?.paperRuleVersion).toBe(VWAP_PAPER_RULE);
    const missing = rows.find((row) => row.expiryType === "1DTE");
    expect(missing?.noContract).toBe(true);
    expect(missing?.strike).toBe(0);
    expect(missing?.entryPrice).toBe(0);

    const book = parseShadowBook(JSON.stringify({ version: 1, records: rows }));
    expect(book.records).toHaveLength(3);
    const kept = book.records.find((row) => row.expiryType === "0DTE");
    expect(kept?.optionStreamer).toBe(streamer);
    expect(kept?.entryWindow).toBe("9:30-10");
    expect(kept?.signalAt).toBe(spy.signalAt);
    expect(kept?.entryAt).toBe(spy.entryAt);
    expect(kept?.signalVwap).toBeCloseTo(spy.vwap, 6);
    expect(kept?.rulesVersion ?? null).toBeNull();
    const empty = book.records.find((row) => row.expiryType === "weekly");
    expect(empty?.noContract).toBe(true);
    expect(empty?.status).toBe("closed");
    expect(empty?.pnlDollars).toBeNull();

    expect(kept).toBeTruthy();
    if (!kept) return;
    expect(shadowsToQuote(book.records)).toEqual([]);
    expect(shadowsToQuote([legacyVwap(), kept]).map((row) => row.id)).toEqual(["vwap-legacy-spy-0001"]);
  });
});

function sessionUntil(index: number, touch: Partial<CandleBar>): CandleBar[] {
  const bars = [bar(0, 20)];
  for (let i = 1; i < index; i++) bars.push(bar(i, 10));
  bars.push(bar(index, 10, touch));
  return bars;
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
