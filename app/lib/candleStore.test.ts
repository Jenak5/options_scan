import { afterEach, describe, expect, it } from "vitest";
import {
  candleDayPath,
  CANDLE_INDEX_PATH,
  commitCandleRun,
  readCandleHealth,
  setCandleBlobForTests,
  type CandleWrite,
} from "@/app/lib/candleStore";

const NOW = Date.parse("2026-10-13T20:30:00Z");
const KEY = "TLT|2026-11-13|77.5|put";

function memory() {
  const files = new Map<string, string>();
  const puts: string[] = [];
  setCandleBlobForTests({
    get(pathname) {
      return Promise.resolve(files.get(pathname) ?? null);
    },
    put(pathname, body) {
      puts.push(pathname);
      if (pathname.startsWith("candles/days/429/")) {
        return Promise.reject(new Error("Vercel Blob: 429 Too Many Requests"));
      }
      files.set(pathname, body);
      return Promise.resolve();
    },
  });
  return { files, puts };
}

afterEach(() => {
  setCandleBlobForTests(null);
});

describe("candle blob writes", () => {
  it("writes one day file and skips the same candles on the next run", async () => {
    const store = memory();
    const write = sample([bar(NOW, 1.2, 1.4, 1.1, 1.3)]);
    const first = await commitCandleRun({ now: NOW, errors: 0, errorNotes: [], writes: [write] });
    expect(first.daysWritten).toBe(1);
    expect(first.rateLimited).toBe(false);
    const dayPuts = store.puts.filter((path) => path === candleDayPath(KEY, "2026-10-13"));
    expect(dayPuts).toHaveLength(1);
    expect(store.files.has(CANDLE_INDEX_PATH)).toBe(true);

    const second = await commitCandleRun({
      now: NOW + 60_000,
      errors: 0,
      errorNotes: [],
      writes: [write],
    });
    expect(second.daysWritten).toBe(0);
    expect(second.daysSkipped).toBe(1);
    expect(store.puts.filter((path) => path === candleDayPath(KEY, "2026-10-13"))).toHaveLength(1);
    const health = await readCandleHealth();
    expect(health.candleAlertsCovered).toBe(1);
    expect(health.candleErrors).toBe(0);
    expect(health.candlesLastRun).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("stops further blob puts after a 429", async () => {
    const store = memory();
    const write = sample([bar(NOW, 1, 1, 1, 1)], "429");
    const result = await commitCandleRun({ now: NOW, errors: 0, errorNotes: [], writes: [write] });
    expect(result.rateLimited).toBe(true);
    expect(result.daysWritten).toBe(0);
    expect(store.puts).toHaveLength(1);
    expect(store.files.has(CANDLE_INDEX_PATH)).toBe(false);
  });
});

function bar(t: number, o: number, h: number, l: number, c: number) {
  return { t, o, h, l, c };
}

function sample(bars: CandleWrite["bars"], contractKey = KEY): CandleWrite {
  return {
    contractKey,
    ids: ["alert-1"],
    bars,
    closed: true,
    backfillFrom: null,
  };
}
