import { describe, expect, it } from "vitest";
import { TRADE_RULES } from "@/app/lib/alertConfig";
import { replayExit, whatIfFromShadows, WHAT_IF_NOTE, WHAT_IF_SCENARIOS } from "@/app/lib/exitWhatIf";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import type { ShadowTrade } from "@/app/lib/shadow";

const OPEN = Date.parse("2026-10-01T15:00:00Z");
const EXPIRATION = "2026-12-18";

function shadow(over: Partial<ShadowTrade> = {}): ShadowTrade {
  return {
    id: "whatifshadow0001",
    alertId: "whatifshadow0001",
    openedAt: OPEN,
    ticker: "SPY",
    putCall: "call",
    strike: 670,
    expiration: EXPIRATION,
    grade: "A",
    cohort: "ab",
    experimentLabel: null,
    probeGrade: null,
    features: null,
    rulesVersion: 2,
    marks: [],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
    contracts: 1,
    entryPrice: 2,
    entryPriceSource: "ask",
    status: "open",
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    exitQuote: null,
    exitStale: false,
    pnlDollars: null,
    pnlFraction: null,
    tradingDaysHeld: null,
    lastMark: null,
    lastMarkSource: null,
    lastMarkedAt: null,
    ...over,
  };
}

function scenario(id: string) {
  const found = WHAT_IF_SCENARIOS.find((row) => row.id === id);
  if (!found) throw new Error(id);
  return found;
}

