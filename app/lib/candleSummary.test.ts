import { afterEach, describe, expect, it } from "vitest";
import {
  CANDLE_INDEX_PATH,
  LEARN_CANDLE_BUDGET_MS,
  buildCandleSummaries,
  candleDayPath,
  candleSeriesPath,
  commitCandleRun,
  loadCandleSummaries,
  setCandleBlobForTests,
} from "@/app/lib/candleStore";
import { learnCandleKeys } from "@/app/lib/learnStore";
import type { ResearchTrack } from "@/app/lib/researchTrack";
import type { ShadowTrade } from "@/app/lib/shadow";

const NOW = Date.parse("2026-10-13T20:30:00Z");

afterEach(() => {
  setCandleBlobForTests(null);
});

describe("candle summaries", () => {
  it("writes one series file as days are saved and does not reread old day files", async () => {
    const store = memory();
    const key = "SPY|2026-12-18|670|call";
    await commitCandleRun({
      now: NOW,
      errors: 0,
      errorNotes: [],
      writes: [write(key, [bar(Date.parse("2026-10-12T15:00:00Z"), 1)])],
    });
    expect(store.puts.filter((path) => path === candleSeriesPath(key))).toHaveLength(1);
    store.gets.length = 0;
    await commitCandleRun({
      now: NOW + 60_000,
      errors: 0,
      errorNotes: [],
      writes: [write(key, [bar(Date.parse("2026-10-12T15:00:00Z"), 1), bar(Date.parse("2026-10-13T16:00:00Z"), 2)])],
    });
    expect(store.gets.some((path) => path.startsWith("candles/days/"))).toBe(false);
    const series = JSON.parse(store.files.get(candleSeriesPath(key)) ?? "{}") as { bars: number[][] };
    expect(series.bars).toHaveLength(2);
    expect(series.bars[1][1]).toBe(2);
  });

  it("builds summaries from existing day files once, then skips them", async () => {
    const store = memory();
    const key = "QQQ|2026-12-18|500|call";
    const day = "2026-10-13";
    const t = Date.parse("2026-10-13T16:00:00Z");
    store.files.set(candleDayPath(key, day), JSON.stringify({ v: 1, bars: [[t, 1.2, 1.5, 1.1, 1.4]] }));
    store.files.set(CANDLE_INDEX_PATH, JSON.stringify({
      version: 1,
      lastRunAt: NOW,
      errors: 0,
      errorNotes: [],
      errorSample: null,
      contracts: {
        [key]: {
          backfillFrom: "2026-09-01",
          ids: ["alert-1"],
          summary: null,
          days: { [day]: { n: 1, last: t, closed: true } },
        },
      },
    }));
    const first = await buildCandleSummaries({ cap: 10, budgetMs: 240_000 });
    expect(first).toMatchObject({ processed: 1, remaining: 0, rateLimited: false });
    expect(store.files.has(candleSeriesPath(key))).toBe(true);
    store.gets.length = 0;
    const second = await buildCandleSummaries({ cap: 10, budgetMs: 240_000 });
    expect(second).toMatchObject({ processed: 0, remaining: 0 });
    expect(store.gets.some((path) => path.startsWith("candles/days/"))).toBe(false);
  });

  it("reads one summary per contract and stops at the page budget", async () => {
    const store = memory();
    const index = emptyIndex();
    const contracts = 200;
    const days = 30;
    for (let i = 0; i < contracts; i++) {
      const key = `C${i}|2026-12-18|100|call`;
      const meta = daysFor(days);
      index.contracts[key] = {
        backfillFrom: "2026-09-01",
        ids: [`id-${i}`],
        summary: stamp(meta),
        days: meta,
      };
      store.files.set(candleSeriesPath(key), JSON.stringify({ v: 1, bars: [[NOW, 1, 1.2, 0.9, 1.1]] }));
    }
    store.files.set(CANDLE_INDEX_PATH, JSON.stringify(index));
    const keys = Object.keys(index.contracts);
    const loaded = await loadCandleSummaries(keys, { budgetMs: 60_000, nowMs: () => 0 });
    expect(loaded.size).toBe(contracts);
    expect(store.gets.filter((path) => path === CANDLE_INDEX_PATH)).toHaveLength(1);
    expect(store.gets.filter((path) => path.startsWith("candles/series/"))).toHaveLength(contracts);
    expect(store.gets.some((path) => path.startsWith("candles/days/"))).toBe(false);
    expect(store.gets.length).toBe(1 + contracts);
    expect(LEARN_CANDLE_BUDGET_MS).toBe(20_000);

    store.gets.length = 0;
    let clock = 0;
    store.clock = () => {
      clock += 10_000;
      return clock;
    };
    const partial = await loadCandleSummaries(keys, { budgetMs: LEARN_CANDLE_BUDGET_MS, nowMs: () => clock });
    expect(partial.size).toBeLessThan(contracts);
    expect(store.gets.filter((path) => path.startsWith("candles/series/")).length).toBeLessThan(5);
    expect(store.gets.some((path) => path.startsWith("candles/days/"))).toBe(false);
  });

  it("asks for candles only on what-if paths", () => {
    const shadows = [
      shadow("SPY", "A"),
      shadow("QQQ", "B"),
      { ...shadow("IWM", "test"), cohort: "experiment" as const },
    ];
    const research = [{ contractKey: "DIA|2026-12-18|480|put", grade: "C", entryPrice: 1.1 } as ResearchTrack];
    expect(learnCandleKeys(shadows, research)).toEqual([
      "SPY|2026-12-18|670|call",
      "QQQ|2026-12-18|500|call",
    ]);
    expect(learnCandleKeys(shadows, research, ["C"])).toEqual(["DIA|2026-12-18|480|put"]);
  });
});

