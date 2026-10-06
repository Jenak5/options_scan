import { describe, expect, it } from "vitest";
import type { StoredAlert } from "@/app/lib/alertBook";
import { emptyCheckpoint } from "@/app/lib/alertBook";
import { filterFlowRows, type FlowRow } from "@/app/lib/flow";
import { pinTodayAlerts, type ScoredFlowRow } from "@/app/lib/flowAlerts";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import type { AlertVerdict } from "@/app/lib/verdict";

const NOW = new Date("2026-10-02T17:45:00Z");
const TODAY = "2026-10-02";
const ALERT_ID = "1727887500000-QQQ|2026-10-16|500|put";
const CONTRACT = "QQQ|2026-10-16|500|put";

function live(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "SPY|2026-10-16|500|call",
    ticker: "SPY",
    putCall: "call",
    strike: 500,
    expiration: "2026-10-16",
    bid: 2,
    ask: 2.5,
    last: 2.4,
    volume: 900,
    openInterest: 400,
    iv: 0.2,
    delta: 0.4,
    mid: 2.25,
    notionalPremium: 202_500,
    volOiRatio: 2,
    volumeOiJump: 500,
    volumeExceedsOi: true,
    previousVolume: 100,
    volumeJump: 800,
    otmPoints: 4,
    otmFraction: 0.04,
    otm: true,
    dte: 14,
    spreadFraction: 0.02,
    spreadQuality: "tight",
    side: "estimated at ask",
    sideNote: "Estimated from the last price versus the bid and ask. Not a sweep print.",
    askFraction: 0.8,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 490,
    levels: null,
    prints: EMPTY_PRINTS,
    score: 80,
    ...over,
  };
}

function scored(over: Partial<FlowRow> = {}, verdict: AlertVerdict = fresh("C", "WATCH")): ScoredFlowRow {
  return { ...live(over), verdict, alertId: null };
}

function fresh(grade: "A" | "B" | "C" | "D", name: AlertVerdict["verdict"]): AlertVerdict {
  return {
    verdict: name,
    verdictLabel: name,
    grade,
    uncappedGrade: grade,
    reasons: ["Fresh scan."],
    note: "Fresh scan.",
    levels: null,
    levelsNote: null,
    eventLine: "",
    maxContracts: 1,
    singleContractExceedsCap: false,
    suggestion: null,
    liquidityPasses: true,
    dailyStop: false,
  };
}

function saved(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: ALERT_ID,
    contractKey: CONTRACT,
    sentAt: NOW.getTime(),
    tradingDay: TODAY,
    ticker: "QQQ",
    putCall: "put",
    strike: 500,
    expiration: "2026-10-16",
    bid: 1.9,
    ask: 2.05,
    mid: 1.975,
    underlyingPrice: 510,
    volume: 1200,
    openInterest: 400,
    flowScore: 70,
    liquidityPasses: true,
    side: "estimated at ask",
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "B",
    reasons: ["Liquidity passes."],
    note: "Rules checklist only.",
    levels: null,
    levelsNote: null,
    eventLine: "Next earnings 2026-11-15 after the close.",
    maxContracts: 2,
    checkpoints: { m15: emptyCheckpoint(), h1: emptyCheckpoint(), close: emptyCheckpoint() },
    outcome: "pending",
    ...over,
  };
}

