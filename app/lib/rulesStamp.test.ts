import { describe, expect, it } from "vitest";
import { buildStoredAlert, type StoredAlert } from "@/app/lib/alertBook";
import type { AlertVerdict } from "@/app/lib/verdict";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { RULES_VERSION, parseRulesVersion } from "@/app/lib/rulesVersion";
import { shadowFromAlert } from "@/app/lib/shadow";
import { buildTrade, parseTradeLog } from "@/app/lib/trades";
import type { FlowRow } from "@/app/lib/flow";

const NOW = new Date("2026-10-01T15:00:00Z");

function verdict(): AlertVerdict {
  return {
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "B",
    uncappedGrade: "B",
    reasons: ["Liquidity passes."],
    note: "Rules checklist only.",
    levels: null,
    levelsNote: null,
    eventLine: "No earnings date listed.",
    maxContracts: 4,
    singleContractExceedsCap: false,
    suggestion: null,
    liquidityPasses: true,
    dailyStop: false,
  };
}

function row(): FlowRow {
  return {
    id: "SPY|2026-10-22|100|call",
    ticker: "SPY",
    putCall: "call",
    strike: 100,
    expiration: "2026-10-22",
    bid: 2,
    ask: 2.05,
    last: 2.05,
    volume: 800,
    openInterest: 500,
    iv: 0.22,
    delta: 0.4,
    mid: 2.025,
    notionalPremium: 162_000,
    volOiRatio: 1.6,
    volumeOiJump: 300,
    volumeExceedsOi: true,
    previousVolume: 400,
    volumeJump: 400,
    otmPoints: 4,
    otmFraction: 0.04,
    otm: true,
    dte: 21,
    spreadFraction: 0.025,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "Estimated.",
    askFraction: 1,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 100,
    levels: null,
    prints: EMPTY_PRINTS,
    score: 40,
  };
}

describe("rules version", () => {
  it("stamps a new alert, the shadow opened from it, and a new paper trade", () => {
    expect(RULES_VERSION).toBe(2);
    const alert = buildStoredAlert(row(), verdict(), NOW);
    expect(alert.rulesVersion).toBe(2);
    const shadow = shadowFromAlert(alert);
    expect(shadow?.rulesVersion).toBe(2);
    expect(shadow?.marks).toEqual([]);

    const fresh = buildTrade({
      ticker: "SPY",
      putCall: "call",
      strike: 100,
      expiration: "2026-10-22",
      contracts: 1,
      entryPrice: 2,
    }, "t_rulesversion00001", NOW);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.trade.rulesVersion).toBe(2);

    const copied = buildTrade({
      ticker: "SPY",
      putCall: "call",
      strike: 100,
      expiration: "2026-10-22",
      contracts: 1,
      entryPrice: 2,
      rulesVersion: null,
    }, "t_rulesversion00002", NOW);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.trade.rulesVersion).toBeNull();
  });

  it("does not invent a version for a row that was saved without one", () => {
    expect(parseRulesVersion(undefined)).toBeNull();
    expect(parseRulesVersion(1.5)).toBeNull();
    expect(parseRulesVersion(0)).toBeNull();
    expect(parseRulesVersion(2)).toBe(2);
    const alert = buildStoredAlert(row(), verdict(), NOW);
    const old: StoredAlert = { ...alert, rulesVersion: undefined };
    const text = JSON.stringify({
      version: 1,
      trades: [{
        id: "t_unstamped0000001",
        openedAt: NOW.getTime(),
        ticker: "SPY",
        putCall: "call",
        strike: 100,
        expiration: "2026-10-22",
        contracts: 1,
        entryPrice: 2,
        closedAt: null,
        exitPrice: null,
      }],
    });
    expect(parseTradeLog(text).trades[0]?.rulesVersion).toBeNull();
    expect(old.rulesVersion ?? null).toBeNull();
  });
});
