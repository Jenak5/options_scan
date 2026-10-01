import { describe, expect, it } from "vitest";
import { ALERT_RULES, EVENT_RULES } from "@/app/lib/alertConfig";
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
import { formatVerdictHtml } from "@/app/lib/telegram";
import { gradeSetup, type SetupInput } from "@/app/lib/verdict";

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
    dte: 7,
    delayed: false,
    strike: 104,
    expiration: "2026-10-08",
    putCall: "call",
    underlyingPrice: 100,
    consecutiveLosses: null,
    levels: null,
    earnings: { status: "known", date: "2026-12-20", timing: "after-market", estimated: false },
    definedRiskSpread: false,
    now: new Date("2026-10-05T15:00:00Z"),
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
  it("grades a liquid short-hold setup as TAKE and caps the letter at B without levels", () => {
    const result = gradeSetup(setup());
    expect(result.verdict).toBe("TAKE");
    expect(result.verdictLabel).toBe("TAKE");
    expect(result.uncappedGrade).toBe("A");
    expect(result.grade).toBe(ALERT_RULES.maxGradeUntilLevels);
    expect(result.grade).toBe("B");
    expect(result.levels).toBeNull();
    expect(result.liquidityPasses).toBe(true);
    expect(result.maxContracts).toBe(2);
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
    expect(result.grade).toBe("A");
    expect(result.levelsNote).toBeNull();
    expect(result.levels?.supportPrice).toBe(99);
    expect(result.levels?.resistancePrice).toBe(102);
    expect(result.reasons.some((reason) => /room for a call/i.test(reason))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("$99.00"))).toBe(true);
    const html = formatVerdictHtml(result);
    expect(html).toContain("A · TAKE");
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
    expect(result.grade).toBe("A");
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
      dte: 40,
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

  it("skips a single contract over the loss cap and names a debit spread", () => {
    const result = gradeSetup(setup({ bid: 4.9, ask: 5, mid: 4.95, volume: 200, openInterest: 800, volOiRatio: 0.25 }));
    expect(result.verdict).toBe("SKIP");
    expect(result.singleContractExceedsCap).toBe(true);
    expect(result.maxContracts).toBe(0);
    expect(result.suggestion).toBe(DEBIT_SPREAD_SUGGESTION);
    expect(result.reasons.some((reason) => reason.includes(DEBIT_SPREAD_SUGGESTION))).toBe(true);
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
    const result = gradeSetup(setup({ levels: levels() }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("A");
    expect(result.eventLine).toContain("Next earnings 2026-12-20 after the close.");
    expect(result.eventLine.includes(IV_CRUSH_SENTENCE)).toBe(false);
  });

  it("downgrades when earnings fall on or before expiration and names IV crush", () => {
    const result = gradeSetup(setup({
      levels: levels(),
      earnings: { status: "known", date: "2026-10-08", timing: "before-market", estimated: false },
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.uncappedGrade).toBe("B");
    expect(result.eventLine).toContain("Next earnings 2026-10-08 before the open.");
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
    expect(result.reasons.some((reason) => reason.includes(IV_CRUSH_SENTENCE))).toBe(true);
  });

  it("skips a short-dated single when earnings are today or tomorrow", () => {
    const today = "2026-10-05";
    const earningsDate = addCalendarDays(today, EVENT_RULES.imminentEarningsDays);
    const result = gradeSetup(setup({
      levels: levels(),
      dte: EVENT_RULES.shortDatedDteMax,
      expiration: "2026-10-20",
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
      expiration: "2026-10-08",
      definedRiskSpread: true,
      earnings: { status: "known", date: "2026-10-06", timing: "after-market", estimated: false },
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.eventLine.includes(EARNINGS_SKIP_SENTENCE)).toBe(false);
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
  });

  it("caps the grade at B and says earnings date unknown when the date is missing", () => {
    const result = gradeSetup(setup({ levels: levels(), earnings: UNKNOWN_EARNINGS }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe(EVENT_RULES.maxGradeUntilEarnings);
    expect(result.grade).toBe("B");
    expect(result.uncappedGrade).toBe("A");
    expect(result.eventLine.startsWith(EARNINGS_UNKNOWN_PHRASE)).toBe(true);
    expect(result.reasons.some((reason) => reason.includes(EARNINGS_UNKNOWN_PHRASE))).toBe(true);
  });

  it("does not cap a ticker that has no earnings calendar", () => {
    const result = gradeSetup(setup({ levels: levels(), earnings: NO_EARNINGS_LISTED }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("A");
    expect(result.eventLine).toContain("No earnings date listed");
    expect(result.eventLine.includes(EARNINGS_UNKNOWN_PHRASE)).toBe(false);
  });

  it("downgrades one step for a macro release on or before expiration", () => {
    const jobs = EVENT_RULES.macroDates.find((row) => row.date === "2026-10-02" && row.name === "Jobs report");
    expect(jobs).toBeTruthy();
    const result = gradeSetup(setup({
      levels: levels(),
      now: new Date("2026-10-02T15:00:00Z"),
      dte: 6,
      expiration: "2026-10-08",
      earnings: farEarnings(),
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("B");
    expect(result.eventLine).toContain("Jobs report on 2026-10-02");
    expect(result.eventLine).toContain(MACRO_CAUTION);
  });

  it("stacks the earnings downgrade and the macro downgrade", () => {
    const result = gradeSetup(setup({
      levels: levels(),
      now: new Date("2026-10-02T15:00:00Z"),
      dte: 6,
      expiration: "2026-10-08",
      earnings: { status: "known", date: "2026-10-07", timing: "after-market", estimated: false },
    }));
    expect(result.verdict).toBe("TAKE");
    expect(result.grade).toBe("C");
    expect(result.eventLine).toContain(IV_CRUSH_SENTENCE);
    expect(result.eventLine).toContain("Jobs report on 2026-10-02");
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
});

function farEarnings(): EarningsFact {
  return { status: "known", date: "2026-12-20", timing: "after-market", estimated: false };
}