describe("exit what-ifs", () => {
  it("leaves the live exit rules alone", () => {
    expect(TRADE_RULES.profitTargetFraction).toBe(0.40);
    expect(TRADE_RULES.stopLossFraction).toBe(0.25);
    expect(TRADE_RULES.flatAfterTradingDays).toBe(3);
    expect(MAX_LOSS_DOLLARS).toBe(875);
    expect(WHAT_IF_NOTE).toMatch(/15-minute/);
    expect(WHAT_IF_NOTE).toMatch(/do not change the live exits/i);
  });

  it("takes +25% before +40% and leaves a path that never hits unresolved", () => {
    const marks = [
      { at: OPEN + 60 * 60_000, price: 2.5 },
      { at: OPEN + 2 * 60 * 60_000, price: 2.8 },
      { at: OPEN + 3 * 60 * 60_000, price: 3.2 },
    ];
    const input = { entryPrice: 2, openedAt: OPEN, expiration: EXPIRATION, marks };
    expect(replayExit(input, scenario("tp25"))?.pnlDollars).toBeCloseTo(50);
    expect(replayExit(input, scenario("tp40"))?.pnlDollars).toBeCloseTo(80);
    expect(replayExit(input, scenario("tp60"))?.pnlDollars).toBeCloseTo(120);
    expect(replayExit({ ...input, marks: [{ at: OPEN + 60_000, price: 2.1 }] }, scenario("tp40"))).toBeNull();
  });

  it("checks the stop before a profit target on the same snapshot", () => {
    const exit = replayExit({
      entryPrice: 2,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [{ at: OPEN + 60_000, price: 1.4 }],
    }, scenario("stop25"));
    expect(exit?.pnlDollars).toBeCloseTo(-60);
    const tighter = replayExit({
      entryPrice: 2,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [{ at: OPEN + 60_000, price: 1.6 }],
    }, scenario("stop20"));
    expect(tighter?.pnlDollars).toBeCloseTo(-40);
    expect(replayExit({
      entryPrice: 2,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [{ at: OPEN + 60_000, price: 1.6 }],
    }, scenario("stop25"))).toBeNull();
  });

  it("exits a time stop on the first snapshot after that many Chicago trading days", () => {
    const monday = Date.parse("2026-10-05T15:00:00Z");
    const tuesday = Date.parse("2026-10-06T15:00:00Z");
    const input = {
      entryPrice: 2,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [{ at: monday, price: 2.1 }, { at: tuesday, price: 2.1 }],
    };
    expect(replayExit(input, scenario("time2"))?.pnlDollars).toBeCloseTo(10);
    expect(replayExit({ ...input, marks: [{ at: monday, price: 2.1 }] }, scenario("time3"))).toBeNull();
    expect(replayExit(input, scenario("time3"))?.pnlDollars).toBeCloseTo(10);
    expect(replayExit({ ...input, marks: [{ at: monday, price: 2.1 }] }, scenario("time5"))).toBeNull();
  });

  it("lists +60% with a -35% stop immediately after the -35% stop row", () => {
    expect(WHAT_IF_SCENARIOS.map((row) => row.id)).toEqual([
      "tp25",
      "tp40",
      "tp60",
      "stop20",
      "stop25",
      "stop35",
      "tp60stop35",
      "time2",
      "time3",
      "time5",
      "trail25",
    ]);
    const rule = scenario("tp60stop35");
    expect(rule.label).toBe("Take profit at +60%. Stop at -35%. Time stop stays 3 trading days.");
    expect(rule.profitFraction).toBe(0.60);
    expect(rule.stopFraction).toBe(-0.35);
    expect(rule.flatDays).toBe(3);
    expect(rule.trailArm).toBeNull();
    expect(rule.trailGiveback).toBeNull();
  });

  it("takes +60% with a -35% stop, and keeps a -30% dip that a -25% stop exits", () => {
    const hitsTarget = {
      entryPrice: 2,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [
        { at: OPEN + 60 * 60_000, price: 2.8 },
        { at: OPEN + 2 * 60 * 60_000, price: 3.2 },
      ],
    };
    expect(replayExit(hitsTarget, scenario("tp60stop35"))?.pnlDollars).toBeCloseTo(120);
    expect(replayExit(hitsTarget, scenario("stop35"))?.pnlDollars).toBeCloseTo(80);

    const dipped = {
      entryPrice: 2,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [
        { at: OPEN + 60_000, price: 1.4 },
        { at: OPEN + 2 * 60_000, price: 2.2 },
      ],
    };
    expect(replayExit(dipped, scenario("tp60stop35"))).toBeNull();
    expect(replayExit(dipped, scenario("tp60"))?.pnlDollars).toBeCloseTo(-60);
    expect(replayExit(dipped, scenario("stop25"))?.pnlDollars).toBeCloseTo(-60);

    const recovered = {
      ...dipped,
      marks: [...dipped.marks, { at: OPEN + 3 * 60_000, price: 3.2 }],
    };
    expect(replayExit(recovered, scenario("tp60stop35"))?.pnlDollars).toBeCloseTo(120);
    expect(replayExit(recovered, scenario("tp60"))?.pnlDollars).toBeCloseTo(-60);
  });

  it("trails after a snapshot is up 25%", () => {
    const exit = replayExit({
      entryPrice: 2,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [
        { at: OPEN + 60_000, price: 2.6 },
        { at: OPEN + 120_000, price: 2.2 },
      ],
    }, scenario("trail25"));
    expect(exit?.pnlDollars).toBeCloseTo(20);
  });

  it("uses the $875 floor when a percent stop would plan a larger loss", () => {
    const throughCap = replayExit({
      entryPrice: 30,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [{ at: OPEN + 60_000, price: 20 }],
    }, scenario("stop35"));
    expect(throughCap).not.toBeNull();
    expect(replayExit({
      entryPrice: 30,
      openedAt: OPEN,
      expiration: EXPIRATION,
      marks: [{ at: OPEN + 60_000, price: 21.4 }],
    }, scenario("stop35"))).toBeNull();
  });

  it("skips a shadow with no quote path, leaves the test cohort out, and warns under 30", () => {
    const priced = shadow({
      id: "pricedpath0000001",
      marks: [{ at: OPEN + 60_000, price: 2.5 }],
    });
    const blank = shadow({ id: "blankpath00000001", marks: [] });
    const testOnly = shadow({
      id: "testpath000000001",
      cohort: "experiment",
      grade: "test",
      marks: [{ at: OPEN + 60_000, price: 3 }],
    });
    const report = whatIfFromShadows([priced, blank, testOnly]);
    expect(report.included).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.pathNote).toMatch(/left out/i);
    expect(report.scenarios.map((row) => row.id)).toEqual(WHAT_IF_SCENARIOS.map((row) => row.id));
    const tp25 = report.scenarios.find((row) => row.id === "tp25");
    const tp60 = report.scenarios.find((row) => row.id === "tp60");
    const tp60stop35 = report.scenarios.find((row) => row.id === "tp60stop35");
    expect(tp25?.resolved).toBe(1);
    expect(tp25?.wins).toBe(1);
    expect(tp25?.tooFew).toBe(true);
    expect(tp60?.resolved).toBe(0);
    expect(tp60?.unresolved).toBe(1);
    expect(tp60?.winRate).toBeNull();
    expect(tp60stop35?.resolved).toBe(0);
    expect(tp60stop35?.unresolved).toBe(1);
    expect(tp60stop35?.winRate).toBeNull();

    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push(shadow({
        id: `manywhatif${String(i).padStart(4, "0")}`,
        marks: [{ at: OPEN + 60_000, price: 2.5 }],
      }));
    }
    const trusted = whatIfFromShadows(many);
    expect(trusted.scenarios.find((row) => row.id === "tp25")?.tooFew).toBe(false);
    expect(trusted.scenarios.find((row) => row.id === "tp60")?.tooFew).toBe(true);
    expect(trusted.scenarios.find((row) => row.id === "tp60stop35")?.tooFew).toBe(true);
  });
});
