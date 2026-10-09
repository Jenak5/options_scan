import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as alertsGet } from "@/app/api/alerts/route";
import { GET as cronGet } from "@/app/api/cron/route";
import { GET as flowGet } from "@/app/api/flow/route";
import * as flowScan from "@/app/lib/flowScan";
import * as schwab from "@/app/lib/schwab";
import { clearMemoryStoreForTests, readScanHealth } from "@/app/lib/schwabStore";
import * as schwabStore from "@/app/lib/schwabStore";
import * as shadowStore from "@/app/lib/shadowStore";

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "SCHWAB_CLIENT_ID",
  "SCHWAB_CLIENT_SECRET",
  "CRON_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "XAI_API_KEY",
  "FLOW_WATCHLIST",
] as const;

const saved: Record<string, string | undefined> = {};

function emptyScan() {
  return {
    rows: [],
    scannedAt: Date.now(),
    cached: false,
    watchlist: [] as string[],
    errors: [],
    chainInterest: { openInterest: {}, tickers: [] as string[] },
  };
}

function authed(path: string): NextRequest {
  return new NextRequest(`https://options-scan.vercel.app${path}`, {
    headers: { authorization: "Bearer cron-token" },
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CRON_SECRET = "cron-token";
  clearMemoryStoreForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(flowScan, "scanEstimatedFlow").mockResolvedValue(emptyScan());
  vi.spyOn(schwab, "getOptionChain").mockRejectedValue(new Error("holiday test must not read a chain"));
  vi.spyOn(schwabStore, "writeScanHealth");
  vi.spyOn(shadowStore, "openMissingShadows");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearMemoryStoreForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduled scans on the NYSE calendar", () => {
  it("skips a full-day holiday before Schwab, the shadow book, or scan health", async () => {
    vi.setSystemTime(new Date("2026-11-26T15:00:00Z"));
    const scan = vi.mocked(flowScan.scanEstimatedFlow);
    const chain = vi.mocked(schwab.getOptionChain);
    const shadows = vi.mocked(shadowStore.openMissingShadows);
    const health = vi.mocked(schwabStore.writeScanHealth);

    const denied = await cronGet(new NextRequest("https://options-scan.vercel.app/api/cron"));
    expect(denied.status).toBe(401);

    const manual = await cronGet(authed("/api/cron?manual=true"));
    expect(manual.status).toBe(200);
    expect(await manual.json()).toEqual({ skipped: "market holiday" });

    const alerts = await alertsGet(authed("/api/alerts?action=scan"));
    expect(alerts.status).toBe(200);
    expect(await alerts.json()).toEqual({ skipped: "market holiday" });

    expect(scan).not.toHaveBeenCalled();
    expect(chain).not.toHaveBeenCalled();
    expect(shadows).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
  });

  it("still scans on the day after Thanksgiving", async () => {
    vi.setSystemTime(new Date("2026-11-27T15:00:00Z"));
    const scan = vi.mocked(flowScan.scanEstimatedFlow);
    const cron = await cronGet(authed("/api/cron"));
    expect(cron.status).toBe(200);
    const body = await cron.json();
    expect(body.skipped).not.toBe("market holiday");
    expect(scan).toHaveBeenCalled();
    expect(vi.mocked(schwabStore.writeScanHealth)).toHaveBeenCalled();

    scan.mockClear();
    const alerts = await alertsGet(authed("/api/alerts?action=scan"));
    expect(alerts.status).toBe(200);
    expect((await alerts.json()).skipped).not.toBe("market holiday");
    expect(scan).toHaveBeenCalled();
  });

  it("still scans on Columbus Day 2026-10-12", async () => {
    vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
    const scan = vi.mocked(flowScan.scanEstimatedFlow);
    const cron = await cronGet(authed("/api/cron"));
    expect(cron.status).toBe(200);
    expect((await cron.json()).skipped).not.toBe("market holiday");
    expect(scan).toHaveBeenCalled();
  });

  it("does not save a Flow page session on a holiday, and does on a half day", async () => {
    vi.setSystemTime(new Date("2026-11-26T15:00:00Z"));
    const holiday = await flowGet(authed("/api/flow"));
    expect(holiday.status).toBe(200);
    expect((await readScanHealth()).lastBrowserScanAt).toBeNull();

    vi.setSystemTime(new Date("2026-11-27T15:00:00Z"));
    const halfDay = await flowGet(authed("/api/flow"));
    expect(halfDay.status).toBe(200);
    expect((await readScanHealth()).lastBrowserScanAt).not.toBeNull();

    clearMemoryStoreForTests();
    vi.setSystemTime(new Date("2026-10-12T15:00:00Z"));
    const columbus = await flowGet(authed("/api/flow"));
    expect(columbus.status).toBe(200);
    expect((await readScanHealth()).lastBrowserScanAt).not.toBeNull();
  });
});
