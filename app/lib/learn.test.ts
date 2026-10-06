import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { ALERT_RULES, EXPERIMENT_DTE } from "@/app/lib/alertConfig";
import { backfillFeatures, emptyFeatures, snapshotFromFlow, type AlertFeatureSnapshot } from "@/app/lib/alertFeatures";
import { analyzeLearning, learningCsv, readGradeChecks, LEARN_MIN_TRUST } from "@/app/lib/learn";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { SHADOW_MIN_TRUST, type ShadowTrade } from "@/app/lib/shadow";
import { buildTrade, tradeMetrics, type StoredTrade } from "@/app/lib/trades";
import type { FlowRow } from "@/app/lib/flow";

const OPEN = new Date("2026-10-01T15:00:00Z");

describe("learning mode", () => {
  it("buckets outcomes, ranks the widest gap, and labels a small sample", () => {
    const shadows: ShadowTrade[] = [];
    for (let i = 0; i < 7; i++) shadows.push(closedCall(i, true));
    for (let i = 0; i < 4; i++) shadows.push(closedCall(100 + i, false));
    for (let i = 0; i < 2; i++) shadows.push(closedPut(i, true));
    for (let i = 0; i < 7; i++) shadows.push(closedPut(100 + i, false));
    shadows.push(testShadow(true));
    shadows.push(testShadow(false));

    const report = analyzeLearning({
      shadows,
      alerts: [],
      trades: [],
      checksByTradeId: new Map(),
      now: OPEN,
    });

    expect(LEARN_MIN_TRUST).toBe(SHADOW_MIN_TRUST);
    expect(LEARN_MIN_TRUST).toBe(30);
    expect(report.resolved).toBe(20);
    expect(report.testResolved).toBe(2);
    expect(report.wins).toBe(9);
    expect(report.losses).toBe(11);
    expect(report.tooFew).toBe(true);
    expect(report.summary.join(" ")).toContain("Puts are 2 for 9; calls are 7 for 11.");
    expect(report.summary.join(" ")).toMatch(/too few to trust/i);
    expect(report.summary.join(" ")).toContain("This is not a proven pattern.");
    expect(report.summary.join(" ")).toMatch(/Fewer than 30 test results is too few to consider widening/);
    expect(report.summary.join(" ")).toContain("The 14–42 day rule is unchanged.");
    expect(report.estimateNote).toMatch(/not fills/);
    expect(report.estimateNote).toMatch(/does not change/);

    const spread = report.factors.find((factor) => factor.id === "spread");
    const right = report.factors.find((factor) => factor.id === "right");
    const dte = report.factors.find((factor) => factor.id === "dte");
    const grade = report.factors.find((factor) => factor.id === "grade");
    if (!spread || !right || !dte || !grade) throw new Error("expected factors");

    expect(report.factors[0].id).toBe("spread");
    expect(spread.rank).toBe(1);
    expect(spread.winRateGap).toBe(1);
    expect(spread.tooFew).toBe(true);
    expect(spread.buckets.find((bucket) => bucket.key === "Over 5%")?.tooFew).toBe(true);
    expect(spread.buckets.find((bucket) => bucket.key === "Over 5%")).toMatchObject({ wins: 0, losses: 11, count: 11 });
    expect(spread.buckets.find((bucket) => bucket.key === "2% or tighter")).toMatchObject({ wins: 9, losses: 0, count: 9 });
    expect(right.buckets.find((bucket) => bucket.key === "Put")).toMatchObject({ wins: 2, losses: 7 });
    expect(right.buckets.find((bucket) => bucket.key === "Call")).toMatchObject({ wins: 7, losses: 4 });

    expect(grade.included).toBe(20);
    expect(grade.buckets.map((bucket) => bucket.key)).toEqual(["A"]);
    expect(dte.included).toBe(22);
    expect(dte.buckets.find((bucket) => bucket.key === "43–60 days (test)")).toMatchObject({ count: 2, wins: 1, losses: 1, tooFew: true });
    expect(dte.buckets.find((bucket) => bucket.key === "14–27 days")?.count).toBe(20);

    expect(report.suggestions[0]).toMatch(/Over 5% lost 11 of 11/);
    expect(report.suggestions[0]).toMatch(/Consider tightening/);
    expect(report.suggestions.join(" ")).toMatch(/Suggestion only/);
    expect(report.suggestions.join(" ")).toContain(`$${MAX_LOSS_DOLLARS}`);
    expect(ALERT_RULES.alertDteMax).toBe(42);
    expect(ALERT_RULES.alertDteMin).toBe(14);
    expect(MAX_LOSS_DOLLARS).toBe(875);
    expect(EXPERIMENT_DTE.minTrust).toBe(30);
  });

  it("says there is nothing to trust yet when no trade has closed", () => {
    const report = analyzeLearning({
      shadows: [],
      alerts: [],
      trades: [],
      checksByTradeId: new Map(),
      now: OPEN,
    });
    expect(report.resolved).toBe(0);
    expect(report.factors).toEqual([]);
    expect(report.summary.join(" ")).toMatch(/No resolved shadows or closed paper trades yet/);
    expect(report.summary.join(" ")).toMatch(/does not invent results/);
    expect(report.suggestions[0]).toMatch(/No suggestion yet/);
    expect(report.checksNote).toMatch(/Grade my trade/);
  });

  it("counts a closed paper trade once and leaves the matching shadow out", () => {
    const shadow = closedCall(1, true);
    const built = buildTrade({
      ticker: "SPY",
      putCall: "call",
      strike: 100,
      expiration: "2026-10-22",
      contracts: 1,
      entryPrice: 2,
      alertId: shadow.alertId,
      alertGrade: "A",
      alertVerdict: "TAKE",
    }, "t_learn_paper_once", OPEN);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const paper: StoredTrade = {
      ...built.trade,
      closedAt: OPEN.getTime() + 60_000,
      exitPrice: 3,
      exitNote: "Took the target.",
    };
    expect(tradeMetrics(paper).pnlDollars).toBeGreaterThan(0);
    const report = analyzeLearning({
      shadows: [shadow],
      alerts: [],
      trades: [paper],
      checksByTradeId: new Map(),
      now: OPEN,
    });
    expect(report.omittedShadows).toBe(1);
    expect(report.resolved).toBe(1);
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0].source).toBe("paper");
    expect(report.trades[0].exitDetail).toContain("Took the target.");
    expect(report.summary.join(" ")).toMatch(/paper trade is the one counted/);
  });

  it("reads grade checks without guessing an unknown one", () => {
    const built = buildTrade({
      ticker: "QQQ",
      putCall: "put",
      strike: 500,
      expiration: "2026-10-22",
      contracts: 1,
      entryPrice: 2,
      alertId: null,
      alertGrade: "B",
      alertVerdict: "TAKE",
    }, "t_learn_checks_1", OPEN);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const paper: StoredTrade = { ...built.trade, closedAt: OPEN.getTime() + 60_000, exitPrice: 1, exitNote: null };
    const text = JSON.stringify({
      version: 1,
      trades: [{
        ...paper,
        gradeChecks: [
          { id: "spread", label: "Spread", status: "fail" },
          { id: "openInterest", label: "Open interest", status: "pass" },
          { id: "earnings", label: "Earnings", status: "unknown" },
          { id: "bad id", label: "Nope", status: "fail" },
        ],
      }],
    });
    const checks = readGradeChecks(text);
    expect(checks.get(paper.id)?.map((check) => check.status)).toEqual(["fail", "pass", "unknown"]);
    const report = analyzeLearning({
      shadows: [],
      alerts: [],
      trades: [paper],
      checksByTradeId: checks,
      now: OPEN,
    });
    const spread = report.factors.find((factor) => factor.id === "check:spread");
    const interest = report.factors.find((factor) => factor.id === "check:openInterest");
    const earnings = report.unavailable.find((factor) => factor.id === "check:earnings");
    expect(spread?.buckets.map((bucket) => bucket.key)).toEqual(["Fail"]);
    expect(interest?.buckets.map((bucket) => bucket.key)).toEqual(["Pass"]);
    expect(earnings?.excludedUnknown).toBe(1);
    expect(report.factors.some((factor) => factor.id === "check:bad id")).toBe(false);
    expect(report.trades[0].exitDetail).toMatch(/No target, stop, time stop, or expiration reason was stored/);
  });

  it("backfills only stored fields and leaves blanks in the CSV", () => {
    const alert = storedAlert();
    const filled = backfillFeatures(alert);
    expect(filled.capturedAtAlert).toBe(false);
    expect(filled.iv).toBeNull();
    expect(filled.delta).toBeNull();
    expect(filled.volumeJump).toBeNull();
    expect(filled.flowSignalCount).toBeNull();
    expect(filled.flowPremium).toBe(800 * 1.95 * 100);
    expect(filled.earnings).toBe("unknown");

    const captured = snapshotFromFlow(flowRow(), OPEN);
    expect(captured.capturedAtAlert).toBe(true);
    expect(captured.flowSignalCount).toBe(4);
    expect(snapshotFromFlow(flowRow({ volumeJump: null, iv: 0 }), OPEN).flowSignalCount).toBeNull();
    expect(snapshotFromFlow(flowRow({ iv: 0 }), OPEN).iv).toBeNull();
    expect(snapshotFromFlow(flowRow({ iv: 9 }), OPEN).iv).toBeNull();

    const shadow = closedCall(1, true);
    shadow.features = { ...features({ spreadFraction: 0.01 }), iv: null, volumeJump: null, flowSignalCount: null };
    const report = analyzeLearning({
      shadows: [shadow],
      alerts: [],
      trades: [],
      checksByTradeId: new Map(),
      now: OPEN,
    });
    const line = learningCsv(report).trim().split("\n")[1].split(",");
    const header = learningCsv(report).trim().split("\n")[0].split(",");
    expect(line[header.indexOf("iv")]).toBe("");
    expect(line[header.indexOf("volumeJump")]).toBe("");
    expect(line[header.indexOf("flowSignalCount")]).toBe("");
    expect(report.factors.some((factor) => factor.id === "iv")).toBe(false);
    expect(report.unavailable.some((factor) => factor.id === "iv")).toBe(true);
  });

  it("stops calling a bucket too small once 30 results are in it", () => {
    const shadows = Array.from({ length: 30 }, (_, index) => closedCall(index, true));
    const report = analyzeLearning({
      shadows,
      alerts: [],
      trades: [],
      checksByTradeId: new Map(),
      now: OPEN,
    });
    expect(report.tooFew).toBe(false);
    const grade = report.factors.find((factor) => factor.id === "grade");
    expect(grade?.tooFew).toBe(false);
    expect(grade?.buckets[0].tooFew).toBe(false);
    expect(grade?.buckets[0].count).toBe(30);
  });

  it("uses stored marks for the best and worst move and says when they were recovered", () => {
    const marked = closedCall(1, false);
    marked.marksSeen = 2;
    marked.maxFavorablePrice = 2.4;
    marked.maxAdversePrice = 1.2;
    marked.entryPrice = 2;
    const recovered = closedCall(2, true);
    recovered.marksSeen = 0;
    recovered.maxFavorablePrice = null;
    recovered.maxAdversePrice = null;
    recovered.lastMark = 2.2;
    recovered.exitPrice = 2.8;
    const report = analyzeLearning({
      shadows: [marked, recovered],
      alerts: [],
      trades: [],
      checksByTradeId: new Map(),
      now: OPEN,
    });
    const loss = report.trades.find((row) => row.id === marked.id);
    const win = report.trades.find((row) => row.id === recovered.id);
    expect(loss?.maxFavorablePct).toBeCloseTo(0.2, 6);
    expect(loss?.maxAdversePct).toBeCloseTo(-0.4, 6);
    expect(loss?.markNote).toMatch(/2 stored marks/);
    expect(win?.markNote).toMatch(/Recovered from/);
    expect(win?.exitReason).toBe("profit");
  });
});

