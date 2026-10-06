import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAlertGrade } from "@/app/lib/alertConfig";
import { loadAlertBook } from "@/app/lib/alertStore";
import type { FlowRow } from "@/app/lib/flow";
import { recordDisplayedAlerts } from "@/app/lib/pageScan";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { clearMemoryStoreForTests } from "@/app/lib/schwabStore";
import { loadShadowPage } from "@/app/lib/shadowStore";
import { gradeFlowRow } from "@/app/lib/verdict";

const NOW = new Date("2026-05-14T15:00:00Z");

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "SCHWAB_CLIENT_ID",
  "SCHWAB_CLIENT_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "NODE_ENV",
  "VERCEL",
] as const;

const saved: Record<string, string | undefined> = {};

function row(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "SPY|2026-06-04|104|call",
    ticker: "SPY",
    putCall: "call",
    strike: 104,
    expiration: "2026-06-04",
    bid: 2,
    ask: 2.05,
    last: 2.04,
    volume: 800,
    openInterest: 500,
    iv: 0.25,
    delta: 0.4,
    mid: 2.025,
    notionalPremium: 162_000,
    volOiRatio: 1.6,
    volumeOiJump: 300,
    volumeExceedsOi: true,
    previousVolume: 650,
    volumeJump: 150,
    otmPoints: 4,
    otmFraction: 0.04,
    otm: true,
    dte: 21,
    spreadFraction: 0.025,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "Estimated from the last price versus the bid and ask. Not a sweep print.",
    askFraction: 0.8,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 100,
    levels: null,
    earnings: { status: "known", date: "2026-12-20", timing: "after-market", estimated: false },
    prints: EMPTY_PRINTS,
    score: 55,
    ...over,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearMemoryStoreForTests();
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("network");
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearMemoryStoreForTests();
  vi.restoreAllMocks();
});

describe("Flow page alerts", () => {
  it("saves an A or B, opens its shadow, and marks it from the chain already scanned", async () => {
    const sample = row();
    const verdict = gradeFlowRow(sample, null, NOW);
    expect(verdict.verdict).toBe("TAKE");
    expect(isAlertGrade(verdict.grade)).toBe(true);

    const first = await recordDisplayedAlerts([sample], null, NOW);
    expect(first.saved).toBe(1);
    expect(first.opened).toBe(1);
    expect(first.marked).toBe(1);
    const book = await loadAlertBook();
    expect(book.records).toHaveLength(1);
    expect(book.records[0].features?.capturedAtAlert).toBe(true);
    const page = await loadShadowPage(NOW);
    expect(page.open).toBe(1);

    const again = await recordDisplayedAlerts([sample], null, NOW);
    expect(again.saved).toBe(0);
    expect(again.opened).toBe(0);
    expect(again.marked).toBe(0);
    expect((await loadAlertBook()).records).toHaveLength(1);
  });

  it("does not save a contract that is not an A or a B", async () => {
    const cheap = row({ notionalPremium: 1_000, volume: 100, openInterest: 500, volOiRatio: 0.2, volumeJump: 0 });
    const verdict = gradeFlowRow(cheap, null, NOW);
    expect(isAlertGrade(verdict.grade)).toBe(false);
    const recorded = await recordDisplayedAlerts([cheap], null, NOW);
    expect(recorded.saved).toBe(0);
    expect(recorded.opened).toBe(0);
    expect((await loadAlertBook()).records).toHaveLength(0);
  });
});