describe("today's alerts on Flow", () => {
  it("puts back a contract the score cap removed from the live scan", () => {
    const filler = Array.from({ length: 80 }, (_, i) => live({
      id: `SPY|2026-10-16|${400 + i}|call`,
      strike: 400 + i,
      score: 100 - i,
      notionalPremium: 200_000,
    }));
    const alerted = live({
      id: CONTRACT,
      ticker: "QQQ",
      putCall: "put",
      strike: 500,
      score: 1,
      notionalPremium: 40_000,
      liquidityPasses: true,
    });
    const filtered = filterFlowRows(filler.concat(alerted), {
      minPremium: 50_000,
      otmOnly: false,
      liquidOnly: true,
      limit: 80,
    });
    expect(filtered.some((row) => row.id === CONTRACT)).toBe(false);

    const pinned = pinTodayAlerts(
      filtered.map((row) => ({ ...row, verdict: fresh("C", "WATCH"), alertId: null })),
      [saved()],
      TODAY,
      NOW,
      "",
    );
    const card = pinned.find((row) => row.id === CONTRACT);
    expect(card?.alertId).toBe(ALERT_ID);
    expect(card?.verdict.grade).toBe("B");
    expect(card?.verdict.verdict).toBe("TAKE");
    expect(card?.ask).toBe(2.05);
    expect(card?.verdict.reasons[0]).toBe("Liquidity passes.");
  });

  it("keeps the live quote but shows the saved grade when the contract is still in the scan", () => {
    const row = scored({
      id: CONTRACT,
      ticker: "QQQ",
      putCall: "put",
      ask: 3.1,
      score: 90,
    }, fresh("C", "WATCH"));
    const pinned = pinTodayAlerts([row], [saved({ grade: "A", verdict: "TAKE", verdictLabel: "TAKE" })], TODAY, NOW, "");
    expect(pinned).toHaveLength(1);
    expect(pinned[0].ask).toBe(3.1);
    expect(pinned[0].verdict.grade).toBe("A");
    expect(pinned[0].alertId).toBe(ALERT_ID);
    expect(pinned[0].verdict.reasons).toEqual(["Liquidity passes."]);
  });

  it("builds a card from the alert book when the chain no longer returns the contract", () => {
    const pinned = pinTodayAlerts([], [saved()], TODAY, NOW, "");
    expect(pinned).toHaveLength(1);
    expect(pinned[0].id).toBe(CONTRACT);
    expect(pinned[0].ticker).toBe("QQQ");
    expect(pinned[0].putCall).toBe("put");
    expect(pinned[0].expiration).toBe("2026-10-16");
    expect(pinned[0].alertId).toBe(ALERT_ID);
    expect(pinned[0].verdict.grade).toBe("B");
    expect(pinned[0].notionalPremium).toBeCloseTo(1.975 * 1200 * 100);
    expect(pinned[0].verdict.eventLine).toContain("2026-11-15");
    expect(Number.isFinite(pinned[0].last)).toBe(false);
    expect(pinned[0].openingLabel).toBeNull();
  });

  it("shows the saved last price and the opening label, and does not copy the ask into last", () => {
    const pinned = pinTodayAlerts([], [saved({
      last: 1.9,
      openingCheck: {
        status: "pending",
        priorOpenInterest: 400,
        volume: 1200,
        nextOpenInterest: null,
        checkedOn: null,
      },
    })], TODAY, NOW, "");
    expect(pinned[0].last).toBe(1.9);
    expect(pinned[0].last).not.toBe(pinned[0].ask);
    expect(pinned[0].openingLabel).toBe("Pending (checks tomorrow)");
  });

  it("ignores yesterday, a C, and a different ticker when one is typed", () => {
    const alerts = [
      saved({ id: "yesterday", tradingDay: "2026-10-01", contractKey: "IWM|2026-10-16|200|call", ticker: "IWM" }),
      saved({ id: "grade-c", grade: "C", contractKey: "SPY|2026-10-16|500|call", ticker: "SPY", putCall: "call" }),
      saved(),
    ];
    expect(pinTodayAlerts([], alerts, TODAY, NOW, "SPY")).toEqual([]);
    const all = pinTodayAlerts([], alerts, TODAY, NOW, "");
    expect(all.map((row) => row.alertId)).toEqual([ALERT_ID]);
  });

  it("keeps the later alert when the same contract was saved twice", () => {
    const first = saved({ id: "early", sentAt: NOW.getTime() - 60_000, grade: "B" });
    const later = saved({ id: "later", sentAt: NOW.getTime(), grade: "A" });
    const pinned = pinTodayAlerts([], [first, later], TODAY, NOW, "");
    expect(pinned).toHaveLength(1);
    expect(pinned[0].alertId).toBe("later");
    expect(pinned[0].verdict.grade).toBe("A");
  });
});