function features(over: Partial<AlertFeatureSnapshot> = {}): AlertFeatureSnapshot {
  return {
    ...emptyFeatures(),
    capturedAtAlert: true,
    flowPremium: 150_000,
    volOiRatio: 2.5,
    volumeJump: 120,
    flowSignalCount: 4,
    spreadFraction: 0.01,
    iv: 0.4,
    delta: 0.4,
    otmFraction: 0.04,
    itmFraction: 0,
    otm: true,
    dte: 21,
    rewardDistance: 0.02,
    riskDistance: 0.01,
    earnings: "after",
    side: "estimated at ask",
    ...over,
  };
}

function closedCall(index: number, win: boolean): ShadowTrade {
  return closed({
    id: `learncall${index}win${win ? "y" : "n"}abcd`,
    putCall: "call",
    win,
    spread: win ? 0.01 : 0.06,
  });
}

function closedPut(index: number, win: boolean): ShadowTrade {
  return closed({
    id: `learnput${index}win${win ? "y" : "n"}abcde`,
    putCall: "put",
    win,
    spread: win ? 0.01 : 0.06,
  });
}

function testShadow(win: boolean): ShadowTrade {
  return closed({
    id: `learntest${win ? "win" : "loss"}abcd`,
    putCall: "call",
    win,
    spread: 0.01,
    cohort: "experiment",
    grade: "test",
    experimentLabel: EXPERIMENT_DTE.label,
    probeGrade: "A",
    dte: 50,
  });
}

