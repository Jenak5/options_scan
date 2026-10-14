import { describe, expect, it } from "vitest";
import { TRADE_RULES } from "@/app/lib/alertConfig";
import { emptyFeatures } from "@/app/lib/alertFeatures";
import type { StoredAlert } from "@/app/lib/alertBook";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  analyzeShadowRule,
  BREAKEVEN_RULE,
  CANDIDATE_RULE,
  CUT60_RULE,
  firstAlertIds,
  LIVE_RULE,
  replayRule,
  SHADOW_RULE_NOTE,
  stockAgainstFraction,
} from "@/app/lib/candidateRule";
import { contractKey, type ShadowTrade } from "@/app/lib/shadow";

const OPEN = Date.parse("2026-10-01T15:00:00Z");
const MIN = 60_000;
const EXP = "2026-12-18";

function bars(path: Array<[number, number, number, number?]>): CandleBar[] {
  // [minute, low, high, close?]
  return path.map(([m, l, h, c]) => ({ t: OPEN + m * MIN, o: (l + h) / 2, h, l, c: c ?? (l + h) / 2 }));
}

function input(candles: CandleBar[], over: { delta?: number | null; underlying?: number | null } = {}) {
  return { entryPrice: 2, openedAt: OPEN, expiration: EXP, candles, delta: over.delta ?? 0.5, underlying: over.underlying ?? 100 };
}

function shadow(id: string, over: Partial<ShadowTrade> = {}, premium = 2_000_000): ShadowTrade {
  return {
    id, alertId: id, openedAt: OPEN, ticker: "SPY", putCall: "call", strike: 670, expiration: EXP,
    grade: "A", cohort: "ab", experimentLabel: null, probeGrade: null,
    features: { ...emptyFeatures(), flowPremium: premium, delta: 0.5, marketAlignment: "against" },
    rulesVersion: 2, marks: [], maxFavorablePrice: null, maxAdversePrice: null, marksSeen: 0,
    contracts: 1, entryPrice: 2, entryPriceSource: "ask", status: "closed", closedAt: OPEN + 3 * 60 * MIN,
    exitPrice: 2.8, exitReason: "profit", exitQuote: "mid", exitStale: false, pnlDollars: 80, pnlFraction: 0.4,
    tradingDaysHeld: 0, lastMark: null, lastMarkSource: null, lastMarkedAt: null, entryUnderlying: 100,
    ...over,
  };
}

describe("candidate exit rule (shadow only)", () => {
  it("does not touch the live exit settings", () => {
    expect(TRADE_RULES.profitTargetFraction).toBe(0.40);
    expect(TRADE_RULES.stopLossFraction).toBe(0.25);
    expect(LIVE_RULE.targetFraction).toBe(0.40);
    expect(CANDIDATE_RULE.targetFraction).toBeNull();
    expect(CANDIDATE_RULE.stopFraction).toBe(-0.40);
    expect(SHADOW_RULE_NOTE).toMatch(/do not change live exits/);
  });

  it("stops at -40% with no fixed target", () => {
    const out = replayRule(input(bars([[1, 1.9, 2.2], [2, 1.1, 1.9]])), CANDIDATE_RULE);
    expect(out?.reason).toBe("stop");
    expect(out?.pnlDollars).toBeCloseTo(-80);
    // +60% does not exit the candidate (no target)
    const up = replayRule(input(bars([[1, 2.0, 3.2, 3.2], [2, 3.0, 3.2, 3.1]])), CANDIDATE_RULE);
    expect(up).toBeNull();
  });

  it("trails 15% below the peak once up 20%", () => {
    const out = replayRule(input(bars([[1, 2.0, 3.0], [2, 2.4, 2.9]])), CANDIDATE_RULE);
    expect(out?.reason).toBe("trail");
    expect(out?.pnlDollars).toBeCloseTo((3.0 * 0.85 - 2) * 100);
  });

  it("does not trail before the trade is up 20%", () => {
    expect(replayRule(input(bars([[1, 2.0, 2.3], [2, 1.95, 2.1]])), CANDIDATE_RULE)).toBeNull();
  });

  it("breakeven stop after +15% exits at entry", () => {
    const out = replayRule(input(bars([[1, 2.0, 2.35], [2, 1.9, 2.1]])), BREAKEVEN_RULE);
    expect(out?.reason).toBe("breakeven");
    expect(out?.pnlDollars).toBeCloseTo(0);
  });

  it("cuts at 60 minutes when the stock is 0.3% against", () => {
    // option -0.20 with delta 0.5 on a $100 stock is about 0.4% against
    const out = replayRule(input(bars([[1, 1.9, 2.0, 1.95], [59, 1.78, 1.82, 1.8], [61, 1.79, 1.81, 1.8]])), CUT60_RULE);
    expect(out?.reason).toBe("cut60");
    // only 0.1% against: no cut
    expect(replayRule(input(bars([[59, 1.94, 1.96, 1.95], [61, 1.94, 1.96, 1.95]])), CUT60_RULE)).toBeNull();
    // unknown delta: no cut
    expect(stockAgainstFraction(1.8, 2, null, 100)).toBeNull();
  });
});

