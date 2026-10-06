import { describe, expect, it } from "vitest";
import { buildStoredAlert, emptyBook, parseAlertBook, type StoredAlert } from "@/app/lib/alertBook";
import type { FlowRow } from "@/app/lib/flow";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import {
  applyOpeningChecks,
  chainInterestFromContracts,
  withOpeningLabels,
} from "@/app/lib/openingCheck";
import type { AlertVerdict } from "@/app/lib/verdict";
import { emptyShadowBook, shadowFromAlert, summarizeShadows } from "@/app/lib/shadow";

const THURSDAY = new Date("2026-10-01T15:00:00Z");
const FRIDAY = new Date("2026-10-02T15:00:00Z");
const MONDAY = new Date("2026-10-05T15:00:00Z");

function verdict(): AlertVerdict {
  return {
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "A",
    uncappedGrade: "A",
    reasons: ["Liquidity passes."],
    note: "Rules checklist only.",
    levels: null,
    levelsNote: null,
    eventLine: "",
    maxContracts: 4,
    singleContractExceedsCap: false,
    suggestion: null,
    liquidityPasses: true,
    dailyStop: false,
  };
}

function row(): FlowRow {
  return {
    id: "SPY|2026-10-16|100|call",
    ticker: "SPY",
    putCall: "call",
    strike: 100,
    expiration: "2026-10-16",
    bid: 2,
    ask: 2.05,
    last: 2.05,
    volume: 800,
    openInterest: 1000,
    iv: 0.2,
    delta: 0.4,
    mid: 2.025,
    notionalPremium: 162_000,
    volOiRatio: 0.8,
    volumeOiJump: -200,
    volumeExceedsOi: false,
    previousVolume: null,
    volumeJump: null,
    otmPoints: 1,
    otmFraction: 0.01,
    otm: true,
    dte: 15,
    spreadFraction: 0.025,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "Estimate from the last price versus the bid and ask. Not a trade print and not a sweep.",
    askFraction: 1,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 99,
    levels: null,
    prints: EMPTY_PRINTS,
    score: 40,
  };
}

function bookWith(alert: StoredAlert) {
  return { ...emptyBook(), records: [alert] };
}

describe("next-day open interest", () => {
  it("stays pending until the next trading day, then reads only that day's chain", () => {
    const alert = buildStoredAlert(row(), verdict(), THURSDAY);
    const saved = parseAlertBook(JSON.stringify(bookWith(alert))).records[0];
    expect(saved.openingCheck?.status).toBe("pending");
    expect(saved.last).toBe(2.05);

    const sameDay = applyOpeningChecks(bookWith(saved), chainInterestFromContracts([{
      ticker: "SPY",
      contracts: [{ expiration: "2026-10-16", strike: 100, putCall: "call", openInterest: 1800 }],
    }]), THURSDAY);
    expect(sameDay.updated).toBe(0);
    expect(sameDay.book.records[0].openingCheck?.status).toBe("pending");

    const waiting = applyOpeningChecks(bookWith(saved), chainInterestFromContracts([]), FRIDAY);
    expect(waiting.updated).toBe(0);

    const opened = applyOpeningChecks(bookWith(saved), chainInterestFromContracts([{
      ticker: "spy",
      contracts: [{ expiration: "2026-10-16", strike: 100, putCall: "call", openInterest: 1500 }],
    }]), FRIDAY);
    expect(opened.updated).toBe(1);
    expect(opened.book.records[0].openingCheck?.status).toBe("opening");
    expect(opened.book.records[0].openingCheck?.nextOpenInterest).toBe(1500);
    expect(opened.book.records[0].features?.openingCheck).toBe("opening");

    const again = applyOpeningChecks(opened.book, chainInterestFromContracts([{
      ticker: "SPY",
      contracts: [{ expiration: "2026-10-16", strike: 100, putCall: "call", openInterest: 100 }],
    }]), FRIDAY);
    expect(again.updated).toBe(0);
    expect(again.book.records[0].openingCheck?.status).toBe("opening");
  });

  it("calls a flat or smaller rise likely closing, and does not use a later session", () => {
    const alert = buildStoredAlert(row(), verdict(), THURSDAY);
    const flat = applyOpeningChecks(bookWith(alert), chainInterestFromContracts([{
      ticker: "SPY",
      contracts: [{ expiration: "2026-10-16", strike: 100, putCall: "call", openInterest: 1000 }],
    }]), FRIDAY);
    expect(flat.book.records[0].openingCheck?.status).toBe("closing");

    const partial = applyOpeningChecks(bookWith(alert), chainInterestFromContracts([{
      ticker: "SPY",
      contracts: [{ expiration: "2026-10-16", strike: 100, putCall: "call", openInterest: 1100 }],
    }]), FRIDAY);
    expect(partial.book.records[0].openingCheck?.status).toBe("closing");

    const missed = applyOpeningChecks(bookWith(alert), chainInterestFromContracts([{
      ticker: "SPY",
      contracts: [{ expiration: "2026-10-16", strike: 100, putCall: "call", openInterest: 5000 }],
    }]), MONDAY);
    expect(missed.book.records[0].openingCheck?.status).toBe("missing");
    expect(missed.book.records[0].openingCheck?.nextOpenInterest).toBeNull();
  });

  it("says the contract was not in the chain when the ticker was scanned without it", () => {
    const alert = buildStoredAlert(row(), verdict(), THURSDAY);
    const gone = applyOpeningChecks(bookWith(alert), chainInterestFromContracts([{
      ticker: "SPY",
      contracts: [{ expiration: "2026-10-16", strike: 105, putCall: "call", openInterest: 900 }],
    }]), FRIDAY);
    expect(gone.book.records[0].openingCheck?.status).toBe("missing");
  });

  it("puts the label on the scorecard row and leaves an older alert unrecorded", () => {
    const alert = buildStoredAlert(row(), verdict(), THURSDAY);
    const checked = applyOpeningChecks(bookWith(alert), chainInterestFromContracts([{
      ticker: "SPY",
      contracts: [{ expiration: "2026-10-16", strike: 100, putCall: "call", openInterest: 1600 }],
    }]), FRIDAY).book.records[0];
    const shadow = shadowFromAlert(checked);
    if (!shadow) throw new Error("expected a shadow");
    const closed = { ...shadow, status: "closed" as const, closedAt: FRIDAY.getTime(), exitPrice: 3, pnlDollars: 97.5, exitReason: "profit" as const };
    const page = summarizeShadows([closed], new Set(), FRIDAY);
    const stamped = withOpeningLabels(page, [checked]);
    expect(stamped.rows[0].openingLabel).toBe("Opening confirmed");

    const older: StoredAlert = { ...checked, id: "old", openingCheck: null };
    const oldShadow = shadowFromAlert({ ...older, id: "old-shadow" });
    if (!oldShadow) throw new Error("expected an older shadow");
    const oldClosed = { ...oldShadow, id: "old-shadow", status: "closed" as const, closedAt: FRIDAY.getTime(), exitPrice: 1, pnlDollars: -100, exitReason: "stop" as const };
    const oldPage = withOpeningLabels(summarizeShadows([oldClosed], new Set(), FRIDAY), [older]);
    expect(oldPage.rows[0].openingLabel).toBeNull();
    expect(emptyShadowBook().records).toEqual([]);
  });
});
