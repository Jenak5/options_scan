import { describe, expect, it } from "vitest";
import type { StoredAlert } from "@/app/lib/alertBook";
import { hasHealthBearer } from "@/app/lib/auth";
import { buildHealthReport, countShadowTotals } from "@/app/lib/healthReport";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { shadowFromAlert, type ShadowTrade } from "@/app/lib/shadow";

const NOW = new Date("2026-10-06T18:00:00Z");

function alert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    tradingDay: "2026-10-06",
    features: { capturedAtAlert: true },
    ...over,
  } as StoredAlert;
}

describe("health report", () => {
  it("counts today's saved alerts and captured snapshots and leaves secrets out", () => {
    const report = buildHealthReport({
      health: {
        ...emptyScanHealth(),
        lastRunAt: Date.parse("2026-10-06T17:00:00Z"),
        lastOutcome: "skipped",
        lastBrowserScanAt: Date.parse("2026-10-06T18:05:00Z"),
        lastShadowAt: Date.parse("2026-10-06T18:05:00Z"),
      },
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [
        alert(),
        alert({ features: { capturedAtAlert: false } as StoredAlert["features"] }),
        alert({ tradingDay: "2026-10-05" }),
      ],
      openShadows: 2,
      resolvedShadows: 4,
      now: NOW,
    });
    expect(report).toEqual({
      lastScanAt: "2026-10-06T18:05:00.000Z",
      lastScanOutcome: "success",
      lastCronAt: "2026-10-06T17:00:00.000Z",
      lastCronOutcome: "skipped",
      lastBrowserScanAt: "2026-10-06T18:05:00.000Z",
      schwabConnected: true,
      tastytradeEnabled: false,
      alertsSavedToday: 2,
      openShadows: 2,
      lastShadowAt: "2026-10-06T18:05:00.000Z",
      learningSnapshotsToday: 1,
      resolvedShadows: 4,
      rulesVersion: 3,
    });
    expect(JSON.stringify(report)).not.toContain("token");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("counts open and resolved A/B shadows and skips the test book", () => {
    const open = shadowFromAlert(storedShadowAlert("A"));
    const closed = shadowFromAlert(storedShadowAlert("B"));
    if (!open || !closed) throw new Error("expected shadows");
    const resolved: ShadowTrade = {
      ...closed,
      id: "other",
      status: "closed",
      exitPrice: 3,
      pnlDollars: 100,
    };
    const test: ShadowTrade = { ...open, id: "test", grade: "test", cohort: "experiment" };
    expect(countShadowTotals([open, resolved, test])).toEqual({ openShadows: 1, resolvedShadows: 1 });
  });
});

describe("health bearer", () => {
  it("uses HEALTH_TOKEN when set and CRON_SECRET only as the fallback", async () => {
    const health = new Request("https://options-scan.vercel.app/api/health", {
      headers: { authorization: "Bearer health-token" },
    });
    const cron = new Request("https://options-scan.vercel.app/api/health", {
      headers: { authorization: "Bearer cron-token" },
    });
    const env = { HEALTH_TOKEN: "health-token", CRON_SECRET: "cron-token" };
    expect(await hasHealthBearer(health, env)).toBe(true);
    expect(await hasHealthBearer(cron, env)).toBe(false);
    expect(await hasHealthBearer(cron, { CRON_SECRET: "cron-token" })).toBe(true);
    expect(await hasHealthBearer(health, {})).toBe(false);
    expect(await hasHealthBearer(new Request("https://options-scan.vercel.app/api/health"), env)).toBe(false);
  });
});

function storedShadowAlert(grade: "A" | "B"): StoredAlert {
  return {
    id: `1727790000000-SPY|2026-10-16|670|${grade}`,
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: Date.parse("2026-10-01T15:00:00Z"),
    tradingDay: "2026-10-01",
    ticker: "SPY",
    putCall: "call",
    strike: 670,
    expiration: "2026-10-16",
    bid: 1.9,
    ask: 2,
    grade,
    features: { capturedAtAlert: true },
  } as StoredAlert;
}
