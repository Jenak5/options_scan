import { afterEach, describe, expect, it, vi } from "vitest";
import { runCandleJob, CANDLE_CONTRACTS_PER_CALL, CANDLE_TIME_BUDGET_MS } from "@/app/lib/candleJob";
import { readCandleHealth, readCandleIndex, setCandleBlobForTests } from "@/app/lib/candleStore";
import type { ResearchTrack } from "@/app/lib/researchTrack";
import * as schwabStore from "@/app/lib/schwabStore";
import { fetchOptionCandles, type CandleSubscription } from "@/app/lib/tastytradeCandles";

const NOW = new Date("2026-10-13T20:30:00Z");
const BAR = { t: Date.parse("2026-10-13T16:00:00Z"), o: 1, h: 1.4, l: 0.8, c: 1.1 };

afterEach(() => {
  vi.restoreAllMocks();
  setCandleBlobForTests(null);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.TASTYTRADE_CLIENT_ID;
  delete process.env.TASTYTRADE_CLIENT_SECRET;
  delete process.env.TASTYTRADE_REFRESH_TOKEN;
});

describe("candle job batches", () => {
  it("saves each contract before the next and stops at the cap", async () => {
    const store = memory();
    const books = book(3);
    vi.spyOn(schwabStore, "readAlertBookText").mockResolvedValue(books.alerts);
    vi.spyOn(schwabStore, "readShadowBookText").mockResolvedValue(books.shadows);
    const seen: Array<string | null> = [];
    const fetchCandles = vi.fn(async (subs: readonly CandleSubscription[]) => {
      const index = await readCandleIndex();
      seen.push(index.contracts["SPY|2026-12-18|670|call"]?.backfillFrom ?? null);
      const streamer = subs[0].streamer;
      const candles = new Map([[streamer, [BAR]]]);
      return { candles, completed: [streamer], errors: [], errorSample: null };
    });
    const first = await runCandleJob({
      mode: "backfill",
      now: NOW,
      cap: 2,
      budgetMs: CANDLE_TIME_BUDGET_MS,
      fetchCandles,
    });
    expect(CANDLE_CONTRACTS_PER_CALL).toBeGreaterThanOrEqual(40);
    expect(CANDLE_CONTRACTS_PER_CALL).toBeLessThanOrEqual(60);
    expect(CANDLE_TIME_BUDGET_MS).toBe(240_000);
    expect(first.processed).toBe(2);
    expect(first.remaining).toBe(1);
    expect(fetchCandles).toHaveBeenCalledTimes(2);
    expect(seen[1]).toBe("2026-09-01");
    expect(store.puts.some((path) => path.startsWith("candles/days/"))).toBe(true);
    const health = await readCandleHealth();
    expect(health.candlesLastRun).toBe(NOW.toISOString());
    expect(health.candleErrors).toBe(0);

    fetchCandles.mockClear();
    const second = await runCandleJob({
      mode: "backfill",
      now: NOW,
      cap: 2,
      budgetMs: CANDLE_TIME_BUDGET_MS,
      fetchCandles,
    });
    expect(second.processed).toBe(1);
    expect(second.remaining).toBe(0);
    expect(fetchCandles).toHaveBeenCalledTimes(1);
  });

  it("stops at the time budget and does not retry after an OAuth failure", async () => {
    memory();
    const books = book(3);
    vi.spyOn(schwabStore, "readAlertBookText").mockResolvedValue(books.alerts);
    vi.spyOn(schwabStore, "readShadowBookText").mockResolvedValue(books.shadows);
    const fetchCandles = vi.fn(async (subs: readonly CandleSubscription[]) => {
      const streamer = subs[0].streamer;
      return {
        candles: new Map([[streamer, [BAR]]]),
        completed: [streamer],
        errors: [],
        errorSample: null,
      };
    });
    const skipped = await runCandleJob({
      mode: "daily",
      now: NOW,
      cap: 50,
      budgetMs: CANDLE_TIME_BUDGET_MS,
      fetchCandles,
    });
    expect(skipped.processed).toBe(0);
    expect(skipped.remaining).toBe(0);
    expect(fetchCandles).not.toHaveBeenCalled();

    vi.spyOn(schwabStore, "readShadowBookText").mockResolvedValue(openShadows(3));
    let clock = 1_000;
    fetchCandles.mockImplementation(async (subs: readonly CandleSubscription[]) => {
      clock += CANDLE_TIME_BUDGET_MS;
      const streamer = subs[0].streamer;
      return {
        candles: new Map([[streamer, [BAR]]]),
        completed: [streamer],
        errors: [],
        errorSample: null,
      };
    });
    const budgeted = await runCandleJob({
      mode: "daily",
      now: NOW,
      cap: 50,
      budgetMs: CANDLE_TIME_BUDGET_MS,
      nowMs: () => clock,
      fetchCandles,
    });
    expect(budgeted.processed).toBe(1);
    expect(budgeted.remaining).toBe(2);
    expect(fetchCandles).toHaveBeenCalledTimes(1);

    const oauthFetch: typeof fetchOptionCandles = async () => ({
      candles: new Map(),
      completed: [],
      errors: ["invalid_grant: refresh token is invalid"],
      errorSample: "invalid_grant: refresh token is invalid",
    });
    const oauthFetchMock = vi.fn(oauthFetch);
    const oauth = await runCandleJob({
      mode: "backfill",
      now: NOW,
      cap: 50,
      budgetMs: CANDLE_TIME_BUDGET_MS,
      fetchCandles: oauthFetchMock,
    });
    expect(oauthFetchMock).toHaveBeenCalledTimes(1);
    expect(oauth.processed).toBe(0);
    expect(oauth.remaining).toBe(3);
    expect(oauth.errorSample).toBe("invalid_grant: refresh token is invalid");
    expect((await readCandleHealth()).candleErrorSample).toBe("invalid_grant: refresh token is invalid");
  });
});

