import { describe, expect, it } from "vitest";
import { ALERT_RULES } from "@/app/lib/alertConfig";
import type { OptionContract } from "@/app/lib/contract";
import { UNKNOWN_EARNINGS, type EarningsFact } from "@/app/lib/eventRisk";
import {
  gradeMyTrade,
  parseGradeRequest,
  type GradeCheckRow,
  type GradeMyTradeInput,
} from "@/app/lib/gradeTrade";
import type { KeyLevels } from "@/app/lib/levels";
import { DEFAULT_MAX_LOSS_DOLLARS, MAX_LOSS_DOLLARS, MIN_OPEN_INTEREST, readMaxLossDollars } from "@/app/lib/risk";
import { analyzeLearning, readGradeChecks } from "@/app/lib/learn";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import { buildTrade, parseTradeLog, summarizeTrades } from "@/app/lib/trades";

const NOW = new Date("2026-05-14T15:00:00Z");

function levels(): KeyLevels {
  return {
    checked: true,
    spot: 100,
    support: { price: 99, label: "prior day low", distance: 0.01 },
    resistance: { price: 102, label: "session high", distance: 0.02 },
    vwap: 100.4,
    sma20: null,
    priorClose: 99.5,
    callWall: 105,
    putWall: 95,
  };
}

function earnings(): EarningsFact {
  return { status: "known", date: "2026-12-20", timing: "after-market", estimated: false };
}

function contract(over: Partial<OptionContract> = {}): OptionContract {
  return {
    bid: 2,
    ask: 2.05,
    last: 2.05,
    volume: 3000,
    openInterest: 1000,
    delta: null,
    iv: null,
    strike: 104,
    expiration: "2026-06-04",
    putCall: "call",
    quoteTime: NOW.getTime(),
    ...over,
  };
}

function grade(over: Partial<GradeMyTradeInput> = {}) {
  return gradeMyTrade({
    expiration: "2026-06-04",
    strike: 104,
    putCall: "call",
    contract: contract(),
    underlyingPrice: 100,
    delayed: false,
    now: NOW,
    consecutiveLosses: 0,
    levels: levels(),
    earnings: earnings(),
    providerError: null,
    plannedEntry: null,
    thesis: "Breakout over the morning high",
    ...over,
  });
}

