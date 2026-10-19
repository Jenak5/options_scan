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

function shadow(id: string, over: Partial<ShadowTrade> = {}, premium = 4_000_000): ShadowTrade {
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
    expect(CANDIDATE_RULE.stopFraction).toBe(-0.30);
    expect(SHADOW_RULE_NOTE).toMatch(/do not change live exits/);
  });

  it("stops at -30% with no fixed target", () => {
    const out = replayRule(input(bars([[1, 1.9, 2.2], [2, 1.1, 1.9]])), CANDIDATE_RULE);
    expect(out?.reason).toBe("stop");
    expect(out?.pnlDollars).toBeCloseTo(-60);
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
    expect(Array.from(firstAlertIds(alerts)).sort()).toEqual(["a1", "a3"]);
  });

  it("builds the shadow set: $3M+, first per ticker, not 11:00-11:59 CT, daily stop on", () => {
    const day = (h: number, m: number) => Date.parse(`2026-10-01T${String(h + 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
    const loser = (id: string, ticker: string, at: number) => shadow(id, { ticker, openedAt: at, strike: 600 + id.length + ticker.charCodeAt(0) });
    const rows = [
      loser("l1", "AAA", day(9, 0)),
      loser("l2", "BBB", day(9, 5)),
      loser("l3", "CCC", day(10, 30)), // after two losses closed: daily stop
      loser("w1", "DDD", day(11, 15)), // weak window
      shadow("s1", { ticker: "EEE", openedAt: day(9, 10), strike: 1 }, 2_000_000), // under $3M
      shadow("r2", { ticker: "AAA", openedAt: day(9, 30), strike: 2 }), // repeat ticker
    ];
    const al = rows.map((r) => ({ id: r.alertId, ticker: r.ticker, tradingDay: "2026-10-01", sentAt: r.openedAt })) as unknown as StoredAlert[];
    const candles = new Map<string, CandleBar[]>();
    for (const r of rows) {
      const m0 = (r.openedAt - OPEN) / MIN;
      candles.set(contractKey(r), [
        { t: r.openedAt + MIN, o: 2, h: 2.05, l: 1.95, c: 2 },
        { t: r.openedAt + 2 * MIN, o: 1.5, h: 1.5, l: 1.2, c: 1.3 },
      ]);
      void m0;
    }
    const report = analyzeShadowRule({ shadows: rows, alerts: al, candles });
    const flag = (id: string) => report.trades.find((t) => t.id === id)!.flags;
    expect(flag("l1").inShadowSet).toBe(true);
    expect(flag("l2").inShadowSet).toBe(true);
    expect(flag("l3")).toMatchObject({ inFilter: true, dailyStopped: true, inShadowSet: false });
    expect(flag("w1")).toMatchObject({ weakWindow: true, inShadowSet: false });
    expect(flag("s1")).toMatchObject({ big3m: false, inShadowSet: false });
    expect(flag("r2")).toMatchObject({ firstOfDay: false, inShadowSet: false });
    const main = report.comparisons.find((c) => c.id === "shadowVsLive")!;
    expect(main.live.trades).toBe(6);
    expect(main.shadow.trades).toBe(2);
    expect(main.shadow.avgPnl).toBeCloseTo(-60);
    expect(main.tooFew).toBe(true);
    expect(report.sampleNote).toMatch(/Under 30 trades/);
    const same = report.comparisons.find((c) => c.id === "shadowSetExits")!;
    expect(same.live.trades).toBe(2);
    expect(same.live.avgPnl).toBeCloseTo(-50);
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

  it("compares both columns on the same candles, with tracked as reference", () => {
    const s1 = shadow("a1", { pnlDollars: -60 });
    const candles = new Map<string, CandleBar[]>([[contractKey(s1), bars([[1, 2.0, 2.9], [2, 2.3, 2.5]])]]);
    const report = analyzeShadowRule({ shadows: [s1], alerts, candles });
    const same = report.comparisons.find((c) => c.id === "shadowSetExits")!;
    expect(same.live.avgPnl).toBeCloseTo(80);
    expect(same.shadow.avgPnl).toBeCloseTo(40);
    expect(same.tracked.avgPnl).toBe(-60);
  });
});