function memory() {
  const files = new Map<string, string>();
  const puts: string[] = [];
  setCandleBlobForTests({
    get(pathname) {
      return Promise.resolve(files.get(pathname) ?? null);
    },
    put(pathname, body) {
      puts.push(pathname);
      files.set(pathname, body);
      return Promise.resolve();
    },
  });
  process.env.BLOB_READ_WRITE_TOKEN = "blob-token";
  process.env.TASTYTRADE_CLIENT_ID = "client-id";
  process.env.TASTYTRADE_CLIENT_SECRET = "client-secret";
  process.env.TASTYTRADE_REFRESH_TOKEN = "refresh-token";
  return { files, puts };
}

function openShadows(count: number): string {
  const names = ["SPY", "QQQ", "IWM"];
  const strikes = [670, 500, 240];
  const records = [];
  for (let i = 0; i < count; i++) {
    const ticker = names[i];
    const strike = strikes[i];
    const id = `172779000000${i}-${ticker}|2026-12-18|${strike}|call`;
    records.push({
      id,
      alertId: id,
      openedAt: Date.parse("2026-10-12T15:00:00Z"),
      ticker,
      putCall: "call",
      strike,
      expiration: "2026-12-18",
      grade: "A",
      cohort: "ab",
      contracts: 1,
      entryPrice: 1.2,
      status: "open",
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      marks: [],
    });
  }
  return JSON.stringify({ version: 1, records });
}

function book(count: number): { alerts: string; shadows: string } {
  const names = ["SPY", "QQQ", "IWM"];
  const strikes = [670, 500, 240];
  const research: ResearchTrack[] = [];
  for (let i = 0; i < count; i++) {
    const ticker = names[i];
    const strike = strikes[i];
    research.push({
      id: `172779000000${i}-${ticker}|2026-12-18|${strike}|call`,
      contractKey: `${ticker}|2026-12-18|${strike}|call`,
      alertId: null,
      openedAt: Date.parse("2026-10-12T15:00:00Z"),
      ticker,
      putCall: "call",
      strike,
      expiration: "2026-12-18",
      grade: "C",
      entryPrice: 1.2,
      entryUnderlying: null,
      spyTrend: "up",
      marks: [],
    });
  }
  return {
    alerts: JSON.stringify({ version: 1, records: [] }),
    shadows: JSON.stringify({ version: 1, records: [], research }),
  };
}
