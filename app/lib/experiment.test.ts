import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { ALERT_RULES, EXPERIMENT_DTE } from "@/app/lib/alertConfig";
import { chooseAlerts } from "@/app/lib/alertPolicy";
import {
  chooseExperimental,
  experimentProbe,
  experimentWindow,
  experimentalShadow,
} from "@/app/lib/experiment";
import { SHADOW_QUOTES_PER_RUN, type FlowRow } from "@/app/lib/flow";
import type { KeyLevels } from "@/app/lib/levels";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { clearMemoryStoreForTests, readShadowBookText, updateShadowBook } from "@/app/lib/schwabStore";
import {
  applyShadowQuote,
  parseShadowBook,
  shadowFromAlert,
  shadowsToCsv,
  shadowsToQuote,
  summarizeShadows,
  type ShadowTrade,
} from "@/app/lib/shadow";
import { openScanTickers, recordExperimentalShadows } from "@/app/lib/shadowStore";
import { gradeFlowRow } from "@/app/lib/verdict";

/** After the last listed macro, so a quiet 50-day contract can probe as an A. */
const NOW = new Date("2026-12-16T15:00:00Z");
const OPEN = new Date("2026-10-01T15:00:00Z");

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

describe("43-60 day test shadows", () => {
  it("leaves the 14 to 42 day rule and the quote cap where they are", () => {
    expect(ALERT_RULES.alertDteMin).toBe(14);
    expect(ALERT_RULES.alertDteMax).toBe(42);
    expect(EXPERIMENT_DTE.min).toBe(43);
    expect(EXPERIMENT_DTE.max).toBe(60);
    expect(EXPERIMENT_DTE.label).toBe("Test: 43-60 DTE");
    expect(EXPERIMENT_DTE.minTrust).toBe(30);
    expect(EXPERIMENT_DTE.opensPerRun).toBe(2);
    expect(EXPERIMENT_DTE.opensPerDay).toBe(4);
    expect(EXPERIMENT_DTE.quotesPerRun).toBe(4);
    expect(SHADOW_QUOTES_PER_RUN).toBe(16);
    expect(MAX_LOSS_DOLLARS).toBe(875);
    expect(experimentWindow(42)).toBe(false);
    expect(experimentWindow(43)).toBe(true);
    expect(experimentWindow(60)).toBe(true);
    expect(experimentWindow(61)).toBe(false);
  });

  it("probes a contract the other rules would pass and does not grade the real row A or B", () => {
    const longDated = longRow();
    expect(experimentProbe(longDated, null, NOW)).toBe("A");
    const real = gradeFlowRow(longDated, null, NOW);
    expect(real.grade).not.toBe("A");
    expect(real.grade).not.toBe("B");
    expect(real.verdict).not.toBe("TAKE");
    expect(chooseAlerts({
      candidates: [{ row: longDated, verdict: real }],
      alreadySentContractKeys: new Set(),
      alreadySentSetupKeys: new Set(),
      limit: 5,
    })).toEqual([]);

    const stillAb = longRow({ dte: 42, expiration: "2027-01-27", id: "NVDA|2027-01-27|104|call" });
    expect(experimentProbe(stillAb, null, NOW)).toBeNull();
    const graded = gradeFlowRow(stillAb, null, NOW);
    expect(graded.grade).toBe("A");
    expect(graded.verdict).toBe("TAKE");
    expect(chooseAlerts({
      candidates: [{ row: stillAb, verdict: graded }],
      alreadySentContractKeys: new Set(),
      alreadySentSetupKeys: new Set(),
      limit: 5,
    })).toHaveLength(1);

    expect(experimentProbe(longRow({ levels: null }), null, NOW)).toBe("B");
    expect(experimentProbe(longRow({ liquidityPasses: false }), null, NOW)).toBeNull();
    expect(experimentProbe(longRow({ delayed: true }), null, NOW)).toBeNull();
    expect(experimentProbe(longRow({ ask: 0 }), null, NOW)).toBeNull();
    expect(experimentProbe(longRow({ dte: 61 }), null, NOW)).toBeNull();
    expect(experimentProbe(longDated, 2, NOW)).toBeNull();
  });

  it("caps new test shadows per run and per day and skips a contract already shadowed", () => {
    const rows = [104, 105, 106, 107, 108].map((strike, index) => longRow({
      strike,
      id: `NVDA|2027-02-04|${strike}|call`,
      score: 10 * (index + 1),
    }));
    const first = chooseExperimental({ rows, consecutiveLosses: null, now: NOW, existing: [] });
    expect(first).toHaveLength(EXPERIMENT_DTE.opensPerRun);
    expect(first.map((pick) => pick.row.strike)).toEqual([108, 107]);
    expect(first.every((pick) => pick.probe === "A")).toBe(true);

    const opened = first.map((pick) => experimentalShadow(pick.row, pick.probe, NOW));
    const again = chooseExperimental({ rows, consecutiveLosses: null, now: NOW, existing: opened as ShadowTrade[] });
    expect(again.map((pick) => pick.row.strike)).toEqual([106, 105]);

    const today = opened.concat(again.map((pick) => experimentalShadow(pick.row, pick.probe, NOW))) as ShadowTrade[];
    expect(today).toHaveLength(EXPERIMENT_DTE.opensPerDay);
    expect(chooseExperimental({ rows, consecutiveLosses: null, now: NOW, existing: today })).toEqual([]);
  });

  it("quotes A and B first and only spends leftover slots on the test", () => {
    const primary = Array.from({ length: 16 }, (_, index) => abShadow(index));
    const tests = Array.from({ length: 6 }, (_, index) => testShadow(200 + index));
    expect(shadowsToQuote(primary.concat(tests)).every((row) => row.cohort === "ab")).toBe(true);
    expect(shadowsToQuote(primary.concat(tests))).toHaveLength(SHADOW_QUOTES_PER_RUN);

    const partial = shadowsToQuote(primary.slice(0, 14).concat(tests));
    expect(partial.filter((row) => row.cohort === "ab")).toHaveLength(14);
    expect(partial.filter((row) => row.cohort === "experiment")).toHaveLength(2);
    expect(partial).toHaveLength(SHADOW_QUOTES_PER_RUN);

    const onlyTests = shadowsToQuote(tests);
    expect(onlyTests).toHaveLength(EXPERIMENT_DTE.quotesPerRun);
    expect(onlyTests.every((row) => row.grade === "test")).toBe(true);
  });

  it("keeps test results out of the A/B totals and closes them with the same exits", () => {
    const ab = shadowFromAlert(sentAlert());
    if (!ab) throw new Error("expected an A shadow");
    const win = applyShadowQuote(ab, { mid: 2.8, bid: 2.7 }, OPEN);
    const test = experimentalShadow(longRow(), "A", NOW);
    if (!test) throw new Error("expected a test shadow");
    expect(test.grade).toBe("test");
    expect(test.cohort).toBe("experiment");
    expect(test.experimentLabel).toBe(EXPERIMENT_DTE.label);
    expect(test.contracts).toBe(1);
    expect(test.entryPrice).toBe(longRow().ask);
    const closed = applyShadowQuote(test, { mid: 2.9, bid: 2.8 }, NOW);
    expect(closed.exitReason).toBe("profit");
    expect(closed.grade).toBe("test");

    const card = summarizeShadows([win, closed], new Set(), NOW);
    expect(card.resolved).toBe(1);
    expect(card.wins).toBe(1);
    expect(card.totalPnl).toBeCloseTo(80, 6);
    expect(card.experimental.resolved).toBe(1);
    expect(card.experimental.label).toBe("Test: 43-60 DTE");
    expect(card.experimental.tooFew).toBe(true);
    expect(card.experimental.trustNote).toMatch(/Fewer than 30/);
    expect(card.experimental.note).toMatch(/14–42 day rule is unchanged/);
    expect(card.rows.some((row) => row.cohort === "experiment")).toBe(false);
    expect(card.experimental.rows).toHaveLength(1);
    expect(card.experimental.rows[0].probeNote).toBe("The other rules would say A. This is not an A or a B.");

    const csv = shadowsToCsv([win, closed], new Set());
    const lines = csv.trim().split("\n");
    expect(lines[0].endsWith(",counted")).toBe(true);
    expect(lines.find((line) => line.startsWith(win.id))?.endsWith(",yes")).toBe(true);
    expect(lines.find((line) => line.startsWith(closed.id))?.endsWith(",no")).toBe(true);
    expect(csv).toContain("Test: 43-60 DTE");
  });

  it("round-trips a test shadow and keeps an older book without a cohort in the A/B set", () => {
    const test = experimentalShadow(longRow(), "A", NOW);
    const parsed = parseShadowBook(JSON.stringify({ version: 1, records: [test] })).records[0];
    expect(parsed.cohort).toBe("experiment");
    expect(parsed.grade).toBe("test");
    expect(parsed.probeGrade).toBe("A");
    expect(parsed.experimentLabel).toBe("Test: 43-60 DTE");

    const ab = shadowFromAlert(sentAlert());
    const raw = JSON.parse(JSON.stringify(ab)) as Record<string, unknown>;
    delete raw.cohort;
    delete raw.experimentLabel;
    delete raw.probeGrade;
    const kept = parseShadowBook(JSON.stringify({ version: 1, records: [raw] })).records[0];
    expect(kept.cohort).toBe("ab");
    expect(kept.grade).toBe("A");

    raw.grade = "A";
    raw.cohort = "experiment";
    expect(parseShadowBook(JSON.stringify({ version: 1, records: [raw] })).records).toHaveLength(0);

    raw.grade = "test";
    raw.cohort = "ab";
    const coerced = parseShadowBook(JSON.stringify({ version: 1, records: [raw] })).records[0];
    expect(coerced.grade).toBe("test");
    expect(coerced.cohort).toBe("experiment");
  });

  it("records test shadows from rows the scan already has and does not scan them as priority names", async () => {
    const rows = [104, 105, 106].map((strike) => longRow({
      strike,
      id: `NVDA|2027-02-04|${strike}|call`,
      score: strike,
    }));
    const saved = await recordExperimentalShadows(rows, null, NOW);
    expect(saved.opened).toBe(2);
    expect(saved.saved).toBe(true);
    const book = parseShadowBook(await readShadowBookText());
    expect(book.records.every((row) => row.grade === "test" && row.cohort === "experiment")).toBe(true);
    expect(await recordExperimentalShadows(rows, null, NOW)).toEqual({ opened: 1, saved: true });
    expect(await recordExperimentalShadows(rows, null, NOW)).toEqual({ opened: 0, saved: true });

    const hood = shadowFromAlert(sentAlert({
      id: "1727790000000-HOOD|2026-10-16|40|call",
      contractKey: "HOOD|2026-10-16|40|call",
      ticker: "HOOD",
    }));
    if (!hood) throw new Error("expected a HOOD shadow");
    const current = parseShadowBook(await readShadowBookText());
    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: current.records.concat(hood) }))).toBe(true);
    expect(await openScanTickers()).toEqual(["HOOD"]);
  });
});

