import { describe, expect, it } from "vitest";
import { isBearerPath } from "@/app/lib/bearerPaths";
import {
  aggregateEod,
  chunkSymbols,
  coveragePercent,
  EOD_DXLINK_CHUNK,
  eodContractsFromNested,
  eodCronDecision,
  eodOverallRows,
  eodRatioSeries,
  eodSession,
  formatEodCount,
  formatEodPercent,
  formatEodRatio,
  parseEodBook,
  putCallRatio,
  upsertEodRow,
  type EodContract,
  type EodFlowRow,
  type EodReading,
  type EodSession,
} from "@/app/lib/eodFlow";
import { addCalendarDays } from "@/app/lib/flow";
import { parseEodFeedData } from "@/app/lib/tastytradeMarketParse";
import type { NestedExpiration } from "@/app/lib/tastytradeMarketParse";

const SESSION: EodSession = { date: "2026-07-16", friday: false, earlyClose: false };

function contract(over: Partial<EodContract> & Pick<EodContract, "id" | "putCall" | "dte" | "strike">): EodContract {
  return {
    root: "QQQ",
    expiration: "2026-07-16",
    settled: false,
    ...over,
  };
}

function row(over: Partial<EodFlowRow> & Pick<EodFlowRow, "date" | "underlying">): EodFlowRow {
  return {
    putVolume: null,
    callVolume: null,
    putCallVolumeRatio: null,
    putOpenInterest: null,
    callOpenInterest: null,
    putCallOiRatio: null,
    putVolume0to7: null,
    callVolume0to7: null,
    putVolume8to45: null,
    callVolume8to45: null,
    topStrikes: [],
    friday: false,
    earlyClose: false,
    volumeCoverage: null,
    oiCoverage: null,
    contractCount: 0,
    collectedAt: 1,
    note: null,
    ...over,
  };
}