function check(rows: GradeCheckRow[], id: string): GradeCheckRow {
  const found = rows.find((row) => row.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

const QUOTE_IDS = ["openInterest", "volume", "spread", "ask", "cost", "flow", "flowSignals", "moneyness", "levels"];

describe("grade my trade", () => {
  it("grades a live contract A with the alert checklist", () => {
    const result = grade();
    expect(result.overall).toBe("A");
    expect(result.scannerGrade).toBe("A");
    expect(result.verdict).toBe("TAKE");
    expect(check(result.checks, "openInterest").status).toBe("pass");
    expect(check(result.checks, "flow").detail).toMatch(/\$100K|\$608K|\$607K/);
    expect(check(result.checks, "dte").detail).toContain(String(ALERT_RULES.alertDteMin));
    expect(check(result.checks, "cost").detail).toContain(String(MAX_LOSS_DOLLARS));
    expect(check(result.checks, "ask").status).toBe("pass");
    expect(check(result.checks, "levels").status).toBe("pass");
    expect(result.quotedAt).toBe(NOW.getTime());
    expect(result.quoteNote).toMatch(/Quote time/);
    expect(result.entryPrice).toBe(2.05);
    expect(result.entryPriceSource).toBe("ask");
    expect(result.canSave).toBe(true);
    expect(result.flowPremium).toBeGreaterThan(ALERT_RULES.aMinFlowPremium);
  });

  it("stays a B when flow premium clears $50K and not $100K", () => {
    const result = grade({
      contract: contract({
        bid: 0.49,
        ask: 0.51,
        last: 0.51,
        volume: 1200,
        openInterest: 600,
      }),
    });
    expect(check(result.checks, "flow").status).toBe("pass");
    expect(check(result.checks, "flow").detail).toMatch(/B floor/);
    expect(check(result.checks, "flow").detail).toContain("$50K");
    expect(check(result.checks, "flow").detail).toContain("$100K");
    expect(result.overall).toBe("B");
    expect(result.overall).not.toBe("A");
  });

  it("fails open interest below the minimum with the count in the reason", () => {
    const result = grade({ contract: contract({ openInterest: 230, volume: 3000 }) });
    const row = check(result.checks, "openInterest");
    expect(row.status).toBe("fail");
    expect(row.detail).toContain("230");
    expect(row.detail).toContain(String(MIN_OPEN_INTEREST));
    expect(result.overall).toBe("Fail");
  });

  it("does not count a missing open interest number as a pass", () => {
    const result = grade({ contract: contract({ openInterest: Number.NaN, volume: Number.NaN }) });
    expect(check(result.checks, "openInterest").status).toBe("unknown");
    expect(check(result.checks, "openInterest").detail).not.toMatch(/NaN/);
    expect(check(result.checks, "flow").status).toBe("unknown");
    expect(result.overall).not.toBe("A");
  });

  it("does not pass a missing quote, and an unknown required check cannot be an A", () => {
    const result = grade({ contract: null, underlyingPrice: null, levels: null, earnings: null });
    expect(result.overall).toBe("Fail");
    expect(result.scannerGrade).toBeNull();
    expect(check(result.checks, "quote").status).toBe("unknown");
    expect(check(result.checks, "openInterest").status).toBe("unknown");
    expect(check(result.checks, "flow").status).toBe("unknown");
    for (const id of QUOTE_IDS) expect(check(result.checks, id).status).not.toBe("pass");
    expect(result.checks.some((row) => /2\.05|1,000|Open interest 1000/.test(row.detail))).toBe(false);
    expect(result.entryPrice).toBeNull();
    expect(result.canSave).toBe(false);
  });

  it("treats a closed market and a stale quote as unknown, never a pass", () => {
    const closed = grade({ now: new Date("2026-05-16T15:00:00Z") });
    expect(closed.overall).not.toBe("A");
    expect(check(closed.checks, "quote").status).toBe("unknown");
    expect(check(closed.checks, "quote").detail).toMatch(/market is closed/i);
    for (const id of QUOTE_IDS) expect(check(closed.checks, id).status).not.toBe("pass");

    const stale = grade({ contract: contract({ quoteTime: NOW.getTime() - 24 * 60 * 60 * 1000 }) });
    expect(stale.overall).not.toBe("A");
    expect(check(stale.checks, "quote").status).toBe("unknown");
    expect(check(stale.checks, "openInterest").status).toBe("unknown");
    expect(check(stale.checks, "quote").detail).toMatch(/not from the current Chicago session/);

    const untimed = grade({ contract: contract({ quoteTime: null }) });
    expect(untimed.overall).not.toBe("A");
    expect(check(untimed.checks, "quote").status).toBe("unknown");
    expect(check(untimed.checks, "ask").status).not.toBe("pass");
  });

  it("keeps a provider error unknown and does not invent a quote", () => {
    const result = grade({
      contract: null,
      underlyingPrice: null,
      levels: null,
      earnings: null,
      providerError: "Schwab market data request failed, so this quote was not graded.",
    });
    expect(result.overall).toBe("Fail");
    expect(check(result.checks, "quote").status).toBe("unknown");
    expect(check(result.checks, "quote").detail).toMatch(/Schwab market data request failed/);
    expect(check(result.checks, "openInterest").status).toBe("unknown");
    expect(result.flowPremium).toBeNull();
    expect(result.ask).toBeNull();
    expect(result.checks.some((row) => row.status === "pass" && QUOTE_IDS.includes(row.id))).toBe(false);
  });

  it("caps an otherwise A setup at B when levels or earnings are unknown", () => {
    const missingLevels = grade({ levels: null });
    expect(missingLevels.scannerGrade).toBe("B");
    expect(missingLevels.overall).toBe("B");
    expect(check(missingLevels.checks, "levels").status).toBe("unknown");

    const missingEarnings = grade({ earnings: UNKNOWN_EARNINGS });
    expect(missingEarnings.overall).not.toBe("A");
    expect(check(missingEarnings.checks, "earnings").status).toBe("unknown");
  });

  it("fails a cheap ask, a contract over the cap, a short expiration, and the daily stop", () => {
    const cheap = grade({ contract: contract({ bid: 0.2, ask: 0.4, last: 0.4 }) });
    expect(check(cheap.checks, "ask").status).toBe("fail");
    expect(check(cheap.checks, "ask").detail).toContain("$0.50");
    expect(cheap.overall).toBe("Fail");

    const costly = grade({ contract: contract({ bid: 8.9, ask: 9, last: 9, volume: 2000, openInterest: 800 }) });
    expect(check(costly.checks, "cost").status).toBe("fail");
    expect(check(costly.checks, "cost").detail).toContain(String(MAX_LOSS_DOLLARS));
    expect(costly.overall).toBe("Fail");

    const soon = grade({
      expiration: "2026-05-20",
      contract: contract({ expiration: "2026-05-20" }),
    });
    expect(check(soon.checks, "dte").status).toBe("fail");
    expect(soon.overall).toBe("Fail");

    const stopped = grade({ consecutiveLosses: 2 });
    expect(check(stopped.checks, "dailyStop").status).toBe("fail");
    expect(stopped.overall).toBe("Fail");
    expect(stopped.canSave).toBe(false);
  });

  it("uses a typed entry and refuses to save without a price", () => {
    const typed = grade({ plannedEntry: 1.8, contract: contract({ quoteTime: null }) });
    expect(typed.entryPrice).toBe(1.8);
    expect(typed.entryPriceSource).toBe("typed");
    expect(typed.canSave).toBe(true);

    const blank = grade({ contract: null, underlyingPrice: null });
    expect(blank.entryPrice).toBeNull();
    expect(blank.saveBlock).toMatch(/planned entry/i);
  });
});

describe("grade request validation", () => {
  it("rejects a bad ticker, an impossible expiration, and a bad strike", () => {
    expect(parseGradeRequest({ ticker: "123", expiration: "2026-06-04", strike: 100, putCall: "call" }).ok).toBe(false);
    expect(parseGradeRequest({ ticker: "", expiration: "2026-06-04", strike: 100, putCall: "call" }).ok).toBe(false);
    const badDate = parseGradeRequest({ ticker: "SPY", expiration: "2026-02-31", strike: 100, putCall: "call" });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.error).toMatch(/YYYY-MM-DD/);
    expect(parseGradeRequest({ ticker: "SPY", expiration: "06/04/2026", strike: 100, putCall: "call" }).ok).toBe(false);
    expect(parseGradeRequest({ ticker: "SPY", expiration: "2026-06-04", strike: 0, putCall: "call" }).ok).toBe(false);
    expect(parseGradeRequest({ ticker: "SPY", expiration: "2026-06-04", strike: "nope", putCall: "call" }).ok).toBe(false);
    expect(parseGradeRequest({ ticker: "SPY", expiration: "2026-06-04", strike: 100, putCall: "both" }).ok).toBe(false);
    expect(parseGradeRequest({ ticker: "spy", expiration: "2026-06-04", strike: "105.5", putCall: "put", plannedEntry: "" }).ok).toBe(true);
    const planned = parseGradeRequest({ ticker: "SPY", expiration: "2026-06-04", strike: 100, putCall: "call", plannedEntry: -1 });
    expect(planned.ok).toBe(false);
  });
});

describe("loss cap config", () => {
  it("reads one env value and keeps 875 when it is unset or invalid", () => {
    expect(DEFAULT_MAX_LOSS_DOLLARS).toBe(875);
    expect(MAX_LOSS_DOLLARS).toBe(875);
    expect(readMaxLossDollars(undefined)).toBe(875);
    expect(readMaxLossDollars("")).toBe(875);
    expect(readMaxLossDollars("nope")).toBe(875);
    expect(readMaxLossDollars("450")).toBe(450);
    expect(readMaxLossDollars("750")).toBe(750);
    expect(ALERT_RULES.maxContractCost).toBe(MAX_LOSS_DOLLARS);
  });
});

describe("graded trade log", () => {
  it("stores the grade, checks, thesis, and entry on an open paper trade", () => {
    const graded = grade();
    const built = buildTrade({
      ticker: "NVDA",
      putCall: "call",
      strike: 104,
      expiration: "2026-06-04",
      contracts: 1,
      entryPrice: graded.entryPrice ?? 0,
      entryPriceSource: "ask",
      alertGrade: "A",
      alertVerdict: "TAKE",
      gradeOverall: graded.overall,
      thesis: graded.thesis,
      quotedAt: graded.quotedAt,
      flowPremium: graded.flowPremium,
      gradeChecks: graded.checks.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        detail: row.detail,
      })),
    }, "t_grade00000000001", NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.trade.closedAt).toBeNull();
    expect(built.trade.gradeOverall).toBe("A");
    expect(built.trade.thesis).toMatch(/Breakout/);
    expect(built.trade.gradeChecks?.[0]?.status).toBe("pass");
    const restored = parseTradeLog(JSON.stringify({ version: 1, trades: [built.trade] }));
    expect(restored.trades[0]?.gradeOverall).toBe("A");
    expect(restored.trades[0]?.thesis).toBe(built.trade.thesis);
    expect(restored.trades[0]?.gradeChecks?.length).toBe(graded.checks.length);
    const closed = { ...built.trade, closedAt: NOW.getTime() + 60_000, exitPrice: 3 };
    const stats = summarizeTrades([closed], NOW);
    expect(stats.byGrade.find((row) => row.key === "A")?.closed).toBe(1);
    expect(stats.open).toBe(0);
  });

  it("shows a closed Grade my trade in Learning mode with its checks and rules version", () => {
    const graded = grade();
    expect(graded.features?.capturedAtAlert).toBe(true);
    const built = buildTrade({
      ticker: "NVDA",
      putCall: "call",
      strike: 104,
      expiration: "2026-06-04",
      contracts: 1,
      entryPrice: graded.entryPrice ?? 0,
      entryPriceSource: "ask",
      alertGrade: "A",
      alertVerdict: "TAKE",
      gradeOverall: graded.overall,
      thesis: graded.thesis,
      quotedAt: graded.quotedAt,
      flowPremium: graded.flowPremium,
      features: graded.features,
      gradeChecks: graded.checks.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        detail: row.detail,
      })),
    }, "t_gradelearn0000001", NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.trade.rulesVersion).toBe(RULES_VERSION);
    const closed = { ...built.trade, closedAt: NOW.getTime() + 60_000, exitPrice: 3 };
    const checks = readGradeChecks(JSON.stringify({ version: 1, trades: [closed] }));
    const report = analyzeLearning({
      shadows: [],
      alerts: [],
      trades: [closed],
      checksByTradeId: checks,
      now: NOW,
    });
    expect(report.resolved).toBe(1);
    expect(report.trades[0].source).toBe("paper");
    expect(report.trades[0].rulesVersion).toBe(2);
    expect(report.trades[0].checks?.some((row) => row.id === "spread" && row.status === "pass")).toBe(true);
    expect(report.factors.find((factor) => factor.id === "rulesVersion")?.buckets.map((bucket) => bucket.key)).toContain("Version 2");
    expect(report.factors.find((factor) => factor.id === "check:spread")?.buckets.map((bucket) => bucket.key)).toEqual(["Pass"]);
  });
});
