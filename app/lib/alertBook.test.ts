import { describe, expect, it } from "vitest";
import { OUTCOME_RULES } from "@/app/lib/alertConfig";
import {
  addRecord,
  advanceAlert,
  dueCheckpointNames,
  emptyBook,
  emptyCheckpoint,
  gradeOutcome,
  lossCountForDay,
  parseAlertBook,
  summarizeAlerts,
  withDailyLoss,
  type StoredAlert,
} from "@/app/lib/alertBook";

const SENT = new Date("2026-10-01T15:00:00Z");

function alert(over: Partial<StoredAlert> = {}): StoredAlert {
  const base: StoredAlert = {
    id: "1",
    contractKey: "SPY|2026-10-08|105|call",
    sentAt: SENT.getTime(),
    tradingDay: "2026-10-01",
    ticker: "SPY",
    putCall: "call",
    strike: 105,
    expiration: "2026-10-08",
    bid: 2,
    ask: 2.05,
    mid: 2,
    underlyingPrice: 100,
    volume: 400,
    openInterest: 800,
    flowScore: 40,
    liquidityPasses: true,
    side: "estimated at ask",
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "B",
    reasons: ["Liquidity passes.", "Two contracts fit."],
    note: "Rules checklist only.",
    levels: null,
    levelsNote: "Support and resistance were not available, so the grade stops at B.",
    eventLine: "Next earnings 2026-11-15 after the close.",
    maxContracts: 2,
    checkpoints: {
      m15: emptyCheckpoint(),
      h1: emptyCheckpoint(),
      close: emptyCheckpoint(),
    },
    outcome: "pending",
  };
  return {
    ...base,
    ...over,
    checkpoints: { ...base.checkpoints, ...over.checkpoints },
  };
}

describe("midpoint outcome", () => {
  it("wins when any checkpoint mid is up by the threshold, including exactly 20%", () => {
    const at = new Date(SENT.getTime() + OUTCOME_RULES.checkpoint15MinMs);
    const won = advanceAlert(alert(), at, { mid: 2 * (1 + OUTCOME_RULES.winMidChange), underlying: 101 });
    expect(won.checkpoints.m15.status).toBe("quoted");
    expect(won.checkpoints.m15.midChangePct).toBeCloseTo(OUTCOME_RULES.winMidChange);
    expect(won.checkpoints.m15.underlying).toBe(101);
    expect(won.checkpoints.h1.status).toBe("pending");
    expect(gradeOutcome(won)).toBe("win");

    const shy = advanceAlert(alert(), at, { mid: 2 * (1 + OUTCOME_RULES.winMidChange - 0.001), underlying: 101 });
    expect(gradeOutcome(shy)).toBe("pending");
  });

  it("keeps the win if the close mid is later down hard", () => {
    const hour = new Date(SENT.getTime() + OUTCOME_RULES.checkpoint1HourMs);
    const close = new Date("2026-10-01T20:00:00Z");
    let row = advanceAlert(alert(), hour, { mid: 2.5, underlying: 102 });
    expect(row.outcome).toBe("win");
    row = advanceAlert(row, close, { mid: 1, underlying: 90 });
    expect(row.checkpoints.close.midChangePct).toBeCloseTo(-0.5);
    expect(row.outcome).toBe("win");
  });

  it("misses only when the close is down by the threshold and nothing earlier won", () => {
    const close = new Date("2026-10-01T20:05:00Z");
    const row = advanceAlert(alert({ sentAt: new Date("2026-10-01T19:00:00Z").getTime() }), close, {
      mid: 2 * (1 + OUTCOME_RULES.missMidChange),
      underlying: 98,
    });
    expect(row.checkpoints.close.status).toBe("quoted");
    expect(row.outcome).toBe("miss");

    const flat = advanceAlert(alert({ sentAt: new Date("2026-10-01T19:00:00Z").getTime() }), close, {
      mid: 1.9,
      underlying: 99,
    });
    expect(flat.outcome).toBe("flat");
  });

  it("marks a missing quote or an expired contract without calling it a miss", () => {
    const close = new Date("2026-10-01T20:00:00Z");
    const quiet = advanceAlert(alert({ sentAt: new Date("2026-10-01T19:50:00Z").getTime() }), close, {
      mid: null,
      underlying: 100,
    });
    expect(dueCheckpointNames(alert({ sentAt: new Date("2026-10-01T19:50:00Z").getTime() }), close)).toEqual(["close"]);
    expect(quiet.checkpoints.close.status).toBe("no_quote");
    expect(quiet.checkpoints.close.underlying).toBe(100);
    expect(quiet.outcome).toBe("unscored");

    const expired = advanceAlert(alert({ expiration: "2026-09-30" }), SENT, { mid: 3, underlying: 100 });
    expect(expired.checkpoints.m15.status).toBe("expired");
    expect(expired.checkpoints.close.status).toBe("expired");
    expect(expired.checkpoints.m15.mid).toBeNull();
    expect(expired.outcome).toBe("unscored");
  });

  it("does not write a next-day quote into yesterday's checkpoints", () => {
    const nextDay = new Date("2026-10-02T15:00:00Z");
    const row = advanceAlert(alert(), nextDay, { mid: 9, underlying: 200 });
    expect(row.checkpoints.close.status).toBe("missed");
    expect(row.checkpoints.m15.mid).toBeNull();
    expect(row.outcome).toBe("unscored");
  });

  it("summarizes hit rate, average moves, ticker, liquidity, and TAKE versus SKIP", () => {
    const take = advanceAlert(alert({ id: "take", verdict: "TAKE", ticker: "SPY" }), new Date(SENT.getTime() + 60 * 60 * 1000), {
      mid: 2.6,
      underlying: 103,
    });
    const closedTake = advanceAlert(take, new Date("2026-10-01T20:00:00Z"), { mid: 1.4, underlying: 95 });
    const skip = advanceAlert(alert({
      id: "skip",
      contractKey: "QQQ|2026-10-08|500|put",
      verdict: "SKIP",
      verdictLabel: "SKIP",
      grade: "D",
      ticker: "QQQ",
      putCall: "put",
      liquidityPasses: false,
      sentAt: new Date("2026-10-01T18:00:00Z").getTime(),
    }), new Date("2026-10-01T20:10:00Z"), { mid: 1.4, underlying: 490 });

    const summary = summarizeAlerts([closedTake, skip]);
    expect(summary.graded).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.misses).toBe(1);
    expect(summary.hitRate).toBeCloseTo(0.5);
    expect(summary.avgClosePct).toBeCloseTo((-0.3 + -0.3) / 2);
    expect(summary.byTicker.map((row) => row.label).sort()).toEqual(["QQQ", "SPY"]);
    expect(summary.byLiquidity).toHaveLength(2);
    const takeRow = summary.byVerdict.find((row) => row.verdict === "TAKE");
    const skipRow = summary.byVerdict.find((row) => row.verdict === "SKIP");
    expect(takeRow?.hitRate).toBe(1);
    expect(skipRow?.hitRate).toBe(0);
    expect(takeRow?.avgClosePct).toBeCloseTo(-0.3);
  });
});

