import { describe, expect, it } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import { nyMinutes } from "@/app/lib/featureBackfill";
import { jgFindSignal, jgReplayMissing, type JgDailyBar } from "@/app/lib/jgSignal";

const ORACLE = [
  { date: "2021-06-02", time: "09:46", direction: "call", level: 333.09, stop: 330.024, taken: true },
  { date: "2022-04-26", time: "13:01", direction: "put", level: 322.43, stop: 327.268, taken: true },
  { date: "2024-04-03", time: "10:06", direction: "call", level: 440.16, stop: 437.881, taken: true },
  { date: "2024-04-04", time: "10:31", direction: "call", level: 445.4, stop: 441.812, vwapDist: -0.111, taken: false },
  { date: "2025-02-10", time: "10:31", direction: "call", level: 529.01, stop: 524.886, taken: true },
  { date: "2025-02-11", time: null, direction: null, level: null, stop: null, taken: false },
  { date: "2025-10-21", time: "12:31", direction: "call", level: 611.75, stop: 605.939, taken: true },
] as const;

describe("JG-VWAP backtest signal", () => {
  it("records the port_out days and does not invent their bars", () => {
    expect(ORACLE.map((row) => row.date)).toEqual([
      "2021-06-02", "2022-04-26", "2024-04-03", "2024-04-04", "2025-02-10", "2025-02-11", "2025-10-21",
    ]);
    expect(ORACLE.find((row) => row.date === "2024-04-04")).toMatchObject({ time: "10:31", vwapDist: -0.111, taken: false });
    expect(ORACLE.find((row) => row.date === "2025-02-11")).toMatchObject({ time: null, taken: false });
    const missing = jgReplayMissing().join(" ");
    expect(missing).toMatch(/5-minute/);
    expect(missing).toMatch(/2018-05-01/);
    expect(missing).toMatch(/VXN/);
    expect(missing).toMatch(/VIX/);
    const noVol = jgFindSignal({
      bars: [],
      daily: [
        { date: "2024-04-03", high: 1, low: 1, close: 1 },
        { date: "2024-04-02", high: 1, low: 1, close: 1 },
      ],
      volIndex: null,
      volSymbol: "VXN",
      day: "2024-04-04",
      nowMs: Date.parse("2024-04-04T20:00:00.000Z"),
      atrUsed: null,
    });
    expect(noVol.status).toBe("none");
    if (noVol.status === "none") expect(noVol.reason).toMatch(/VXN/);
  });

  it("takes the first call retest and rejects a VWAP break of -0.10", () => {
    const call = fixture({ pivot: 110, breakClose: 112, retestLow: 110.05, retestClose: 110.4, base: 100 });
    const result = jgFindSignal({
      bars: call.bars,
      daily: call.daily,
      volIndex: 20,
      volSymbol: "VXN",
      day: call.day,
      nowMs: call.nowMs,
      atrUsed: 0.5,
    });
    expect(result.status).toBe("signal");
    if (result.status !== "signal") return;
    expect(result.signal.direction).toBe("call");
    expect(result.signal.level).toBeCloseTo(110, 4);
    expect(result.signal.entry).toBeCloseTo(110.4, 4);
    expect(etClock(result.signal.signalAt)).toBe("11:36");
    const stop = 110.4 - 0.75 * (call.priorClose * 0.2 / Math.sqrt(252));
    expect(result.signal.stop).toBeCloseTo(Math.round(stop * 1000) / 1000, 3);

    const rejected = fixture({ pivot: 110, breakClose: 112, retestLow: 110.05, retestClose: 110.4, base: 100, rally: 130 });
    const reject = jgFindSignal({
      bars: rejected.bars,
      daily: rejected.daily,
      volIndex: 20,
      volSymbol: "VXN",
      day: rejected.day,
      nowMs: rejected.nowMs,
      atrUsed: 0.5,
    });
    expect(reject.status).toBe("vwap-reject");
    if (reject.status === "vwap-reject") expect(reject.signal.vwapDist).toBeLessThan(-0.1);
  });

  it("does not trade when the weekly trend disagrees", () => {
    const call = fixture({ pivot: 110, breakClose: 112, retestLow: 110.05, retestClose: 110.4, base: 100, fade: true });
    const result = jgFindSignal({
      bars: call.bars,
      daily: call.daily,
      volIndex: 20,
      volSymbol: "VXN",
      day: call.day,
      nowMs: call.nowMs,
      atrUsed: null,
    });
    expect(result.status).toBe("none");
  });

  it("refuses a short daily history when the backtest seed is required", () => {
    const call = fixture({ pivot: 110, breakClose: 112, retestLow: 110.05, retestClose: 110.4, base: 100 });
    const result = jgFindSignal({
      bars: call.bars,
      daily: call.daily,
      volIndex: 20,
      volSymbol: "VXN",
      day: call.day,
      nowMs: call.nowMs,
      atrUsed: 0.5,
      enforceSeed: true,
    });
    expect(result.status).toBe("none");
    if (result.status === "none") expect(result.reason).toMatch(/2018-05-01|5-minute history/);
  });
});

