import { BlobPreconditionFailedError } from "@vercel/blob";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAlertFollowUps } from "@/app/lib/alertFollowUp";
import {
  currentDailyLoss,
  loadAlertBook,
  rememberDailyLoss,
  rememberSentAlert,
} from "@/app/lib/alertStore";
import type { FlowRow } from "@/app/lib/flow";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import {
  SCHWAB_BLOB_ALERT_BOOK_PATH,
  SCHWAB_BLOB_TOKEN_PATH,
} from "@/app/lib/schwabStorage";
import {
  clearMemoryStoreForTests,
  readTokens,
  setSchwabBlobClientForTests,
  writeTokens,
  type SchwabBlobClient,
  type SchwabBlobGetOptions,
  type SchwabBlobGetResult,
  type SchwabBlobPutOptions,
} from "@/app/lib/schwabStore";
import type { StoredTokens } from "@/app/lib/schwabParse";
import { gradeFlowRow } from "@/app/lib/verdict";

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
const NOW = new Date("2026-10-01T15:00:00Z");

function row(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "SPY|2026-10-08|105|call",
    ticker: "SPY",
    putCall: "call",
    strike: 105,
    expiration: "2026-10-08",
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
  setSchwabBlobClientForTests(null);
  vi.restoreAllMocks();
});

describe("alert book store", () => {
  it("saves a sent alert, a same-day loss count, and a later mid in memory", async () => {
    const verdict = gradeFlowRow(row(), null);
    expect(await rememberSentAlert(row(), verdict, NOW)).toBe(true);
    expect(await rememberSentAlert(row(), verdict, NOW)).toBe(true);
    const book = await loadAlertBook();
    expect(book.records).toHaveLength(1);
    expect(book.records[0].verdict).toBe("TAKE");
    expect(book.records[0].grade).toBe(verdict.grade);
    expect(book.records[0].bid).toBe(2);
    expect(book.records[0].ask).toBe(2.05);
    expect(book.records[0].mid).toBe(2.025);
    expect(book.records[0].flowScore).toBe(55);
    expect(book.records[0].liquidityPasses).toBe(true);
    expect(book.records[0].side).toBe("estimated at ask");

    expect(await rememberDailyLoss(2, NOW)).toBe(true);
    expect((await loadAlertBook()).dailyLoss?.consecutiveLosses).toBe(2);
    expect(await currentDailyLoss(NOW)).toBe(0);
    expect(await currentDailyLoss(new Date("2026-10-02T15:00:00Z"))).toBe(0);

    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    const follow = await runAlertFollowUps(later, async () => ({ mid: 2.025 * 1.25, underlying: 101 }));
    expect(follow.updated).toBe(1);
    expect(follow.quoted).toBe(1);
    const again = await loadAlertBook();
    expect(again.records[0].checkpoints.m15.status).toBe("quoted");
    expect(again.records[0].checkpoints.m15.midChangePct).toBeCloseTo(0.25);
    expect(again.records[0].outcome).toBe("win");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses to pretend the book was saved when production has no store", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.VERCEL;
    const verdict = gradeFlowRow(row(), null);
    expect(await rememberSentAlert(row(), verdict, NOW)).toBe(false);
    expect((await loadAlertBook()).records).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("writes the alert book to a private blob and leaves the token blob alone", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "fixture-blob-token";
    process.env.SESSION_SECRET = "unit-test-session-secret";
    const mock = createBlobMock();
    setSchwabBlobClientForTests(mock.client);
    const tokens: StoredTokens = {
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      accessExpiresAt: 1_700_000_000_000,
      refreshExpiresAt: 1_700_000_000_000 + 86_400_000,
    };
    await writeTokens(tokens);
    const tokenBody = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body;

    const verdict = gradeFlowRow(row(), null);
    expect(await rememberSentAlert(row(), verdict, NOW)).toBe(true);
    expect(await readTokens()).toEqual(tokens);
    expect(mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body).toBe(tokenBody);

    const body = mock.files.get(SCHWAB_BLOB_ALERT_BOOK_PATH)?.body ?? "";
    expect(body).toContain("SPY");
    expect(body.includes("fixture-access")).toBe(false);
    expect(body.includes("fixture-refresh")).toBe(false);
    const putCall = mock.put.mock.calls.find((call) => call[0] === SCHWAB_BLOB_ALERT_BOOK_PATH);
    expect(putCall?.[2]).toMatchObject({
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
      token: "fixture-blob-token",
    });
    const loaded = await loadAlertBook();
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].verdict).toBe(verdict.verdict);
  });
});

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createBlobMock() {
  const files = new Map<string, { body: string; etag: string }>();
  let seq = 0;
  const put = vi.fn(async (pathname: string, body: string, options: SchwabBlobPutOptions) => {
    const existing = files.get(pathname);
    if (options.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
      throw new BlobPreconditionFailedError();
    }
    seq += 1;
    files.set(pathname, { body, etag: `etag-${seq}` });
    return { pathname, etag: `etag-${seq}` };
  });
  const get = vi.fn(async (pathname: string, _options: SchwabBlobGetOptions): Promise<SchwabBlobGetResult | null> => {
    const existing = files.get(pathname);
    if (!existing) return null;
    return {
      statusCode: 200,
      stream: textStream(existing.body),
      blob: { etag: existing.etag, pathname },
    };
  });
  const del = vi.fn(async () => undefined);
  const client: SchwabBlobClient = { put, get, del };
  return { client, put, get, del, files };
}