describe("alert book parsing", () => {
  it("drops a corrupt record, keeps a valid one, and ignores yesterday's loss count", () => {
    const book = withDailyLoss(addRecord(emptyBook(), alert()), "2026-10-01", 2);
    const text = JSON.stringify(book);
    const parsed = JSON.parse(text) as { records: unknown[] };
    parsed.records.unshift({ id: "junk" });
    const again = parseAlertBook(JSON.stringify(parsed));
    expect(again.records).toHaveLength(1);
    expect(again.records[0].ticker).toBe("SPY");
    expect(again.records[0].outcome).toBe("pending");
    expect(lossCountForDay(again, "2026-10-01")).toBe(2);
    expect(lossCountForDay(again, "2026-10-02")).toBeNull();
    expect(parseAlertBook("not json").records).toEqual([]);
    expect(again.records[0].levels).toBeNull();
    expect(again.records[0].eventLine).toContain("2026-11-15");
  });

  it("keeps an older alert that has no event line", () => {
    const raw = JSON.parse(JSON.stringify(addRecord(emptyBook(), alert()))) as { records: Record<string, unknown>[] };
    delete raw.records[0].eventLine;
    const parsed = parseAlertBook(JSON.stringify(raw));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].eventLine).toBeNull();
    expect(parsed.records[0].grade).toBe("B");
  });

  it("keeps stored support and resistance and ignores a record that never had them", () => {
    const withLevels = alert({
      id: "leveled",
      levels: {
        supportPrice: 99,
        supportLabel: "prior day low",
        supportDistance: 0.01,
        resistancePrice: 102,
        resistanceLabel: "session high",
        resistanceDistance: 0.02,
      },
    });
    const raw = JSON.parse(JSON.stringify(addRecord(emptyBook(), withLevels))) as { records: Record<string, unknown>[] };
    delete raw.records[0].levels;
    raw.records.push(JSON.parse(JSON.stringify(withLevels)));
    const parsed = parseAlertBook(JSON.stringify(raw));
    expect(parsed.records[0].levels).toBeNull();
    expect(parsed.records[1].levels?.supportPrice).toBe(99);
    expect(parsed.records[1].levels?.resistanceLabel).toBe("session high");
  });

  it("keeps only the newest records when the book is over the cap", () => {
    let book = emptyBook();
    book = addRecord(book, alert({ id: "a" }), 2);
    book = addRecord(book, alert({ id: "b" }), 2);
    book = addRecord(book, alert({ id: "c" }), 2);
    expect(book.records.map((row) => row.id)).toEqual(["b", "c"]);
  });
});
