import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as cronGet } from "@/app/api/cron/route";
import { GET as flowGet } from "@/app/api/flow/route";
import { GET as healthGet } from "@/app/api/health/route";
import * as flowLib from "@/app/lib/flow";
import { TICKER_GROUP_PAUSE_MS } from "@/app/lib/flow";
import * as flowScan from "@/app/lib/flowScan";
import { clearMemoryStoreForTests, readScanHealth } from "@/app/lib/schwabStore";

const ENV_KEYS = ["CRON_SECRET", "HEALTH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "XAI_API_KEY", "FLOW_WATCHLIST"] as const;
const saved: Record<string, string | undefined> = {};

function emptyScan(errors: { ticker: string; message: string }[] = []) {
  return {
    rows: [],
    scannedAt: Date.now(),
    cached: false,
    watchlist: ["TLT", "XLF"],
    errors,
    chainInterest: { openInterest: {}, tickers: errors.length > 0 ? ["TLT"] : ["TLT", "XLF"] },
  };
}

function authed(path: string, token = "cron-token"): NextRequest {
  return new NextRequest(`https://options-scan.vercel.app${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CRON_SECRET = "cron-token";
  process.env.HEALTH_TOKEN = "health-token";
  clearMemoryStoreForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  vi.spyOn(flowScan, "scanEstimatedFlow").mockResolvedValue(emptyScan());
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

describe("partial scan health", () => {
  it("marks a scan partial when a ticker is skipped and reports that on /api/health", async () => {
    vi.mocked(flowScan.scanEstimatedFlow).mockResolvedValue(emptyScan([
      { ticker: "XLF", message: "XLF skipped: tastytrade 401" },
      { ticker: "not a ticker", message: "junk" },
    ]));

    const cron = await cronGet(authed("/api/cron?manual=true"));
    expect(cron.status).toBe(200);
    expect(vi.mocked(console.info).mock.calls.some((call) => String(call[0]).includes("AVWAP paper:"))).toBe(true);
    const health = await readScanHealth();
    expect(health.lastOutcome).toBe("partial");
    expect(health.lastSkippedTickers).toEqual(["XLF"]);

    const report = await healthGet(authed("/api/health", "health-token"));
    expect(report.status).toBe(200);
    const body = await report.json();
    expect(body.lastScanOutcome).toBe("partial");
    expect(body.lastCronOutcome).toBe("partial");
    expect(body.skippedTickers).toBe(1);
    expect(body.skippedTickerList).toEqual(["XLF"]);
    expect(JSON.stringify(body)).not.toContain("health-token");
    expect(JSON.stringify(body)).not.toContain("cron-token");

    vi.mocked(flowScan.scanEstimatedFlow).mockResolvedValue(emptyScan());
    vi.setSystemTime(new Date("2026-10-06T15:10:00Z"));
    const again = await cronGet(authed("/api/cron?manual=true"));
    expect(again.status).toBe(200);
    const cleared = await readScanHealth();
    expect(cleared.lastOutcome).toBe("success");
    expect(cleared.lastSkippedTickers).toEqual([]);
  });

  it("asks the flow scan to reuse recent chains even on a fresh pull, and pauses before the next group", async () => {
    const scan = vi.mocked(flowScan.scanEstimatedFlow);
    const pause = vi.spyOn(flowLib, "pauseBetweenTickerGroups").mockResolvedValue();

    const fresh = await flowGet(authed("/api/flow?fresh=true"));
    expect(fresh.status).toBe(200);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({
      bypassCache: true,
      reuseRecentChains: true,
      groupPauseMs: TICKER_GROUP_PAUSE_MS,
    }));
    expect(pause).not.toHaveBeenCalled();

    scan.mockClear();
    const next = await flowGet(authed("/api/flow?offset=9"));
    expect(next.status).toBe(200);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({
      bypassCache: false,
      reuseRecentChains: true,
      groupPauseMs: TICKER_GROUP_PAUSE_MS,
    }));

    scan.mockClear();
    const cron = await cronGet(authed("/api/cron?manual=true"));
    expect(cron.status).toBe(200);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({
      groupPauseMs: TICKER_GROUP_PAUSE_MS,
    }));
    expect(scan.mock.calls.some((call) => call[0]?.reuseRecentChains === true)).toBe(false);
  });
});
