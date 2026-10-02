import { describe, expect, it } from "vitest";
import { ALERT_RULES, EVENT_RULES, alertDeliveryNote, gradeARubric } from "@/app/lib/alertConfig";
import {
  EARNINGS_SKIP_SENTENCE,
  EARNINGS_UNKNOWN_PHRASE,
  IV_CRUSH_SENTENCE,
  MACRO_CAUTION,
  NO_EARNINGS_LISTED,
  UNKNOWN_EARNINGS,
  type EarningsFact,
} from "@/app/lib/eventRisk";
import { addCalendarDays } from "@/app/lib/flow";
import { DEBIT_SPREAD_SUGGESTION } from "@/app/lib/gate";
import { formatLevelsSummary, type KeyLevels } from "@/app/lib/levels";
import { MAX_LOSS_DOLLARS, MIN_OPEN_INTEREST } from "@/app/lib/risk";
import type { OptionContract } from "@/app/lib/contract";
import type { FlowRow } from "@/app/lib/flow";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { formatFlowAlert, formatVerdictHtml } from "@/app/lib/telegram";
import { gradeContract, gradeFlowRow, gradeSetup, type SetupInput } from "@/app/lib/verdict";

function setup(over: Partial<SetupInput> = {}): SetupInput {
  return {
    bid: 2,
    ask: 2.05,
    volume: 800,
    openInterest: 500,
    mid: 2.025,
    notionalPremium: 162_000,
    volOiRatio: 1.6,
    volumeJump: 150,
    side: "estimated at ask",
    otmFraction: 0.04,
    otm: true,
    dte: 21,
    delayed: false,
    strike: 104,
    expiration: "2026-06-04",
    putCall: "call",
    underlyingPrice: 100,
    consecutiveLosses: null,
    levels: null,
    earnings: { status: "known", date: "2026-12-20", timing: "after-market", estimated: false },
    definedRiskSpread: false,
    now: new Date("2026-05-14T15:00:00Z"),
    ...over,
  };
}

function levels(over: Partial<KeyLevels> = {}): KeyLevels {
  return {
    checked: true,
    spot: 100,
    support: { price: 99, label: "prior day low", distance: 0.01 },
    resistance: { price: 102, label: "session high", distance: 0.02 },
    vwap: 100.4,
    priorClose: 99.5,
    callWall: 105,
    putWall: 95,
    ...over,
  };
}

