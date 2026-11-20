import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as cronGet } from "@/app/api/cron/route";
import { GET as eodGet } from "@/app/api/cron/eod-flow/route";
import { GET, POST } from "@/app/api/scan/pause/route";
import * as alertFollow from "@/app/lib/alertFollowUp";
import * as callsRun from "@/app/lib/callsPaperRun";
import * as eodJob from "@/app/lib/eodFlowJob";
import * as flowScan from "@/app/lib/flowScan";
import * as jgRun from "@/app/lib/jgVwapRun";
import { effectiveScanPaused, emptyScanPauseBook, setScanPaused } from "@/app/lib/scanPause";
import { clearMemoryStoreForTests } from "@/app/lib/schwabStore";
import * as shadowStore from "@/app/lib/shadowStore";
import * as unusualStore from "@/app/lib/unusualFlowStore";

const SESSION = new Date("2026-10-06T15:00:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearMemoryStoreForTests();
});

describe("scan pause switch", () => {
  it("defaults to paused, turns off from the store, and the env forces the full scan", () => {
    expect(effectiveScanPaused(null, false)).toBe(true);
    expect(effectiveScanPaused(emptyScanPauseBook(), false)).toBe(true);
    expect(effectiveScanPaused({ version: 1, paused: false }, false)).toBe(false);
    expect(effectiveScanPaused({ version: 1, paused: true }, true)).toBe(false);
  });

  it("runs only AVWAP work when paused, and the flow scan when the switch is off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SESSION);
    vi.stubEnv("CRON_SECRET", "cron-token");
    const scan = vi.spyOn(flowScan, "scanEstimatedFlow").mockResolvedValue({
      rows: [],
      scannedAt: SESSION.getTime(),
      cached: false,
      watchlist: [],
      errors: [],
      chainInterest: { openInterest: {}, tickers: [] },
    });
    const follow = vi.spyOn(alertFollow, "runAlertFollowUps").mockResolvedValue({ updated: 0, quoted: 0 });
    const shadows = vi.spyOn(shadowStore, "openMissingShadows").mockResolvedValue({ opened: 0, saved: true });
    const calls = vi.spyOn(callsRun, "runCallsPaper").mockResolvedValue({
      opened: 0, openedA: 0, openedS: 0, closed: 0, saved: true, skipped: null, drawdownFlag: false, logNote: "paused test",
    });
    const jg = vi.spyOn(jgRun, "runJgVwapPaper").mockResolvedValue({
      opened: 0, closed: 0, saved: true, skipped: null, spxRoot: null, spxUnavailable: false, logNote: "paused test",
    });
    const unusual = vi.spyOn(unusualStore, "runUnusualFlowPass").mockResolvedValue({
      skipped: null, saved: true, newFlags: 0, outcomes: 0,
    });

    const paused = await cronGet(authed());
    expect(paused.status).toBe(200);
    const pausedBody = await paused.json();
    expect(pausedBody.paused).toBe(true);
    expect(pausedBody.reason).toBe("paused: AVWAP only");
    expect(String(pausedBody.log)).toContain("AVWAP paper");
    expect(String(pausedBody.log)).toContain("AVWAP trial");
    expect(String(pausedBody.log)).toContain("Scan paused: AVWAP only");
    expect(scan).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
    expect(shadows).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
    expect(jg).not.toHaveBeenCalled();
    expect(unusual).not.toHaveBeenCalled();

    vi.stubEnv("SCAN_PAUSE_NON_AVWAP", "0");
    const full = await cronGet(new NextRequest("https://options-scan.vercel.app/api/cron?manual=true", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(full.status).toBe(200);
    const fullBody = await full.json();
    expect(fullBody.paused).toBeUndefined();
    expect(scan).toHaveBeenCalled();
  });

  it("stores the flip and requires a session or bearer", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    const denied = await GET(new NextRequest("https://options-scan.vercel.app/api/scan/pause"));
    expect(denied.status).toBe(401);
    const deniedPost = await POST(new NextRequest("https://options-scan.vercel.app/api/scan/pause", {
      method: "POST",
      body: JSON.stringify({ paused: false }),
    }));
    expect(deniedPost.status).toBe(401);
    const headers = { authorization: "Bearer cron-token" };
    const first = await GET(new NextRequest("https://options-scan.vercel.app/api/scan/pause", { headers }));
    expect(await first.json()).toMatchObject({ paused: true, forced: false });
    const off = await POST(new NextRequest("https://options-scan.vercel.app/api/scan/pause", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    }));
    expect((await off.json()).paused).toBe(false);
    expect(await setScanPaused(true)).toBe(true);
    const again = await GET(new NextRequest("https://options-scan.vercel.app/api/scan/pause", { headers }));
    expect((await again.json()).paused).toBe(true);
    vi.stubEnv("SCAN_PAUSE_NON_AVWAP", "0");
    const forced = await GET(new NextRequest("https://options-scan.vercel.app/api/scan/pause", { headers }));
    expect(await forced.json()).toMatchObject({ paused: false, forced: true });
  });

  it("still runs the EOD flow cron while the scan pause is on", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    expect(await setScanPaused(true)).toBe(true);
    const job = vi.spyOn(eodJob, "runEodFlowJob").mockResolvedValue({
      ok: true,
      skipped: null,
      reason: null,
      date: "2026-11-20",
      saved: [],
      pending: null,
      remainingChunks: 0,
      errors: [],
    });
    const response = await eodGet(new NextRequest("https://options-scan.vercel.app/api/cron/eod-flow", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(response.status).toBe(200);
    expect(job).toHaveBeenCalled();
    const source = readFileSync(resolve(process.cwd(), "app/api/cron/eod-flow/route.ts"), "utf8");
    expect(source).not.toContain("nonAvwapScanPaused");
    expect(source).not.toContain("SCAN_PAUSE_NON_AVWAP");
  });
});

function authed(): NextRequest {
  return new NextRequest("https://options-scan.vercel.app/api/cron", {
    headers: { authorization: "Bearer cron-token" },
  });
}