function etClock(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function sessionOpen(ymd: string): number {
  const edt = Date.parse(`${ymd}T13:30:00.000Z`);
  if (nyMinutes(edt) === 9 * 60 + 30) return edt;
  return Date.parse(`${ymd}T14:30:00.000Z`);
}

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

function fixture(input: {
  pivot: number;
  breakClose: number;
  retestLow: number;
  retestClose: number;
  base: number;
  fade?: boolean;
  rally?: number;
}): { bars: CandleBar[]; daily: JgDailyBar[]; day: string; nowMs: number; priorClose: number; retestClock: string } {
  const start = "2026-08-03";
  const dates: string[] = [];
  let cursor = start;
  while (dates.length < 40) {
    const dow = new Date(`${cursor}T00:00:00.000Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  const day = dates[dates.length - 1];
  const bars: CandleBar[] = [];
  const daily: JgDailyBar[] = [];
  for (let d = 0; d < dates.length; d++) {
    const open = sessionOpen(dates[d]);
    const last = d === dates.length - 1;
    const prev = d === dates.length - 2;
    let close = input.base + d * 0.2;
    if (input.fade && d > 20) close = input.base + (40 - d) * 0.4;
    let high = close + 0.2;
    let low = close - 0.2;
    for (let minute = 0; minute < 390; minute += 5) {
      let price = close;
      let barHigh = high;
      let barLow = low;
      if (prev && minute >= 60 && minute < 120) {
        price = input.pivot - 1;
        barHigh = input.pivot;
        barLow = input.pivot - 1;
      }
      if (last && minute >= 60 && minute < 120) {
        price = input.breakClose;
        barHigh = input.breakClose;
        barLow = input.breakClose - 0.2;
      }
      if (last && input.rally != null && minute >= 120 && minute < 180) {
        price = input.rally;
        barHigh = input.rally;
        barLow = input.rally;
      }
      if (last && minute === (input.rally != null ? 180 : 120)) {
        price = input.retestClose;
        barHigh = Math.max(input.retestClose, input.retestLow);
        barLow = input.retestLow;
      }
      bars.push({ t: open + minute * 60_000, o: price, h: barHigh, l: barLow, c: price, v: 1000 });
    }
    const dayBars = bars.filter((bar) => bar.t >= open && bar.t < open + 390 * 60_000);
    daily.push({
      date: dates[d],
      high: Math.max(...dayBars.map((bar) => bar.h)),
      low: Math.min(...dayBars.map((bar) => bar.l)),
      close: dayBars[dayBars.length - 1].c,
    });
  }
  return {
    bars,
    daily,
    day,
    nowMs: sessionOpen(day) + 16 * 60 * 60_000,
    priorClose: daily[daily.length - 2].close,
    retestClock: "11:31",
  };
}