describe("alert checklist", () => {
  it("grades a liquid 2 to 6 week setup as TAKE and caps the letter at B without levels", () => {
    const result = gradeSetup(setup());
    expect(result.verdict).toBe("TAKE");
    expect(result.verdictLabel).toBe("TAKE");
    expect(result.uncappedGrade).toBe("B");
    expect(result.grade).toBe(ALERT_RULES.maxGradeUntilLevels);
    expect(result.grade).toBe("B");
    expect(result.levels).toBeNull();
    expect(result.liquidityPasses).toBe(true);
    expect(result.maxContracts).toBe(4);
    expect(result.dailyStop).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.length).toBeLessThanOrEqual(4);
    expect(result.reasons.some((reason) => /pass the Gate/i.test(reason))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes(`$${MAX_LOSS_DOLLARS}`))).toBe(true);
    expect(result.reasons.some((reason) => /not available/i.test(reason))).toBe(true);
    expect(result.note).toMatch(/not a prediction of profit/i);
    expect(result.levelsNote).toMatch(/not available/i);
    expect(result.levelsNote).toMatch(/B/);
  });

  it("lifts the B cap when support and resistance were computed and there is room", () => {
    const result = gradeSetup(setup({ levels: levels() }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.uncappedGrade).toBe("B");
    expect(result.levelsNote).toBeNull();
    expect(result.levels?.supportPrice).toBe(99);
    expect(result.levels?.resistancePrice).toBe(102);
    expect(result.reasons.some((reason) => /room for a call/i.test(reason))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("$99.00"))).toBe(true);
    const html = formatVerdictHtml(result);
    expect(html).toContain("B · TAKE");
    expect(html).toContain(formatLevelsSummary(result.levels!));
  });

  it("favors a put when price has room down to support", () => {
    const result = gradeSetup(setup({
      putCall: "put",
      strike: 96,
      levels: levels({
        support: { price: 98, label: "put wall", distance: 0.02 },
        resistance: { price: 101, label: "prior day high", distance: 0.01 },
      }),
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.reasons.some((reason) => /room for a put/i.test(reason))).toBe(true);
  });

  it("lowers a call that is tight under resistance and does not skip it", () => {
    const result = gradeSetup(setup({
      levels: levels({
        support: { price: 97, label: "prior day low", distance: 0.03 },
        resistance: { price: 100.1, label: "round number", distance: 0.001 },
      }),
    }));
    expect(result.verdict).toBe("WATCH");
    expect(result.grade).toBe("C");
    expect(result.levelsNote).toBeNull();
    expect(result.reasons.some((reason) => /tight for a call/i.test(reason))).toBe(true);
    expect(result.reasons.length).toBeLessThanOrEqual(4);
  });

  it("lowers a put sitting on support", () => {
    const result = gradeSetup(setup({
      putCall: "put",
      strike: 96,
      levels: levels({
        support: { price: 99.9, label: "prior day low", distance: 0.001 },
        resistance: { price: 103, label: "session high", distance: 0.03 },
      }),
    }));
    expect(result.verdict).toBe("WATCH");
    expect(result.grade).toBe("C");
    expect(result.reasons.some((reason) => /tight for a put/i.test(reason))).toBe(true);
  });

  it("lowers the grade when the reward to the next level is poor", () => {
    const result = gradeSetup(setup({
      levels: levels({
        support: { price: 98, label: "prior day low", distance: 0.02 },
        resistance: { price: 100.5, label: "call wall", distance: 0.005 },
      }),
    }));
    expect(result.verdict).toBe("WATCH");
    expect(result.grade).toBe("C");
    expect(result.reasons.some((reason) => /reward to the next level is poor for a call/i.test(reason))).toBe(true);
  });

  it("drops a watch from C to D when the level reward is poor", () => {
    const weak = setup({
      volOiRatio: 0.2,
      notionalPremium: 20_000,
      volumeJump: null,
      side: "estimated at bid",
      otmFraction: 0.2,
      dte: 7,
    });
    expect(gradeSetup(weak).verdict).toBe("WATCH");
    expect(gradeSetup(weak).grade).toBe("C");
    const poor = gradeSetup({
      ...weak,
      levels: levels({
        support: { price: 98, label: "prior day low", distance: 0.02 },
        resistance: { price: 100.5, label: "call wall", distance: 0.005 },
      }),
    });
    expect(poor.verdict).toBe("WATCH");
    expect(poor.grade).toBe("D");
  });

  it("does not let a poor level turn a liquidity skip into something else", () => {
    const result = gradeSetup(setup({
      openInterest: MIN_OPEN_INTEREST - 1,
      levels: levels({
        resistance: { price: 100.1, label: "round number", distance: 0.001 },
      }),
    }));
    expect(result.verdict).toBe("SKIP");
    expect(result.grade).toBe("D");
  });

  it("does not call a weak liquid contract a TAKE", () => {
    const result = gradeSetup(setup({
      volume: 100,
      openInterest: 500,
      volOiRatio: 0.2,
      notionalPremium: 20_250,
      volumeJump: null,
      side: "estimated at bid",
      otmFraction: 0.2,
      dte: 50,
    }));
    expect(result.verdict).toBe("WATCH");
    expect(result.grade).toBe("D");
    expect(result.liquidityPasses).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.length).toBeLessThanOrEqual(4);
    expect(result.reasons.join(" ")).toMatch(/longer than a quick hold|outside the range/i);
  });

  it("skips when open interest misses the Gate minimum", () => {
    const result = gradeSetup(setup({ openInterest: MIN_OPEN_INTEREST - 1, volOiRatio: 2 }));
    expect(result.verdict).toBe("SKIP");
    expect(result.grade).toBe("D");
    expect(result.liquidityPasses).toBe(false);
    expect(result.reasons.some((reason) => reason.includes(String(MIN_OPEN_INTEREST)))).toBe(true);
    expect(result.reasons.length).toBeLessThanOrEqual(4);
  });

  it("fits a contract under the $875 loss cap and does not name a debit spread", () => {
    const result = gradeSetup(setup({ bid: 4.9, ask: 5, mid: 4.95, volume: 200, openInterest: 800, volOiRatio: 0.25 }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.singleContractExceedsCap).toBe(false);
    expect(result.maxContracts).toBe(1);
    expect(result.suggestion).toBeNull();
    expect(result.reasons.some((reason) => reason.includes(DEBIT_SPREAD_SUGGESTION))).toBe(false);
    expect(result.reasons.join(" ")).toContain(`$${MAX_LOSS_DOLLARS}`);
  });

  it("skips delayed quotes even when the other bars pass", () => {
    const result = gradeSetup(setup({ delayed: true }));
    expect(result.verdict).toBe("SKIP");
    expect(result.reasons.some((reason) => /delayed/i.test(reason))).toBe(true);
    expect(result.liquidityPasses).toBe(true);
  });

  it("shows STOP for today instead of TAKE after two losses", () => {
    const stopped = gradeSetup(setup({ consecutiveLosses: 2 }));
    expect(stopped.verdict).toBe("STOP");
    expect(stopped.verdictLabel).toBe("STOP for today");
    expect(stopped.grade).toBe("B");
    expect(stopped.dailyStop).toBe(true);
    expect(stopped.reasons.some((reason) => /STOP for today/i.test(reason))).toBe(true);

    expect(gradeSetup(setup({ consecutiveLosses: 1 })).verdict).toBe("TAKE");
    expect(gradeSetup(setup({ consecutiveLosses: null })).verdict).toBe("TAKE");
    expect(gradeSetup(setup({ consecutiveLosses: 0 })).verdict).toBe("TAKE");
  });

  it("keeps a liquidity failure as SKIP when the daily stop is also on", () => {
    const result = gradeSetup(setup({ openInterest: 10, consecutiveLosses: 2 }));
    expect(result.verdict).toBe("SKIP");
    expect(result.dailyStop).toBe(true);
  });

  it("escapes checklist text for Telegram", () => {
    const result = gradeSetup(setup());
    const html = formatVerdictHtml({ ...result, reasons: ["5 < 6 & more"] });
    expect(html).toContain("B · TAKE");
    expect(html).toContain("5 &lt; 6 &amp; more");
    expect(html.includes("<script>")).toBe(false);
    expect(html).toContain("Next earnings 2026-12-20 after the close.");
  });

  it("keeps an A when earnings are after expiration and no macro release is inside the contract", () => {
    const result = gradeSetup(excellent());
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("A");
    expect(result.eventLine).toContain("Next earnings 2026-12-20 after the close.");
    expect(result.eventLine.includes(IV_CRUSH_SENTENCE)).toBe(false);
  });

  it("downgrades when earnings fall on or before expiration and names IV crush", () => {
    const result = gradeSetup(excellent({
      earnings: { status: "known", date: "2026-05-28", timing: "before-market", estimated: false },
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.uncappedGrade).toBe("B");
    expect(result.eventLine).toContain("Next earnings 2026-05-28 before the open.");
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
    expect(result.reasons.some((reason) => reason.includes(IV_CRUSH_SENTENCE))).toBe(true);
  });

  it("skips a short-dated single when earnings are today or tomorrow", () => {
    const today = "2026-05-14";
    const earningsDate = addCalendarDays(today, EVENT_RULES.imminentEarningsDays);
    const result = gradeSetup(setup({
      levels: levels(),
      dte: EVENT_RULES.shortDatedDteMax,
      expiration: "2026-05-24",
      earnings: { status: "known", date: earningsDate, timing: "after-market", estimated: false },
    }));
    expect(result.verdict).toBe("SKIP");
    expect(result.grade).not.toBe("A");
    expect(result.eventLine).toContain(EARNINGS_SKIP_SENTENCE);
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
    expect(result.reasons.some((reason) => reason === EARNINGS_SKIP_SENTENCE)).toBe(true);
  });

  it("does not skip a defined-risk spread when earnings are tomorrow", () => {
    const result = gradeSetup(setup({
      levels: levels(),
      dte: 3,
      expiration: "2026-05-17",
      definedRiskSpread: true,
      earnings: { status: "known", date: "2026-05-15", timing: "after-market", estimated: false },
    }));
    expect(result.verdict).not.toBe("SKIP");
    expect(result.verdict).toBe("WATCH");
    expect(result.grade === "A" || result.grade === "B").toBe(false);
    expect(result.eventLine.includes(EARNINGS_SKIP_SENTENCE)).toBe(false);
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
  });

  it("caps the grade at B and says earnings date unknown when the date is missing", () => {
    const result = gradeSetup(excellent({ earnings: UNKNOWN_EARNINGS }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe(EVENT_RULES.maxGradeUntilEarnings);
    expect(result.grade).toBe("B");
    expect(result.uncappedGrade).toBe("A");
    expect(result.eventLine.startsWith(EARNINGS_UNKNOWN_PHRASE)).toBe(true);
    expect(result.reasons.some((reason) => reason.includes(EARNINGS_UNKNOWN_PHRASE))).toBe(true);
  });

  it("does not cap a ticker that has no earnings calendar", () => {
    const result = gradeSetup(excellent({ earnings: NO_EARNINGS_LISTED }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("A");
    expect(result.eventLine).toContain("No earnings date listed");
    expect(result.eventLine.includes(EARNINGS_UNKNOWN_PHRASE)).toBe(false);
  });

  it("downgrades one step for a macro release on or before expiration", () => {
    const jobs = EVENT_RULES.macroDates.find((row) => row.date === "2026-10-02" && row.name === "Jobs report");
    expect(jobs).toBeTruthy();
    const result = gradeSetup(excellent({
      now: new Date("2026-05-20T15:00:00Z"),
      dte: 21,
      expiration: "2026-06-10",
      earnings: farEarnings(),
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.eventLine).toContain("Jobs report on 2026-06-05");
    expect(result.eventLine).toContain(MACRO_CAUTION);
  });

  it("stacks the earnings downgrade and the macro downgrade", () => {
    const result = gradeSetup(excellent({
      now: new Date("2026-05-20T15:00:00Z"),
      dte: 21,
      expiration: "2026-06-10",
      earnings: { status: "known", date: "2026-05-28", timing: "after-market", estimated: false },
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("C");
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
    expect(result.eventLine).toContain("Jobs report on 2026-06-05");
    expect(result.reasons.length).toBeLessThanOrEqual(4);
  });

  it("does not let an earnings skip replace a liquidity skip", () => {
    const result = gradeSetup(setup({
      openInterest: MIN_OPEN_INTEREST - 1,
      dte: 2,
      expiration: "2026-10-07",
      earnings: { status: "known", date: "2026-10-06", timing: "before-market", estimated: false },
    }));
    expect(result.verdict).toBe("SKIP");
    expect(result.grade).toBe("D");
    expect(result.liquidityPasses).toBe(false);
  });

  it("escapes the event line for Telegram", () => {
    const result = gradeSetup(setup());
    const html = formatVerdictHtml({ ...result, eventLine: "CPI < jobs & more" });
    expect(html).toContain("CPI &lt; jobs &amp; more");
  });

  it("puts a quote-derived print on the checklist without calling it an exchange sweep", () => {
    const summary = "Detected from Schwab quotes: block print, 100 contracts at the ask (about $20K). Not an exchange-reported sweep.";
    const result = gradeSetup(setup({ printSummary: summary }));
    expect(result.verdict).toBe("TAKE");
    expect(result.reasons).toContain(summary);
    expect(result.reasons.length).toBeLessThanOrEqual(4);
    expect(result.reasons.join(" ").includes("exchange-reported sweep")).toBe(true);
    expect(result.reasons.join(" ").includes("Not an exchange-reported sweep")).toBe(true);
    const html = formatVerdictHtml(result);
    expect(html).toContain("Not an exchange-reported sweep.");
  });

  it("does not grade a short-dated or illiquid contract as A or B", () => {
    const shortDated = gradeSetup(excellent({
      dte: 7,
      expiration: "2026-05-21",
      levels: null,
      earnings: NO_EARNINGS_LISTED,
    }));
    expect(shortDated.verdict).toBe("WATCH");
    expect(shortDated.grade).not.toBe("A");
    expect(shortDated.grade).not.toBe("B");
    expect(shortDated.reasons.join(" ")).toMatch(/too short for an A or a B/i);

    const tooFar = gradeSetup(excellent({ dte: 50, expiration: "2026-07-03" }));
    expect(tooFar.verdict).not.toBe("TAKE");
    expect(tooFar.grade).not.toBe("A");
    expect(tooFar.grade).not.toBe("B");

    const thin = gradeSetup(excellent({ openInterest: MIN_OPEN_INTEREST - 1, volume: 50 }));
    expect(thin.verdict).toBe("SKIP");
    expect(thin.grade).toBe("D");
    expect(thin.liquidityPasses).toBe(false);
  });

  it("grades an exceptional quiet setup as an A", () => {
    const result = gradeSetup(excellent());
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("A");
    expect(result.uncappedGrade).toBe("A");
    expect(gradeARubric()).toMatch(/best setups of the day/);
    expect(gradeARubric()).toContain(`${ALERT_RULES.aGradeVolOiRatio}×`);
    expect(gradeARubric()).toContain("$100K");
    expect(gradeARubric()).toContain("$50K");
    expect(gradeARubric()).toContain(`$${ALERT_RULES.maxContractCost}`);
    expect(gradeARubric()).toContain(`${ALERT_RULES.alertDteMin} to ${ALERT_RULES.alertDteMax}`);
    expect(gradeARubric()).toMatch(/cannot be an A or a B/);
    expect(gradeARubric()).toMatch(/never shown when the levels or the earnings date are missing/i);
    expect(alertDeliveryNote()).toMatch(/Only an A or a B is sent/);
  });

  it("shows that same A on a Flow row, the Gate, and Telegram", () => {
    const input = excellent();
    const verdict = gradeSetup(input);
    const fromFlow = gradeFlowRow(flowFrom(input), input.consecutiveLosses, input.now);
    const fromGate = gradeContract({
      contract: contractFrom(input),
      underlyingPrice: input.underlyingPrice,
      delayed: input.delayed,
      now: input.now,
      consecutiveLosses: input.consecutiveLosses,
      volumeJump: input.volumeJump,
      levels: input.levels,
      earnings: input.earnings,
      definedRiskSpread: input.definedRiskSpread,
    });
    expect(verdict.grade).toBe("A");
    expect(fromFlow.grade).toBe(verdict.grade);
    expect(fromFlow.verdict).toBe(verdict.verdict);
    expect(fromGate.grade).toBe(verdict.grade);
    expect(fromGate.verdict).toBe(verdict.verdict);
    expect(formatVerdictHtml(verdict)).toContain("A · TAKE");
    const alert = formatFlowAlert({
      ticker: "NVDA",
      putCall: input.putCall,
      strike: input.strike,
      expiration: input.expiration,
      ask: input.ask,
      notionalPremium: input.notionalPremium,
      volume: input.volume,
      openInterest: input.openInterest,
      iv: null,
      side: input.side,
      otm: input.otm,
      volumeExceedsOi: true,
      volOiRatio: input.volOiRatio,
      verdict: fromFlow,
    });
    expect(alert).toContain("A · TAKE");
    expect(alert).toContain("flow premium");
    expect(alert).toContain("$608K");
    expect(alert).toContain("Ask $2.05 · $205 a contract");
    const alertId = "1727790000000-NVDA|2026-10-16|100|call";
    const linked = formatFlowAlert({
      ticker: "NVDA",
      putCall: input.putCall,
      strike: input.strike,
      expiration: input.expiration,
      ask: input.ask,
      notionalPremium: input.notionalPremium,
      volume: input.volume,
      openInterest: input.openInterest,
      iv: null,
      side: input.side,
      otm: input.otm,
      volumeExceedsOi: true,
      volOiRatio: input.volOiRatio,
      verdict: fromFlow,
      alertId,
    });
    expect(linked).toContain(">Paper trade</a>");
    expect(linked).toContain(encodeURIComponent(alertId));
    const unsaved = formatFlowAlert({
      ticker: "NVDA",
      putCall: input.putCall,
      strike: input.strike,
      expiration: input.expiration,
      ask: input.ask,
      notionalPremium: input.notionalPremium,
      volume: input.volume,
      openInterest: input.openInterest,
      iv: null,
      side: input.side,
      otm: input.otm,
      volumeExceedsOi: true,
      volOiRatio: input.volOiRatio,
      verdict: fromFlow,
      alertId,
      saved: false,
    });
    expect(unsaved).toContain("Not saved in the app");
    expect(unsaved.includes("Paper trade")).toBe(false);
  });

  it("keeps ordinary flow, a farther strike, and a macro day off A", () => {
    expect(gradeSetup(setup({ levels: levels() })).grade).toBe("B");
    const farther = gradeSetup(excellent({ otmFraction: 0.08 }));
    expect(farther.verdict).toBe("TAKE");
    expect(farther.grade).toBe("B");
    const dayBeforeJobs = gradeSetup(excellent({
      now: new Date("2026-06-04T15:00:00Z"),
      dte: 16,
      expiration: "2026-06-20",
    }));
    expect(dayBeforeJobs.verdict).toBe("TAKE");
    expect(dayBeforeJobs.grade).toBe("B");
    expect(dayBeforeJobs.uncappedGrade).toBe("B");
    expect(dayBeforeJobs.eventLine).toContain("Jobs report on 2026-06-05");
  });

  it("does not show an A when levels are missing or the hard skips fail", () => {
    const missingLevels = gradeSetup(excellent({ levels: null }));
    expect(missingLevels.uncappedGrade).toBe("A");
    expect(missingLevels.grade).toBe("B");
    const tight = gradeSetup(excellent({
      levels: levels({
        support: { price: 97, label: "prior day low", distance: 0.03 },
        resistance: { price: 100.1, label: "round number", distance: 0.001 },
      }),
    }));
    expect(tight.verdict).toBe("WATCH");
    expect(tight.grade).not.toBe("A");
    expect(gradeSetup(excellent({ openInterest: MIN_OPEN_INTEREST - 1 })).grade).toBe("D");
    expect(gradeSetup(excellent({ openInterest: MIN_OPEN_INTEREST - 1 })).verdict).toBe("SKIP");
    expect(gradeSetup(excellent({ bid: 4.9, ask: 5, mid: 4.95 })).verdict).toBe("TAKE");
    expect(gradeSetup(excellent({ bid: 4.9, ask: 5, mid: 4.95 })).grade).toBe("A");
    expect(gradeSetup(excellent({ delayed: true })).verdict).toBe("SKIP");
    expect(gradeSetup(excellent({ delayed: true })).grade).toBe("D");
    const stopped = gradeSetup(excellent({ consecutiveLosses: 2 }));
    expect(stopped.verdict).toBe("STOP");
    expect(stopped.verdictLabel).toBe("STOP for today");
    expect(stopped.grade).toBe("A");
  });

  it("withholds A and B when the ask is under $0.50 or one contract costs more than $875", () => {
    const cheap = gradeSetup(excellent({ bid: 0.39, ask: 0.4, mid: 0.395 }));
    expect(cheap.verdict).not.toBe("TAKE");
    expect(cheap.grade).not.toBe("A");
    expect(cheap.grade).not.toBe("B");
    expect(cheap.reasons.join(" ")).toMatch(/too cheap/i);

    const costly = gradeSetup(excellent({ bid: 8.8, ask: 9, mid: 8.9 }));
    expect(costly.verdict).not.toBe("TAKE");
    expect(costly.grade).not.toBe("A");
    expect(costly.grade).not.toBe("B");
    expect(costly.singleContractExceedsCap).toBe(true);
    expect(costly.reasons.join(" ")).toMatch(/\$875/);
    expect(costly.reasons.some((reason) => reason.includes(DEBIT_SPREAD_SUGGESTION))).toBe(true);
  });

  it("requires $100K of estimated flow premium for an A and $50K for a B", () => {
    const underB = gradeSetup(excellent({ notionalPremium: 49_999 }));
    expect(underB.verdict).not.toBe("TAKE");
    expect(underB.grade).not.toBe("A");
    expect(underB.grade).not.toBe("B");
    expect(underB.reasons.join(" ")).toMatch(/Flow premium/);

    const bOnly = gradeSetup(excellent({ notionalPremium: 75_000 }));
    expect(bOnly.verdict).toBe("TAKE");
    expect(bOnly.grade).toBe("B");
    expect(bOnly.reasons.join(" ")).toMatch(/\$100K/);

    const atA = gradeSetup(excellent({ notionalPremium: 100_000 }));
    expect(atA.verdict).toBe("TAKE");
    expect(atA.grade).toBe("A");

    const missing = gradeSetup(excellent({ notionalPremium: null }));
    expect(missing.grade).not.toBe("A");
    expect(missing.grade).not.toBe("B");
  });

  it("keeps the earnings reason and the quote print when both apply", () => {
    const summary = "Detected from Schwab quotes: block print, 100 contracts at the ask (about $20K). Not an exchange-reported sweep.";
    const result = gradeSetup(setup({
      levels: levels(),
      printSummary: summary,
      earnings: { status: "known", date: "2026-05-28", timing: "before-market", estimated: false },
    }));
    expect(result.reasons).toContain(IV_CRUSH_SENTENCE);
    expect(result.reasons).toContain(summary);
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
    expect(result.reasons.length).toBeLessThanOrEqual(4);
  });
});

function excellent(over: Partial<SetupInput> = {}): SetupInput {
  return setup({
    volume: 3000,
    openInterest: 1000,
    volOiRatio: 3,
    notionalPremium: 607_500,
    volumeJump: 400,
    side: "estimated at ask",
    otmFraction: 0.04,
    otm: true,
    dte: 21,
    expiration: "2026-06-04",
    levels: levels(),
    earnings: farEarnings(),
    ...over,
  });
}

function contractFrom(input: SetupInput): OptionContract {
  return {
    bid: input.bid,
    ask: input.ask,
    last: input.ask,
    volume: input.volume,
    openInterest: input.openInterest,
    delta: null,
    iv: null,
    strike: input.strike,
    expiration: input.expiration,
    putCall: input.putCall,
  };
}

function flowFrom(input: SetupInput): FlowRow {
  return {
    id: "NVDA|2026-10-12|104|call",
    ticker: "NVDA",
    putCall: input.putCall,
    strike: input.strike,
    expiration: input.expiration,
    bid: input.bid,
    ask: input.ask,
    last: input.ask,
    volume: input.volume,
    openInterest: input.openInterest,
    iv: null,
    delta: null,
    mid: input.mid,
    notionalPremium: input.notionalPremium,
    volOiRatio: input.volOiRatio,
    volumeOiJump: null,
    volumeExceedsOi: true,
    previousVolume: null,
    volumeJump: input.volumeJump,
    otmPoints: 4,
    otmFraction: input.otmFraction,
    otm: input.otm,
    dte: input.dte,
    spreadFraction: 0.025,
    spreadQuality: "acceptable",
    side: input.side,
    sideNote: "Estimated from the last price versus the bid and ask. Not a sweep print.",
    askFraction: 1,
    liquidityPasses: true,
    delayed: input.delayed,
    underlyingPrice: input.underlyingPrice,
    levels: input.levels,
    prints: EMPTY_PRINTS,
    earnings: input.earnings,
    score: 40,
  };
}

function farEarnings(): EarningsFact {
  return { status: "known", date: "2026-12-20", timing: "after-market", estimated: false };
}