describe("shadow rule report", () => {
  const alerts = [
    { id: "a1", ticker: "SPY", tradingDay: "2026-10-01", sentAt: OPEN },
    { id: "a2", ticker: "SPY", tradingDay: "2026-10-01", sentAt: OPEN + MIN },
    { id: "a3", ticker: "QQQ", tradingDay: "2026-10-01", sentAt: OPEN },
  ] as unknown as StoredAlert[];

  it("marks the first alert per ticker per day", () => {
    expect([...firstAlertIds(alerts)].sort()).toEqual(["a1", "a3"]);
  });

  it("compares live and shadow side by side with flags and the small-sample caveat", () => {
    const s1 = shadow("a1");
    const s2 = shadow("a2", { strike: 671, pnlDollars: -50 }, 400_000);
    s2.features = { ...s2.features!, marketAlignment: "with" };
    const s3 = shadow("a3", { ticker: "QQQ", strike: 600, status: "open", pnlDollars: null });
    const candles = new Map<string, CandleBar[]>([
      [contractKey(s1), bars([[1, 2.0, 3.0], [2, 2.4, 2.9]])],
      [contractKey(s2), bars([[1, 1.9, 2.0], [2, 1.0, 1.9]])],
    ]);
    const report = analyzeShadowRule({ shadows: [s1, s2, s3], alerts, candles });
    expect(report.included).toBe(2);
    expect(report.skippedOpen).toBe(1);
    const t1 = report.trades.find((t) => t.id === "a1")!;
    const t2 = report.trades.find((t) => t.id === "a2")!;
    expect(t1.flags).toMatchObject({ bigFlow: true, smallWithMarket: false, firstOfDay: true, breakevenArmed: true });
    expect(t2.flags).toMatchObject({ bigFlow: false, smallWithMarket: true, firstOfDay: false });
    const big = report.comparisons.find((c) => c.id === "candidate1m")!;
    expect(big.live).toMatchObject({ trades: 1, wins: 1, avgPnl: 80 });
    expect(big.shadow.trades).toBe(1);
    expect(big.shadow.avgPnl).toBeCloseTo(55);
    expect(big.tooFew).toBe(true);
    const skip = report.comparisons.find((c) => c.id === "filterSmallWithMarket")!;
    expect(skip.live.trades).toBe(2);
    expect(skip.shadow.trades).toBe(1);
    expect(report.sampleNote).toMatch(/Under 30 trades/);
  });

  it("leaves out alerts with no stored candles and experiment rows", () => {
    const report = analyzeShadowRule({
      shadows: [shadow("a1"), shadow("x", { cohort: "experiment", grade: "test" })],
      alerts,
      candles: new Map(),
    });
    expect(report.included).toBe(0);
    expect(report.skippedNoCandles).toBe(1);
  });
});