describe("end-of-day flow aggregation", () => {
  it("chunks unique symbols at 4,500 and never past the DXLink cap", () => {
    const symbols = Array.from({ length: 4_501 }, (_, index) => `S${index}`);
    symbols.push("S0", "S1");
    const chunks = chunkSymbols(symbols);
    expect(EOD_DXLINK_CHUNK).toBe(4_500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4_500);
    expect(chunks[1]).toEqual(["S4500"]);
    expect(chunks.every((chunk) => chunk.length <= 4_500)).toBe(true);
    expect(chunkSymbols(symbols, 6_000)[0]).toHaveLength(4_500);
    expect(chunkSymbols(["A", "A", "B"], 10)).toEqual([["A", "B"]]);
    expect(chunkSymbols([])).toEqual([]);
  });

  it("sums puts and calls, splits 0-7 and 8-45, and ranks the top strikes", () => {
    const contracts = [
      contract({ id: "p0", putCall: "put", dte: 0, strike: 500 }),
      contract({ id: "p0b", putCall: "put", dte: 3, strike: 500 }),
      contract({ id: "c7", putCall: "call", dte: 7, strike: 510 }),
      contract({ id: "p8", putCall: "put", dte: 8, strike: 490 }),
      contract({ id: "c45", putCall: "call", dte: 45, strike: 520 }),
      contract({ id: "miss", putCall: "put", dte: 10, strike: 480 }),
      contract({ id: "out", putCall: "call", dte: 46, strike: 530 }),
      contract({ id: "z", putCall: "call", dte: 9, strike: 470 }),
    ];
    const readings: Record<string, EodReading> = {
      p0: { dayVolume: 10, openInterest: 4 },
      p0b: { dayVolume: 15, openInterest: 1 },
      c7: { dayVolume: 20, openInterest: 8 },
      p8: { dayVolume: 5, openInterest: 0 },
      c45: { dayVolume: 7, openInterest: null },
      miss: { dayVolume: null, openInterest: 3 },
      z: { dayVolume: 0, openInterest: 2 },
    };
    const result = aggregateEod({ contracts, readings, underlying: "QQQ", session: SESSION, collectedAt: 50 });
    expect(result.contractCount).toBe(7);
    expect(result.putVolume).toBe(30);
    expect(result.callVolume).toBe(27);
    expect(result.putCallVolumeRatio).toBeCloseTo(30 / 27);
    expect(result.putOpenInterest).toBe(8);
    expect(result.callOpenInterest).toBe(10);
    expect(result.putCallOiRatio).toBeCloseTo(0.8);
    expect(result.putVolume0to7).toBe(25);
    expect(result.callVolume0to7).toBe(20);
    expect(result.putVolume8to45).toBe(5);
    expect(result.callVolume8to45).toBe(7);
    expect(result.volumeCoverage).toBeCloseTo((6 / 7) * 100);
    expect(result.oiCoverage).toBeCloseTo((6 / 7) * 100);
    expect(result.topStrikes[0]).toEqual({ strike: 500, putCall: "put", volume: 25 });
    expect(result.topStrikes).toHaveLength(5);
    expect(result.topStrikes.some((item) => item.strike === 480)).toBe(false);
  });

  it("leaves a side blank when none of its contracts reported, and keeps a real zero", () => {
    const none = aggregateEod({
      contracts: [contract({ id: "p", putCall: "put", dte: 1, strike: 1 }), contract({ id: "c", putCall: "call", dte: 1, strike: 2 })],
      readings: {},
      underlying: "NDX",
      session: SESSION,
      collectedAt: 1,
    });
    expect(none.putVolume).toBeNull();
    expect(none.callVolume).toBeNull();
    expect(none.putCallVolumeRatio).toBeNull();
    expect(none.volumeCoverage).toBe(0);
    expect(formatEodCount(none.putVolume)).toBe("n/a");
    expect(formatEodRatio(none.putCallVolumeRatio)).toBe("n/a");
    expect(formatEodPercent(none.volumeCoverage)).toBe("0.0%");
    expect(formatEodPercent(none.oiCoverage)).toBe("0.0%");

    const zeros = aggregateEod({
      contracts: [contract({ id: "p", putCall: "put", dte: 1, strike: 1 }), contract({ id: "c", putCall: "call", dte: 1, strike: 2 })],
      readings: {
        p: { dayVolume: 0, openInterest: 0 },
        c: { dayVolume: 4, openInterest: 0 },
      },
      underlying: "QQQ",
      session: SESSION,
      collectedAt: 1,
    });
    expect(zeros.putVolume).toBe(0);
    expect(zeros.callVolume).toBe(4);
    expect(zeros.putCallVolumeRatio).toBe(0);
    expect(zeros.putCallOiRatio).toBeNull();
    expect(zeros.volumeCoverage).toBe(100);
    expect(coveragePercent(0, 0)).toBeNull();
    expect(putCallRatio(3, 0)).toBeNull();
    expect(putCallRatio(null, 3)).toBeNull();
    expect(putCallRatio(6, 3)).toBe(2);
  });

  it("keeps a zero dayVolume and does not let a later empty field erase it", () => {
    const seen = { trade: new Set<string>(), summary: new Set<string>() };
    const into = parseEodFeedData(["Trade", [".QQQ", 0], "Summary", [".QQQ", 12]], undefined, seen);
    parseEodFeedData(["Trade", [".QQQ", "NaN"], "Summary", [".QQQ", ""]], into, seen);
    expect(into.get(".QQQ")).toEqual({ dayVolume: 0, openInterest: 12 });
    expect(seen.trade.has(".QQQ")).toBe(true);
    expect(seen.summary.has(".QQQ")).toBe(true);
    const missing = parseEodFeedData(["Trade", [".NDX", null]]);
    expect(missing.get(".NDX")).toEqual({ dayVolume: null, openInterest: null });
  });

  it("keeps QQQ, NDX, and NDXP inside 0 to 45 days", () => {
    const chain: NestedExpiration[] = [
      {
        expiration: "2026-07-16",
        strikes: [{ strike: 500, call: "QQQ   260716C00500000", put: "QQQ   260716P00500000" }],
      },
      {
        expiration: "2026-08-30",
        strikes: [{ strike: 480, call: "QQQ   260830C00480000", put: null }],
      },
      {
        expiration: "2026-08-31",
        strikes: [{ strike: 500, call: "QQQ   260831C00500000", put: null }],
      },
      {
        expiration: "2026-07-17",
        strikes: [
          { strike: 20000, call: "NDX   260717C20000000", put: "NDX   260717P20000000" },
          { strike: 20000, call: "NDXP  260717C20000000", put: "NDXP  260717P20000000" },
          { strike: 20, call: "VIX   260717C00020000", put: "VIX   260717P00020000" },
          { strike: 20, call: "VIXW  260717C00020000", put: "VIXW  260717P00020000" },
          { strike: 500, call: "SPY   260717C00500000", put: "SPY   260717P00500000" },
        ],
      },
    ];
    const qqq = eodContractsFromNested(chain, "2026-07-16", ["QQQ"]);
    expect(qqq.map((item) => item.dte).sort((a, b) => a - b)).toEqual([0, 0, 45]);
    const ndx = eodContractsFromNested(chain, "2026-07-16", ["NDX", "NDXP"]);
    expect(ndx.map((item) => item.root).sort()).toEqual(["NDX", "NDX", "NDXP", "NDXP"]);
    expect(ndx.every((item) => item.dte === 1)).toBe(true);
    const vix = eodContractsFromNested(chain, "2026-07-16", ["VIX", "VIXW"]);
    expect(vix.map((item) => item.root).sort()).toEqual(["VIX", "VIX", "VIXW", "VIXW"]);
    const spy = eodContractsFromNested(chain, "2026-07-16", ["SPY"]);
    expect(spy.map((item) => item.root)).toEqual(["SPY", "SPY"]);
  });

  it("skips weekends and full-day holidays, and still runs after an early close", () => {
    const thanksgiving = new Date("2026-11-26T21:20:00Z");
    const saturday = new Date("2026-11-21T21:20:00Z");
    const early = new Date("2026-11-27T21:20:00Z");
    const summer = new Date("2026-07-16T20:20:00Z");
    const summerEarly = new Date("2026-07-16T20:19:00Z");
    const summerLate = new Date("2026-07-16T21:20:00Z");
    const winter = new Date("2026-11-20T21:20:00Z");
    const winterOther = new Date("2026-11-20T20:20:00Z");
    const continueSummer = new Date("2026-07-16T20:30:00Z");
    const continueLater = new Date("2026-07-16T20:40:00Z");
    const continueLast = new Date("2026-07-16T20:50:00Z");
    const between = new Date("2026-07-16T20:35:00Z");
    const winterLater = new Date("2026-11-20T21:40:00Z");
    const winterLast = new Date("2026-11-20T21:50:00Z");
    const afterLast = new Date("2026-07-16T20:55:00Z");

    expect(eodCronDecision(thanksgiving, true)).toEqual({ run: false, reason: "market holiday" });
    expect(eodCronDecision(saturday, false)).toEqual({ run: false, reason: "market holiday" });
    expect(eodCronDecision(early, false).run).toBe(true);
    expect(eodSession(early)).toMatchObject({ date: "2026-11-27", friday: true, earlyClose: true });
    expect(eodSession(new Date("2026-12-24T21:20:00Z"))).toMatchObject({ friday: false, earlyClose: true });
    expect(eodCronDecision(summer, false).run).toBe(true);
    expect(eodCronDecision(summerEarly, false).run).toBe(false);
    expect(eodCronDecision(summerLate, false).run).toBe(false);
    expect(eodCronDecision(winter, false).run).toBe(true);
    expect(eodCronDecision(winterOther, false).run).toBe(false);
    expect(eodCronDecision(continueSummer, false).run).toBe(true);
    expect(eodCronDecision(continueLater, false).run).toBe(true);
    expect(eodCronDecision(continueLast, false).run).toBe(true);
    expect(eodCronDecision(between, false).run).toBe(false);
    expect(eodCronDecision(winterLater, false).run).toBe(true);
    expect(eodCronDecision(winterLast, false).run).toBe(true);
    expect(eodCronDecision(afterLast, false).run).toBe(false);
    expect(eodCronDecision(summer, true).run).toBe(true);
  });

  it("overwrites the same date and underlying and keeps the other rows", () => {
    const first = row({ date: "2026-07-15", underlying: "QQQ", putVolume: 1, callVolume: 2, putCallVolumeRatio: 0.5 });
    const ndx = row({ date: "2026-07-16", underlying: "NDX", putVolume: 9, callVolume: 3, putCallVolumeRatio: 3 });
    const original = row({ date: "2026-07-16", underlying: "QQQ", putVolume: 4, callVolume: 4, putCallVolumeRatio: 1 });
    const replacement = row({ date: "2026-07-16", underlying: "QQQ", putVolume: 8, callVolume: 2, putCallVolumeRatio: 4 });
    const stored = upsertEodRow(upsertEodRow(upsertEodRow([], first), ndx), original);
    const next = upsertEodRow(stored, replacement);
    expect(next.map((item) => `${item.date}:${item.underlying}:${item.putVolume}`)).toEqual([
      "2026-07-16:NDX:9",
      "2026-07-16:QQQ:8",
      "2026-07-15:QQQ:1",
    ]);
    const parsed = parseEodBook(JSON.stringify({ version: 1, rows: next, work: null, lockUntil: null }));
    expect(parsed?.rows[1].putVolume).toBe(8);
    expect(parsed?.rows).toHaveLength(3);
    expect(eodRatioSeries(next)).toEqual([
      { date: "2026-07-15", overall: null, lean: null, spy: null, qqq: 0.5, ndx: null, vix: null },
      { date: "2026-07-16", overall: null, lean: null, spy: null, qqq: 4, ndx: 3, vix: null },
    ]);
    expect(formatEodCount(null)).toBe("n/a");
  });

  it("builds the overall read from SPY, QQQ, and NDX, and leaves it blank when one is missing", () => {
    const day = "2026-07-16";
    const names = ["SPY", "QQQ", "NDX"] as const;
    const puts = [10, 20, 30];
    const calls = [5, 10, 15];
    const rows = names.map((underlying, index) => row({
      date: day,
      underlying,
      putVolume: puts[index],
      callVolume: calls[index],
      putOpenInterest: puts[index] * 2,
      callOpenInterest: calls[index] * 2,
      putVolume0to7: puts[index] - 4,
      callVolume0to7: calls[index] - 2,
      putVolume8to45: 4,
      callVolume8to45: 2,
      volumeCoverage: index === 0 ? 50 : index === 1 ? 100 : 50,
      oiCoverage: 80,
      contractCount: index === 2 ? 20 : 10,
    }));
    rows.push(row({
      date: day,
      underlying: "VIX",
      putVolume: 2,
      callVolume: 8,
      volumeCoverage: 100,
      contractCount: 4,
    }));
    const full = eodOverallRows(rows)[0];
    expect(full.equityPutCallVolume).toBe(2);
    expect(full.equityPutCallVolume0to7).toBeCloseTo((6 + 16 + 26) / (3 + 8 + 13));
    expect(full.equityPutCallVolume8to45).toBe(2);
    expect(full.equityPutCallOi).toBe(2);
    expect(full.vixCallPutVolume).toBe(4);
    expect(full.volumeCoverage).toBeCloseTo((5 + 10 + 10) / 40 * 100);
    expect(full.lean).toBeNull();

    const missingSpy = eodOverallRows(rows.filter((item) => item.underlying !== "SPY"))[0];
    expect(missingSpy.equityPutCallVolume).toBeNull();
    expect(missingSpy.equityPutCallVolume0to7).toBeNull();
    expect(missingSpy.equityPutCallVolume8to45).toBeNull();
    expect(missingSpy.equityPutCallOi).toBeNull();
    expect(missingSpy.vixCallPutVolume).toBeNull();
    expect(missingSpy.volumeCoverage).toBeCloseTo((10 + 10) / 30 * 100);

    const missingVix = eodOverallRows(rows.filter((item) => item.underlying !== "VIX"))[0];
    expect(missingVix.equityPutCallVolume).toBe(2);
    expect(missingVix.vixCallPutVolume).toBeNull();

    const blankSide = rows.map((item) => item.underlying === "QQQ" ? { ...item, putVolume: null } : item);
    expect(eodOverallRows(blankSide)[0].equityPutCallVolume).toBeNull();

    const zeroPuts = rows.map((item) => item.underlying === "SPY" ? { ...item, putVolume: 0 } : item);
    expect(eodOverallRows(zeroPuts)[0].equityPutCallVolume).toBeCloseTo(50 / 30);
  });

  it("draws a lean triangle only after five prior days, and only outside 5% of that average", () => {
    const history = (todayRatio: number, priorCount: number) => {
      const today = addCalendarDays("2026-06-01", priorCount);
      const rows = [];
      for (let i = 0; i <= priorCount; i++) {
        const date = addCalendarDays("2026-06-01", i);
        const age = priorCount - i;
        const ratio = age === 0 ? todayRatio : age > 20 ? 100 : 1;
        for (const underlying of ["SPY", "QQQ", "NDX"] as const) {
          const put = underlying === "SPY" ? ratio : 0;
          rows.push(row({
            date,
            underlying,
            putVolume: put,
            callVolume: underlying === "SPY" ? 1 : 0,
            putOpenInterest: 1,
            callOpenInterest: 1,
            putVolume0to7: put,
            callVolume0to7: underlying === "SPY" ? 1 : 0,
            putVolume8to45: 0,
            callVolume8to45: 0,
            volumeCoverage: 100,
            contractCount: 1,
          }));
        }
      }
      return eodOverallRows(rows).find((item) => item.date === today);
    };
    expect(history(2, 4)?.lean).toBeNull();
    expect(history(2, 4)?.equityPutCallVolume).toBe(2);
    expect(history(1.2, 5)?.lean).toBe("down");
    expect(history(1.04, 5)?.lean).toBeNull();
    expect(history(0.8, 5)?.lean).toBe("up");
    expect(history(1.2, 25)?.lean).toBe("down");
    expect(history(1.2, 25)?.equityPutCallVolume).toBe(1.2);
  });

  it("lets the cron bearer through and keeps the page behind login", () => {
    expect(isBearerPath("/api/cron/eod-flow")).toBe(true);
    expect(isBearerPath("/api/eod-flow")).toBe(false);
  });
});
