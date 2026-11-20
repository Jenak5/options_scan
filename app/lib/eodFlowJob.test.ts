import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runEodFlowJob,
  type EodJobOptions,
} from "@/app/lib/eodFlowJob";
import type { EodContract, EodReading, EodRootLoad } from "@/app/lib/eodFlow";
import { SCAN_TIME_BUDGET_MS } from "@/app/lib/scanHealth";
import { clearMemoryStoreForTests, readEodFlowText } from "@/app/lib/schwabStore";
import { parseEodBook } from "@/app/lib/eodFlow";

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "SESSION_SECRET",
  "NODE_ENV",
  "VERCEL",
] as const;

const saved: Record<string, string | undefined> = {};

function contract(id: string, putCall: "put" | "call", strike: number, dte: number): EodContract {
  return { id, root: "QQQ", expiration: "2026-07-16", strike, putCall, dte, settled: false };
}

function load(root: string): EodRootLoad {
  if (root === "QQQ") {
    return {
      contracts: [contract("put", "put", 500, 1), contract("call", "call", 510, 10)],
      readings: {},
    };
  }
  return { contracts: [], readings: {} };
}

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
  vi.restoreAllMocks();
});

describe("end-of-day flow job", () => {
  it("uses the scanner time budget", () => {
    expect(SCAN_TIME_BUDGET_MS).toBe(240_000);
  });

  it("does not read a chain on a holiday or outside the 4:20pm New York window", async () => {
    const loadRoot = vi.fn(async () => load("QQQ"));
    const holiday = await runEodFlowJob({
      now: new Date("2026-11-26T21:20:00Z"),
      manual: true,
      loadRoot,
    });
    const early = await runEodFlowJob({
      now: new Date("2026-07-16T20:19:00Z"),
      loadRoot,
    });
    expect(holiday).toMatchObject({ ok: true, skipped: "market holiday" });
    expect(early.skipped).toBe("Outside the 4:20pm America/New_York end-of-day window");
    expect(loadRoot).not.toHaveBeenCalled();
    expect(await readEodFlowText()).toBeNull();
  });

  it("stops at the time budget and finishes the same day on the next run", async () => {
    let clock = 0;
    const calls: string[][] = [];
    const options = (budgetMs: number): EodJobOptions => ({
      now: new Date("2026-07-16T20:20:00Z"),
      budgetMs,
      nowMs: () => clock,
      chunkSize: 1,
      loadRoot: async (root) => load(root),
      loadChunk: async (ids) => {
        calls.push([...ids]);
        clock += 90_000;
        const readings: Record<string, EodReading> = {};
        for (let i = 0; i < ids.length; i++) readings[ids[i]] = { dayVolume: ids[i] === "put" ? 30 : 10, openInterest: 4 };
        return readings;
      },
    });
    const first = await runEodFlowJob(options(100_000));
    expect(first.saved).toEqual(["SPY"]);
    expect(first.pending).toBe("QQQ");
    expect(first.remainingChunks).toBe(1);
    expect(calls).toEqual([["put"]]);
    const firstBook = parseEodBook(await readEodFlowText());
    expect(firstBook?.rows.find((row) => row.date === "2026-07-16")?.underlying).toBe("SPY");
    expect(firstBook?.rows.find((row) => row.date === "2026-11-19" && row.underlying === "QQQ")?.note).toBe("late pull 11:20 PM CT");

    const second = await runEodFlowJob(options(200_000));
    expect(second.ok).toBe(true);
    expect(second.saved).toEqual(["QQQ", "NDX", "VIX"]);
    expect(second.pending).toBeNull();
    const book = parseEodBook(await readEodFlowText());
    const qqq = book?.rows.find((row) => row.date === "2026-07-16" && row.underlying === "QQQ");
    expect(qqq).toMatchObject({
      date: "2026-07-16",
      putVolume: 30,
      callVolume: 10,
      putCallVolumeRatio: 3,
      friday: false,
      earlyClose: false,
      volumeCoverage: 100,
    });
    const ndx = book?.rows.find((row) => row.date === "2026-07-16" && row.underlying === "NDX");
    expect(ndx?.putVolume).toBeNull();
    expect(ndx?.contractCount).toBe(0);
    expect(ndx?.volumeCoverage).toBeNull();
  });

  it("flags an early close and overwrites a rerun instead of adding a second row", async () => {
    let volume = 4;
    const run = (now: Date, manual = false) => runEodFlowJob({
      now,
      manual,
      loadRoot: async (root): Promise<EodRootLoad> => {
        if (root !== "QQQ") return { contracts: [], readings: {} };
        return {
          contracts: [{ ...contract("put", "put", 500, 0), settled: true }],
          readings: { put: { dayVolume: volume, openInterest: 2 } },
        };
      },
      loadChunk: async () => {
        throw new Error("settled contracts do not need a feed");
      },
    });
    const early = await run(new Date("2026-11-27T21:20:00Z"));
    expect(early.ok).toBe(true);
    expect(early.saved).toEqual(["SPY", "QQQ", "NDX", "VIX"]);
    volume = 11;
    const again = await run(new Date("2026-11-27T21:22:00Z"), true);
    expect(again.ok).toBe(true);
    const book = parseEodBook(await readEodFlowText());
    const rows = book?.rows.filter((row) => row.date === "2026-11-27" && row.underlying === "QQQ") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ putVolume: 11, friday: true, earlyClose: true, volumeCoverage: 100, note: null });
  });

  it("does not collect again when today's rows are already stored", async () => {
    const loadRoot = vi.fn(async (root: string) => load(root));
    const loadChunk = vi.fn(async (ids: readonly string[]) => {
      const readings: Record<string, EodReading> = {};
      for (let i = 0; i < ids.length; i++) readings[ids[i]] = { dayVolume: 1, openInterest: 1 };
      return readings;
    });
    const now = new Date("2026-07-16T20:20:00Z");
    await runEodFlowJob({ now, loadRoot, loadChunk });
    loadRoot.mockClear();
    const second = await runEodFlowJob({ now: new Date("2026-07-16T20:30:00Z"), loadRoot, loadChunk });
    expect(second.skipped).toBe("already collected");
    expect(loadRoot).not.toHaveBeenCalled();
  });
});
