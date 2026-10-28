import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import { jgFindSignal, type JgDailyBar } from "@/app/lib/jgSignal";

const DIR = join(process.cwd(), "app/lib/fixtures/jg-vwap");

/** port_out.jsonl / replay_out.jsonl. The backtest is the truth. */
const EXPECTED = [
  { date: "2021-06-02", time: "09:46", side: "call" as const, level: 333.09, stop: 330.024, vwapOk: true, vwapDist: 0.035 },
  { date: "2022-04-26", time: "13:01", side: "put" as const, level: 322.43, stop: 327.268, vwapOk: true, vwapDist: -0.099 },
  { date: "2024-04-03", time: "10:06", side: "call" as const, level: 440.16, stop: 437.881, vwapOk: true, vwapDist: 0.335 },
  { date: "2024-04-04", time: "10:31", side: "call" as const, level: 445.4, stop: 441.812, vwapOk: false, vwapDist: -0.111 },
  { date: "2025-02-10", time: "10:31", side: "call" as const, level: 529.01, stop: 524.886, vwapOk: true, vwapDist: 0.306 },
  { date: "2025-02-11", time: null, side: null, level: null, stop: null, vwapOk: null, vwapDist: null },
  { date: "2025-10-21", time: "12:31", side: "call" as const, level: 611.75, stop: 605.939, vwapOk: true, vwapDist: 0.262 },
];

const daily = loadDaily();
const vxn = loadVxn();

describe("JG-VWAP fixture replay", () => {
  it.each(EXPECTED)("$date matches the backtest", (row) => {
    const got = replay(row.date);
    expect(got).toEqual({
      date: row.date,
      time: row.time,
      side: row.side,
      level: row.level,
      stop: row.stop,
      vwapOk: row.vwapOk,
      vwapDist: row.vwapDist,
    });
  });
});

function replay(day: string): {
  date: string;
  time: string | null;
  side: "call" | "put" | null;
  level: number | null;
  stop: number | null;
  vwapOk: boolean | null;
  vwapDist: number | null;
} {
  const bars = loadFive(day);
  const last = bars[bars.length - 1];
  const result = jgFindSignal({
    bars,
    daily,
    volIndex: priorVxn(day),
    volSymbol: "VXN",
    day,
    nowMs: last.t + 5 * 60_000,
    atrUsed: null,
    enforceSeed: true,
  });
  if (result.status === "none") {
    return { date: day, time: null, side: null, level: null, stop: null, vwapOk: null, vwapDist: null };
  }
  return {
    date: day,
    time: etClock(result.signal.signalAt),
    side: result.signal.direction,
    level: result.signal.level,
    stop: result.signal.stop,
    vwapOk: result.signal.vwapOk,
    vwapDist: result.signal.vwapDist,
  };
}

function loadDaily(): JgDailyBar[] {
  return readFileSync(join(DIR, "qqq_daily.csv"), "utf8").trim().split("\n").slice(1).map((line) => {
    const [date, , high, low, close] = line.split(",");
    return { date, high: Number(high), low: Number(low), close: Number(close) };
  });
}

function loadVxn(): { date: string; close: number }[] {
  return readFileSync(join(DIR, "vxn_daily.csv"), "utf8").trim().split("\n").slice(1).map((line) => {
    const [date, close] = line.split(",");
    return { date, close: Number(close) };
  }).filter((row) => Number.isFinite(row.close));
}

function priorVxn(day: string): number | null {
  let close: number | null = null;
  for (let i = 0; i < vxn.length; i++) {
    if (vxn[i].date < day) close = vxn[i].close;
  }
  return close;
}

function loadFive(day: string): CandleBar[] {
  return readFileSync(join(DIR, `qqq_5m_${day}.csv`), "utf8").trim().split("\n").slice(1).map((line) => {
    const [ts, open, high, low, close, volume] = line.split(",");
    return {
      t: Date.parse(ts.replace(" ", "T")),
      o: Number(open),
      h: Number(high),
      l: Number(low),
      c: Number(close),
      v: Number(volume),
    };
  });
}

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