function closed(input: {
  id: string;
  putCall: "call" | "put";
  win: boolean;
  spread: number;
  cohort?: "ab" | "experiment";
  grade?: "A" | "B" | "test";
  experimentLabel?: string | null;
  probeGrade?: "A" | "B" | null;
  dte?: number;
}): ShadowTrade {
  const win = input.win;
  return {
    id: input.id,
    alertId: input.id,
    openedAt: OPEN.getTime(),
    ticker: "SPY",
    putCall: input.putCall,
    strike: 100,
    expiration: input.cohort === "experiment" ? "2026-11-20" : "2026-10-22",
    grade: input.grade ?? "A",
    cohort: input.cohort ?? "ab",
    experimentLabel: input.experimentLabel ?? null,
    probeGrade: input.probeGrade ?? null,
    features: features({ spreadFraction: input.spread, dte: input.dte ?? 21 }),
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
    contracts: 1,
    entryPrice: 2,
    entryPriceSource: "ask",
    status: "closed",
    closedAt: OPEN.getTime() + 60_000,
    exitPrice: win ? 2.8 : 1.5,
    exitReason: win ? "profit" : "stop",
    exitQuote: "mid",
    exitStale: false,
    pnlDollars: win ? 80 : -50,
    pnlFraction: win ? 0.4 : -0.25,
    tradingDaysHeld: 1,
    lastMark: win ? 2.8 : 1.5,
    lastMarkSource: "mid",
    lastMarkedAt: OPEN.getTime(),
  };
}

