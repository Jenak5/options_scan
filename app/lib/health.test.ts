import { describe, expect, it } from "vitest";
import type { StoredAlert } from "@/app/lib/alertBook";
import { hasHealthBearer } from "@/app/lib/auth";
import { buildHealthReport, countShadowTotals, trackedAlertCounts } from "@/app/lib/healthReport";
import { emptyMarketDataHealth } from "@/app/lib/marketDataHealth";
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
      skippedTickers: 0,
      skippedTickerList: [],
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
      marketDay: true,
      reason: null,
      trackedAlertsTotal: 0,
      trackedAlertsActive: 0,
      trackedAlertsComplete: 0,
      candlesLastRun: null,
      candleAlertsCovered: 0,
      candleErrors: 0,
      candleErrorSample: null,
      avwapPaper: {
        paperOnly: true,
        open: 0,
        closed: 0,
        cumulativePnlDollars: 0,
        maxDrawdownDollars: 0,
        drawdownFlag: false,
        dailyStop: false,
        todayLossStreak: 0,
      },
      marketData: emptyMarketDataHealth(),
    });
    expect(JSON.stringify(report)).not.toContain("token");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("reports a full-day holiday so a missing scan is expected", () => {
    const report = buildHealthReport({
      health: emptyScanHealth(),
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [],
      openShadows: 0,
      resolvedShadows: 0,
      now: new Date("2026-11-26T15:00:00Z"),
    });
    expect(report.marketDay).toBe(false);
    expect(report.reason).toBe("holiday");
    expect(report.candlesLastRun).toBeNull();
    expect(report.candleAlertsCovered).toBe(0);
    expect(report.candleErrors).toBe(0);
    expect(report.candleErrorSample).toBeNull();
  });

  it("reports the last candle run without treating it as a scorecard exit", () => {
    const report = buildHealthReport({
      health: emptyScanHealth(),
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [],
      openShadows: 1,
      resolvedShadows: 2,
      candlesLastRun: "2026-10-13T20:30:00.000Z",
      candleAlertsCovered: 4,
      candleErrors: 1,
      candleErrorSample: "invalid_grant: refresh token is invalid",
      now: NOW,
    });
    expect(report.candlesLastRun).toBe("2026-10-13T20:30:00.000Z");
    expect(report.candleAlertsCovered).toBe(4);
    expect(report.candleErrors).toBe(1);
    expect(report.candleErrorSample).toBe("invalid_grant: refresh token is invalid");
    expect(report.resolvedShadows).toBe(2);
  });

  it("counts skipped tickers on the last scan and leaves an earlier cron list behind", () => {
    const cronPartial = buildHealthReport({
      health: {
        ...emptyScanHealth(),
        lastRunAt: Date.parse("2026-10-06T17:00:00Z"),
        lastOutcome: "partial",
        lastSkippedTickers: ["XLF", "GLD"],
      },
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [],
      openShadows: 0,
      resolvedShadows: 0,
      now: NOW,
    });
    expect(cronPartial.lastScanOutcome).toBe("partial");
    expect(cronPartial.lastCronOutcome).toBe("partial");
    expect(cronPartial.skippedTickers).toBe(2);
    expect(cronPartial.skippedTickerList).toEqual(["XLF", "GLD"]);

    const page = buildHealthReport({
      health: {
        ...emptyScanHealth(),
        lastRunAt: Date.parse("2026-10-06T17:00:00Z"),
        lastOutcome: "partial",
        lastSkippedTickers: ["XLF"],
        lastBrowserScanAt: Date.parse("2026-10-06T18:05:00Z"),
        lastBrowserOutcome: "partial",
        lastBrowserSkippedTickers: ["TLT"],
      },
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [],
      openShadows: 0,
      resolvedShadows: 0,
      now: NOW,
    });
    expect(page.lastScanOutcome).toBe("partial");
    expect(page.lastCronOutcome).toBe("partial");
    expect(page.skippedTickers).toBe(1);
    expect(page.skippedTickerList).toEqual(["TLT"]);
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
    const tracked = { ...open, quoteTrack: true as const };
    const research = {
      id: "1727790000000-IWM|2026-12-18|240|put",
      contractKey: "IWM|2026-12-18|240|put",
      alertId: null,
      openedAt: Date.parse("2026-10-01T15:00:00Z"),
      ticker: "IWM",
      putCall: "put" as const,
      strike: 240,
      expiration: "2026-12-18",
      grade: "C" as const,
      entryPrice: 1.2,
      entryUnderlying: 240,
      spyTrend: "up" as const,
      marks: [],
    };
    const during = trackedAlertCounts([tracked, resolved, test], [research], new Date("2026-10-06T15:00:00Z"));
    expect(during).toEqual({ trackedAlertsTotal: 2, trackedAlertsActive: 2, trackedAlertsComplete: 0 });
    const finished = trackedAlertCounts([tracked], [research], new Date("2026-10-12T15:00:00Z"));
    expect(finished.trackedAlertsComplete).toBe(2);
    expect(finished.trackedAlertsActive).toBe(0);
    const expiredEarly = trackedAlertCounts(
      [],
      [{ ...research, expiration: "2026-10-02" }],
      new Date("2026-10-06T15:00:00Z"),
    );
    expect(expiredEarly).toEqual({ trackedAlertsTotal: 1, trackedAlertsActive: 0, trackedAlertsComplete: 0 });
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
