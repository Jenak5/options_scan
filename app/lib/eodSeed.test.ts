import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EodRowNote } from "@/app/eod/EodRowNote";
import { eodOverallRows, mergeEodSeed, type EodFlowRow } from "@/app/lib/eodFlow";
import { eodSeedRows, loadEodPage } from "@/app/lib/eodFlowJob";
import { clearMemoryStoreForTests, updateEodFlow } from "@/app/lib/schwabStore";

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

describe("Nov 19 end-of-day seed", () => {
  it("is only QQQ and NDX, with the given figures and a late-pull note", () => {
    const rows = eodSeedRows();
    expect(rows.map((row) => row.underlying).sort()).toEqual(["NDX", "QQQ"]);
    const qqq = rows.find((row) => row.underlying === "QQQ");
    const ndx = rows.find((row) => row.underlying === "NDX");
    expect(qqq).toMatchObject({
      date: "2026-11-19",
      putVolume: 5378584,
      callVolume: 5345015,
      putCallVolumeRatio: 1.0063,
      putOpenInterest: 3907289,
      callOpenInterest: 4179547,
      putCallOiRatio: 0.934859,
      putVolume0to7: 4894034,
      callVolume0to7: 4780093,
      putVolume8to45: 484550,
      callVolume8to45: 564922,
      volumeCoverage: 64.8,
      oiCoverage: 100,
      contractCount: 5748,
      friday: false,
      earlyClose: false,
      collectedAt: 1795152000000,
      note: "late pull 11:20 PM CT",
      topStrikes: [
        { strike: 650, putCall: "put", volume: 289667 },
        { strike: 645, putCall: "put", volume: 228611 },
        { strike: 660, putCall: "call", volume: 180288 },
        { strike: 665, putCall: "call", volume: 169783 },
        { strike: 670, putCall: "call", volume: 161278 },
      ],
    });
    expect(ndx).toMatchObject({
      date: "2026-11-19",
      putVolume: 44084,
      callVolume: 42664,
      putCallVolumeRatio: 1.0333,
      putOpenInterest: 85226,
      callOpenInterest: 68251,
      putCallOiRatio: 1.248714,
      putVolume0to7: 39051,
      callVolume0to7: 37506,
      putVolume8to45: 5033,
      callVolume8to45: 5158,
      volumeCoverage: 21.6,
      oiCoverage: 100,
      contractCount: 13114,
      friday: false,
      earlyClose: false,
      collectedAt: 1795152000000,
      note: "late pull 11:20 PM CT",
      topStrikes: [
        { strike: 27000, putCall: "call", volume: 2545 },
        { strike: 27010, putCall: "call", volume: 1676 },
        { strike: 26500, putCall: "put", volume: 1612 },
        { strike: 26400, putCall: "put", volume: 1410 },
        { strike: 27700, putCall: "call", volume: 1015 },
      ],
    });
    expect(eodOverallRows(rows)[0].equityPutCallVolume).toBeNull();
  });

  it("fills a missing date and underlying, and keeps a stored row", async () => {
    const empty = await loadEodPage();
    expect(empty.rows.map((row) => `${row.date}:${row.underlying}`)).toEqual([
      "2026-11-19:NDX",
      "2026-11-19:QQQ",
    ]);

    const stored: EodFlowRow = {
      ...eodSeedRows()[0],
      underlying: "QQQ",
      putVolume: 1,
      note: null,
    };
    expect(await updateEodFlow(() => JSON.stringify({ version: 1, rows: [stored], work: null, lockUntil: null }))).toBe(true);
    const page = await loadEodPage();
    const qqq = page.rows.find((row) => row.underlying === "QQQ");
    const ndx = page.rows.find((row) => row.underlying === "NDX");
    expect(qqq?.putVolume).toBe(1);
    expect(qqq?.note).toBeNull();
    expect(ndx?.putVolume).toBe(44084);
    expect(ndx?.note).toBe("late pull 11:20 PM CT");
    expect(page.rows.some((row) => row.underlying === "SPY" || row.underlying === "VIX")).toBe(false);
  });

  it("renders the late-pull note and leaves a normal row blank", () => {
    const shown = EodRowNote({ note: "late pull 11:20 PM CT" });
    expect(shown).not.toBeNull();
    expect(shown?.props.children).toBe("late pull 11:20 PM CT");
    expect(EodRowNote({ note: null })).toBeNull();
    const seed = eodSeedRows();
    const merged = mergeEodSeed([{ ...seed[1], note: null }], seed);
    expect(merged.find((row) => row.underlying === "NDX")?.note).toBeNull();
    expect(merged.find((row) => row.underlying === "QQQ")?.note).toBe("late pull 11:20 PM CT");
  });
});