function storedAlert(): StoredAlert {
  return {
    id: "1727790000000-SPY|2026-10-16|670|call",
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: OPEN.getTime(),
    tradingDay: "2026-10-01",
    ticker: "SPY",
    putCall: "call",
    strike: 670,
    expiration: "2026-10-16",
    bid: 1.9,
    ask: 2,
    mid: 1.95,
    underlyingPrice: 665,
    volume: 800,
    openInterest: 500,
    flowScore: 10,
    liquidityPasses: true,
    side: "estimated at ask",
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "A",
    reasons: ["Flow"],
    note: "",
    levels: null,
    levelsNote: null,
    eventLine: "earnings date unknown. The grade stops at B.",
    maxContracts: 4,
    checkpoints: {
      m15: emptyCheckpoint(),
      h1: emptyCheckpoint(),
      close: emptyCheckpoint(),
    },
    outcome: "pending",
  };
}

function flowRow(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "SPY|2026-10-22|670|call",
    ticker: "SPY",
    putCall: "call",
    strike: 670,
    expiration: "2026-10-22",
    bid: 2,
    ask: 2.1,
    last: 2.1,
    volume: 3000,
    openInterest: 1000,
    iv: 0.3,
    delta: 0.35,
    mid: 2.05,
    notionalPremium: 615_000,
    volOiRatio: 3,
    volumeOiJump: 2000,
    volumeExceedsOi: true,
    previousVolume: 2600,
    volumeJump: 400,
    otmPoints: 5,
    otmFraction: 0.04,
    otm: true,
    dte: 21,
    spreadFraction: 0.02,
    spreadQuality: "tight",
    side: "estimated at ask",
    sideNote: "Estimated.",
    askFraction: 1,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 665,
    levels: null,
    prints: EMPTY_PRINTS,
    score: 40,
    ...over,
  };
}
