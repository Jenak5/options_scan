import { describe, expect, it } from "vitest";
import type { StoredAlert } from "@/app/lib/alertBook";
import {
  backfillCandleTargets,
  candleCronDecision,
  dailyCandleTargets,
  isAfterCloseCandleSlot,
} from "@/app/lib/candleTargets";
import { chicagoWallTimeMs } from "@/app/lib/marketHours";
import type { ResearchTrack } from "@/app/lib/researchTrack";
import type { ShadowTrade } from "@/app/lib/shadow";

const NOW = new Date("2026-10-13T18:00:00Z");

describe("candle schedule and targets", () => {
  it("keeps 3:30pm Chicago in both daylight and standard time", () => {
    expect(isAfterCloseCandleSlot(new Date("2026-10-13T20:30:00Z"))).toBe(true);
    expect(isAfterCloseCandleSlot(new Date("2026-10-13T21:30:00Z"))).toBe(false);
    expect(isAfterCloseCandleSlot(new Date("2026-12-14T21:30:00Z"))).toBe(true);
    expect(isAfterCloseCandleSlot(new Date("2026-12-14T20:30:00Z"))).toBe(false);
    expect(chicagoWallTimeMs("2026-09-01", 0, 0)).toBe(Date.parse("2026-09-01T05:00:00Z"));
    expect(candleCronDecision(new Date("2026-11-26T21:30:00Z"), false).reason).toBe("market holiday");
    expect(candleCronDecision(new Date("2026-10-13T18:00:00Z"), true).run).toBe(true);
  });

  it("fetches open scorecard shadows and A/B alerts, and leaves C/D off the 3:30 cron", () => {
    const shadows = [
      shadow({ id: "open-spy", status: "open", openedAt: Date.parse("2026-08-03T15:00:00Z") }),
      shadow({
        id: "old-closed",
        status: "closed",
        ticker: "IWM",
        strike: 240,
        putCall: "put",
        openedAt: Date.parse("2026-08-03T15:00:00Z"),
      }),
    ];
    const research = [track({ id: "research-c", grade: "C", ticker: "QQQ", strike: 500 })];
    const alerts = [
      alert({ id: "alert-d", grade: "D", ticker: "DIA", strike: 480, putCall: "put" }),
      alert({ id: "alert-a", grade: "A", ticker: "AAPL", strike: 200, putCall: "call" }),
    ];
    const daily = dailyCandleTargets({ alerts, shadows, research, now: NOW });
    const keys = daily.map((row) => row.contractKey).sort();
    expect(keys).toContain("SPY|2026-12-18|670|call");
    expect(keys).toContain("AAPL|2026-12-18|200|call");
    expect(keys).not.toContain("QQQ|2026-12-18|500|call");
    expect(keys).not.toContain("DIA|2026-12-18|480|put");
    expect(keys).not.toContain("IWM|2026-12-18|240|put");

    const backfill = backfillCandleTargets({ alerts, shadows, research });
    const filled = backfill.map((row) => row.contractKey);
    expect(filled).toContain("IWM|2026-12-18|240|put");
    expect(filled).toContain("QQQ|2026-12-18|500|call");
    expect(filled).toContain("DIA|2026-12-18|480|put");
    expect(backfill.find((row) => row.contractKey === "SPY|2026-12-18|670|call")?.streamer).toBe(".SPY261218C670");
  });
});

function shadow(over: Partial<ShadowTrade>): ShadowTrade {
  return {
    id: "shadow-id-0001",
    status: "closed",
    openedAt: Date.parse("2026-10-12T15:00:00Z"),
    expiration: "2026-12-18",
    ticker: "SPY",
    strike: 670,
    putCall: "call",
    ...over,
  } as ShadowTrade;
}

function track(over: Partial<ResearchTrack>): ResearchTrack {
  return {
    id: "research-id-0001",
    contractKey: "QQQ|2026-12-18|500|call",
    alertId: null,
    openedAt: Date.parse("2026-10-12T15:00:00Z"),
    ticker: "QQQ",
    putCall: "call",
    strike: 500,
    expiration: "2026-12-18",
    grade: "C",
    entryPrice: 1.2,
    entryUnderlying: null,
    spyTrend: "up",
    marks: [],
    ...over,
  };
}

function alert(over: Partial<StoredAlert>): StoredAlert {
  return {
    id: "alert-id-0000001",
    sentAt: Date.parse("2026-10-12T15:00:00Z"),
    expiration: "2026-12-18",
    ticker: "DIA",
    strike: 480,
    putCall: "put",
    grade: "D",
    ...over,
  } as StoredAlert;
}