function memory() {
  const files = new Map<string, string>();
  const gets: string[] = [];
  const puts: string[] = [];
  const store = {
    files,
    gets,
    puts,
    clock: null as null | (() => number),
  };
  setCandleBlobForTests({
    get(pathname) {
      if (store.clock) store.clock();
      gets.push(pathname);
      return Promise.resolve(files.get(pathname) ?? null);
    },
    put(pathname, body) {
      puts.push(pathname);
      files.set(pathname, body);
      return Promise.resolve();
    },
  });
  return store;
}

function bar(t: number, price: number) {
  return { t, o: price, h: price + 0.2, l: price - 0.1, c: price };
}

function write(contractKey: string, bars: ReturnType<typeof bar>[]) {
  return { contractKey, ids: ["alert-1"], bars, closed: true, backfillFrom: "2026-09-01" as string | null };
}

function emptyIndex() {
  return {
    version: 1 as const,
    lastRunAt: NOW,
    errors: 0,
    errorNotes: [] as string[],
    errorSample: null as string | null,
    contracts: {} as Record<string, { backfillFrom: string | null; ids: string[]; summary: string | null; days: Record<string, { n: number; last: number; closed: boolean }> }>,
  };
}

function daysFor(count: number) {
  const days: Record<string, { n: number; last: number; closed: boolean }> = {};
  for (let i = 0; i < count; i++) {
    const day = `2026-09-${String(i + 1).padStart(2, "0")}`;
    days[day] = { n: 1, last: NOW + i, closed: true };
  }
  return days;
}

function stamp(days: Record<string, { n: number; last: number }>): string {
  return Object.keys(days).sort().map((day) => `${day}:${days[day].n}:${days[day].last}`).join("|");
}

function shadow(ticker: string, grade: string): ShadowTrade {
  const strike = ticker === "SPY" ? 670 : ticker === "QQQ" ? 500 : 240;
  return {
    ticker,
    expiration: "2026-12-18",
    strike,
    putCall: "call",
    grade,
    entryPrice: 1.2,
    cohort: "scorecard",
  } as unknown as ShadowTrade;
}
