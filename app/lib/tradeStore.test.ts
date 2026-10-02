import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDailyLoss, rememberSentAlert } from "@/app/lib/alertStore";
import type { FlowRow } from "@/app/lib/flow";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { SCHWAB_BLOB_TOKEN_PATH, SCHWAB_BLOB_TRADE_LOG_PATH } from "@/app/lib/schwabStorage";
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
import { closeLoggedTrade, openLoggedTrade, tradeLogCsv } from "@/app/lib/tradeStore";
import { gradeFlowRow } from "@/app/lib/verdict";
import { BlobPreconditionFailedError } from "@vercel/blob";

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
  setSchwabBlobClientForTests(null);
  vi.restoreAllMocks();
});

describe("trade log store", () => {
  it("turns two losing closes into the daily stop and keeps the linked grade", async () => {
    const verdict = gradeFlowRow(row(), null);
    expect(await rememberSentAlert(row(), verdict, NOW)).toBe(true);
    const bookId = `${NOW.getTime()}-SPY|2026-10-08|105|call`;
    const first = await openLoggedTrade(entry(bookId), NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.page.trades[0].alertVerdict).toBe("TAKE");
    expect(first.page.trades[0].alertGrade).toBe(verdict.grade);
    const opened = first.page.trades[0];
    const closed = await closeLoggedTrade(opened.id, { exitPrice: 1, closedAt: NOW.getTime() + 60_000, exitNote: "stopped" }, new Date(NOW.getTime() + 60_000));
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.page.stop.dailyStop).toBe(false);

    const secondOpen = await openLoggedTrade(entry(null), new Date(NOW.getTime() + 120_000));
    expect(secondOpen.ok).toBe(true);
    if (!secondOpen.ok) return;
    const second = secondOpen.page.trades.find((trade) => trade.closedAt == null);
    expect(second).toBeTruthy();
    const done = await closeLoggedTrade(second?.id ?? "", { exitPrice: 1, exitNote: "second loss" }, new Date(NOW.getTime() + 180_000));
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.page.stop.dailyStop).toBe(true);
    expect(await currentDailyLoss(new Date(NOW.getTime() + 180_000))).toBeGreaterThanOrEqual(2);
    expect(done.page.trades[0].metrics.result).toBe("loss");
    expect(done.page.stats.sampleNote).toMatch(/small/i);
    const csv = await tradeLogCsv();
    expect(csv).toContain("second loss");
    expect(csv.includes("fixture")).toBe(false);
  });

  it("writes the log to a private blob and leaves the token blob alone", async () => {
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
    const savedTrade = await openLoggedTrade(entry(null), NOW);
    expect(savedTrade.ok).toBe(true);
    expect(await readTokens()).toEqual(tokens);
    expect(mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body).toBe(tokenBody);
    const body = mock.files.get(SCHWAB_BLOB_TRADE_LOG_PATH)?.body ?? "";
    expect(body).toContain("SPY");
    expect(body.includes("fixture-access")).toBe(false);
    expect(body.includes("fixture-refresh")).toBe(false);
    const putCall = mock.put.mock.calls.find((call) => call[0] === SCHWAB_BLOB_TRADE_LOG_PATH);
    expect(putCall?.[2]).toMatchObject({
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
      token: "fixture-blob-token",
    });
  });
});

function entry(alertId: string | null) {
  return {
    ticker: "SPY",
    putCall: "call",
    strike: 105,
    expiration: "2026-10-08",
    contracts: 1,
    entryPrice: 2,
    alertId,
  };
}

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
