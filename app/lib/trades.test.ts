import { describe, expect, it } from "vitest";
import { DAILY_STOP_CONSECUTIVE_LOSSES, MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import {
  addTrade,
  buildTrade,
  closeTrade,
  dailyStopState,
  emptyTradeLog,
  parseTradeLog,
  summarizeTrades,
  tradeMetrics,
  tradesToCsv,
  weeklyFlagSentence,
  weeklySummary,
  type StoredTrade,
} from "@/app/lib/trades";

const NOW = new Date("2026-10-01T15:00:00Z");

function opened(over: Partial<StoredTrade> = {}): StoredTrade {
  const built = buildTrade({
    ticker: "spy",
    putCall: "call",
    strike: 670,
    expiration: "2026-10-08",
    contracts: 1,
    entryPrice: 2,
    alertId: "1727790000000-SPY|2026-10-08|670|call",
    alertVerdict: "TAKE",
    alertGrade: "B",
  }, "t_abcdef1234567890", NOW);
  if (!built.ok) throw new Error(built.error);
  return { ...built.trade, ...over };
}

describe("trade metrics", () => {
  it("computes dollar and percent P&L, hold time, and a cap breach", () => {
    const trade = opened({ contracts: 5, entryPrice: 2, closedAt: NOW.getTime() + 60 * 60_000, exitPrice: 2.6 });
    const metrics = tradeMetrics(trade);
    expect(metrics.pnlDollars).toBeCloseTo(300);
    expect(metrics.pnlFraction).toBeCloseTo(0.3);
    expect(metrics.result).toBe("win");
    expect(metrics.holdMinutes).toBe(60);
    expect(metrics.matchedAlert).toBe(true);
    expect(metrics.riskDollars).toBe(1000);
    expect(metrics.riskBreachesCap).toBe(true);
    expect(MAX_LOSS_DOLLARS).toBe(875);
  });

  it("calls a move inside one dollar flat, and a down close a loss", () => {
    expect(tradeMetrics(opened({ closedAt: NOW.getTime() + 1000, exitPrice: 2.004 })).result).toBe("flat");
    expect(tradeMetrics(opened({ closedAt: NOW.getTime() + 1000, exitPrice: 1.5 })).result).toBe("loss");
    expect(tradeMetrics(opened()).result).toBeNull();
  });
});

describe("daily stop from closed trades", () => {
  it("latches after two losses in a row and ignores a later win until the next Chicago day", () => {
    const first = closeAt(opened({ id: "t_loss000000000001" }), NOW.getTime(), 1.5);
    const second = closeAt(opened({ id: "t_loss000000000002" }), NOW.getTime() + 60_000, 1.4);
    const third = closeAt(opened({ id: "t_win0000000000001" }), NOW.getTime() + 120_000, 3);
    const open = opened({ id: "t_open000000000001" });
    const stopped = dailyStopState([first, open, second], NOW);
    expect(stopped.dailyStop).toBe(true);
    expect(stopped.consecutiveLosses).toBe(DAILY_STOP_CONSECUTIVE_LOSSES);

    const still = dailyStopState([first, second, third], NOW);
    expect(still.dailyStop).toBe(true);
    expect(still.consecutiveLosses).toBe(2);

    const nextDay = new Date("2026-10-02T15:00:00Z");
    expect(dailyStopState([first, second, third], nextDay).dailyStop).toBe(false);
    expect(dailyStopState([first, second, third], nextDay).consecutiveLosses).toBe(0);
  });

  it("does not stop when a flat or a win breaks the streak", () => {
    const loss = closeAt(opened({ id: "t_loss000000000001" }), NOW.getTime(), 1.5);
    const flat = closeAt(opened({ id: "t_flat000000000001" }), NOW.getTime() + 60_000, 2);
    const again = closeAt(opened({ id: "t_loss000000000002" }), NOW.getTime() + 120_000, 1.4);
    const state = dailyStopState([loss, flat, again], NOW);
    expect(state.dailyStop).toBe(false);
    expect(state.consecutiveLosses).toBe(1);
  });
});

describe("weekly flag and stats", () => {
  it("flags a week down about 25% and leaves a smaller week unmarked", () => {
    const heavy = closeAt(opened({ id: "t_loss000000000001", contracts: 2, entryPrice: 4 }), NOW.getTime(), 0.05);
    const light = closeAt(opened({ id: "t_loss000000000002", contracts: 1, entryPrice: 2 }), NOW.getTime(), 1);
    expect(weeklySummary([heavy], NOW).flagged).toBe(true);
    expect(weeklySummary([heavy], NOW).threshold).toBe(750);
    expect(weeklyFlagSentence(weeklySummary([heavy], NOW))).toMatch(/information only/i);
    expect(weeklySummary([light], NOW).flagged).toBe(false);
    expect(weeklyFlagSentence(weeklySummary([light], NOW))).toBeNull();
  });

  it("reports win rate, expectancy, and P&L by grade and checklist", () => {
    const win = closeAt(opened({ id: "t_win0000000000001", alertGrade: "A", alertVerdict: "TAKE" }), NOW.getTime(), 3);
    const loss = closeAt(opened({ id: "t_loss000000000001", alertGrade: "B", alertVerdict: "WATCH" }), NOW.getTime(), 1);
    const skip = closeAt(opened({ id: "t_skip000000000001", alertGrade: "C", alertVerdict: "SKIP" }), NOW.getTime(), 2.5);
    const stats = summarizeTrades([win, loss, skip], NOW);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBeCloseTo(2 / 3);
    expect(stats.averageWin).toBeCloseTo(75);
    expect(stats.averageLoss).toBeCloseTo(100);
    expect(stats.expectancy).toBeCloseTo((2 / 3) * 75 - (1 / 3) * 100);
    expect(stats.byGrade.find((row) => row.key === "A")?.pnlDollars).toBeCloseTo(100);
    expect(stats.byVerdict.find((row) => row.key === "WATCH")?.pnlDollars).toBeCloseTo(-100);
    expect(stats.byVerdict.find((row) => row.key === "SKIP")?.closed).toBe(1);
    expect(stats.sampleNote).toMatch(/small/i);
  });
});

describe("trade log parsing", () => {
  it("drops a bad row and escapes a note in the CSV", () => {
    const trade = closeAt(opened({ exitNote: 'said "out", then left' }), NOW.getTime() + 1000, 1.5);
    const raw = JSON.stringify({ version: 1, trades: [trade, { id: "nope" }] });
    const log = parseTradeLog(raw);
    expect(log.trades).toHaveLength(1);
    expect(log.trades[0].exitNote).toContain("out");
    const csv = tradesToCsv(log.trades);
    expect(csv).toContain('"said ""out"", then left"');
    expect(csv.split("\n")[0]).toContain("pnlDollars");
    const again = addTrade(emptyTradeLog(), opened());
    const closed = closeTrade(again, again.trades[0].id, { exitPrice: 1.5, exitNote: "target" }, new Date(NOW.getTime() + 60_000));
    expect(closed.ok).toBe(true);
  });
});

function closeAt(trade: StoredTrade, closedAt: number, exitPrice: number): StoredTrade {
  return { ...trade, closedAt, exitPrice };
}