function longRow(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "NVDA|2027-02-04|104|call",
    ticker: "NVDA",
    putCall: "call",
    strike: 104,
    expiration: "2027-02-04",
    bid: 2,
    ask: 2.05,
    last: 2.05,
    volume: 3000,
    openInterest: 1000,
    iv: 0.25,
    delta: 0.4,
    mid: 2.025,
    notionalPremium: 607_500,
    volOiRatio: 3,
    volumeOiJump: 2000,
    volumeExceedsOi: true,
    previousVolume: 2600,
    volumeJump: 400,
    otmPoints: 4,
    otmFraction: 0.04,
    otm: true,
    dte: 50,
    spreadFraction: 0.025,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "Estimated from the last price versus the bid and ask. Not a sweep print.",
    askFraction: 1,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 100,
    levels: levels(),
    prints: EMPTY_PRINTS,
    earnings: { status: "known", date: "2027-06-01", timing: "after-market", estimated: false },
    score: 80,
    ...over,
  };
}

function levels(): KeyLevels {
  return {
    checked: true,
    spot: 100,
    support: { price: 99, label: "prior day low", distance: 0.01 },
    resistance: { price: 102, label: "session high", distance: 0.02 },
    vwap: 100.4,
    sma20: null,
    priorClose: 99.5,
    callWall: 105,
    putWall: 95,
  };
}

function sentAlert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "1727790000000-SPY|2026-10-16|670|call",
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: OPEN.getTime(),
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

function abShadow(index: number): ShadowTrade {
  const row = shadowFromAlert(sentAlert({
    id: `1727790000000-T${index}|2026-10-16|100|call`,
    contractKey: `T${index}|2026-10-16|100|call`,
    ticker: `T${index}`,
  }));
  if (!row) throw new Error("expected an A shadow");
  return row;
}

function testShadow(strike: number): ShadowTrade {
  const row = experimentalShadow(longRow({
    strike,
    id: `NVDA|2027-02-04|${strike}|call`,
    ticker: "NVDA",
  }), "B", NOW);
  if (!row) throw new Error("expected a test shadow");
  return row;
}
