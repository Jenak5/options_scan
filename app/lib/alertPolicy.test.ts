import { describe, expect, it } from "vitest";
import { ALERT_POLICY, alertsPerDayLimit } from "@/app/lib/alertConfig";
import {
  alertContractKey,
  alertSetupKey,
  chooseAlerts,
  indexSentAlerts,
  realertReasons,
  type AlertCandidate,
} from "@/app/lib/alertPolicy";
import type { FlowRow } from "@/app/lib/flow";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import type { AlertVerdict } from "@/app/lib/verdict";

function candidate(over: {
  id?: string;
  ticker?: string;
  putCall?: "call" | "put";
  expiration?: string;
  strike?: number;
  score?: number;
  grade?: "A" | "B" | "C" | "D";
  verdict?: "TAKE" | "WATCH" | "SKIP" | "STOP";
  liquidityPasses?: boolean;
  delayed?: boolean;
  premium?: number;
}): AlertCandidate {
  const ticker = over.ticker ?? "NVDA";
  const putCall = over.putCall ?? "call";
  const expiration = over.expiration ?? "2026-06-04";
  const strike = over.strike ?? 100;
  const id = over.id ?? `${ticker}|${expiration}|${strike}|${putCall}`;
  const grade = over.grade ?? "A";
  const verdictName = over.verdict ?? "TAKE";
  const row = {
    id,
    ticker,
    putCall,
    strike,
    expiration,
    score: over.score ?? 10,
    liquidityPasses: over.liquidityPasses ?? true,
    delayed: over.delayed ?? false,
    bid: 1,
    ask: 1.05,
    last: 1.04,
    volume: 500,
    openInterest: 800,
    iv: null,
    delta: null,
    mid: 1.025,
    notionalPremium: over.premium ?? 50_000,
    volOiRatio: 1,
    volumeOiJump: null,
    volumeExceedsOi: false,
    previousVolume: null,
    volumeJump: null,
    otmPoints: 1,
    otmFraction: 0.02,
    otm: true,
    dte: 21,
    spreadFraction: 0.02,
    spreadQuality: "tight",
    side: "estimated at ask",
    sideNote: "",
    askFraction: 1,
    underlyingPrice: 100,
    levels: null,
    prints: EMPTY_PRINTS,
  } as FlowRow;
  const verdict = {
    verdict: verdictName,
    verdictLabel: verdictName,
    grade,
    uncappedGrade: grade,
    reasons: [],
    note: "",
    levels: null,
    levelsNote: null,
    eventLine: "",
    maxContracts: 2,
    singleContractExceedsCap: false,
    suggestion: null,
    liquidityPasses: row.liquidityPasses,
    dailyStop: verdictName === "STOP",
  } as AlertVerdict;
  return { row, verdict };
}

describe("alert delivery", () => {
  it("sends A ahead of a higher-scored B and skips C, D, and STOP", () => {
    const picks = chooseAlerts({
      candidates: [
        candidate({ id: "b", ticker: "AAPL", grade: "B", score: 90 }),
        candidate({ id: "c", ticker: "MSFT", grade: "C", verdict: "WATCH", score: 100 }),
        candidate({ id: "stop", ticker: "AMD", grade: "A", verdict: "STOP", score: 80 }),
        candidate({ id: "a", ticker: "NVDA", grade: "A", score: 20 }),
        candidate({ id: "d", ticker: "TSLA", grade: "D", verdict: "SKIP", score: 70 }),
      ],
      alreadySentContractKeys: new Set(),
      alreadySentSetupKeys: new Set(),
      limit: 5,
    });
    expect(picks.map((item) => item.row.id)).toEqual(["a", "b"]);
  });

  it("stops at the daily room and keeps a different strike", () => {
    const higherStrike = candidate({ id: "nvda-110", ticker: "NVDA", strike: 110, score: 40, grade: "A" });
    const picks = chooseAlerts({
      candidates: [
        candidate({ id: "nvda-100", ticker: "NVDA", strike: 100, score: 50, grade: "B" }),
        higherStrike,
        candidate({ id: "nvda-put", ticker: "NVDA", putCall: "put", strike: 90, score: 30, grade: "B" }),
        candidate({ id: "spy", ticker: "SPY", score: 10, grade: "B" }),
      ],
      alreadySentContractKeys: new Set(),
      alreadySentSetupKeys: new Set(),
      limit: 2,
    });
    expect(picks.map((item) => item.row.id)).toEqual(["nvda-110", "nvda-100"]);
    expect(alertContractKey(picks[0].row)).not.toBe(alertContractKey(picks[1].row));
    expect(alertSetupKey(picks[0].row)).toBe(alertSetupKey(higherStrike.row));
  });

  it("skips a contract already saved today, including a differently formatted strike", () => {
    const indexed = indexSentAlerts([
      {
        tradingDay: "2026-05-14",
        contractKey: "NVDA|2026-06-04|100|call",
        ticker: "NVDA",
        putCall: "call",
        expiration: "2026-06-04",
        strike: 100,
        grade: "B",
        alertedPremium: 200_000,
      },
    ], "2026-05-14");
    expect(indexed.count).toBe(1);
    const picks = chooseAlerts({
      candidates: [
        candidate({ id: "NVDA|2026-06-04|100.0|call", ticker: "NVDA", strike: 100, grade: "B", premium: 200_000 }),
        candidate({ id: "NVDA|2026-06-04|105|call", ticker: "NVDA", strike: 105, grade: "A" }),
        candidate({ id: "QQQ|2026-06-04|400|call", ticker: "QQQ", strike: 400, grade: "B" }),
      ],
      alreadySentContractKeys: indexed.contracts,
      alreadySentSetupKeys: indexed.setups,
      sentByContract: indexed.byContract,
      limit: 5,
    });
    expect(picks.map((item) => item.row.strike)).toEqual([105, 400]);
  });

  it("queues a re-alert only when the grade rises or premium doubles and adds $100K", () => {
    const indexed = indexSentAlerts([
      {
        tradingDay: "2026-05-14",
        contractKey: "NFLX|2026-11-20|64|call",
        ticker: "NFLX",
        putCall: "call",
        expiration: "2026-11-20",
        strike: 64,
        grade: "B",
        alertedPremium: 265_000,
        sentAt: 1,
      },
    ], "2026-05-14");
    const upgrade = candidate({
      id: "NFLX|2026-11-20|64|call",
      ticker: "NFLX",
      strike: 64,
      expiration: "2026-11-20",
      grade: "A",
      premium: 265_000,
    });
    expect(realertReasons(
      { grade: "B", premium: 265_000 },
      { grade: "A", premium: 265_000 },
    )).toEqual(["Upgraded B→A"]);
    expect(realertReasons(
      { grade: "B", premium: 265_000 },
      { grade: "B", premium: 610_000 },
    )).toEqual(["Flow grew $265K→$610K"]);
    expect(realertReasons(
      { grade: "B", premium: 40_000 },
      { grade: "B", premium: 80_000 },
    )).toEqual([]);
    expect(realertReasons(
      { grade: "B", premium: 200_000 },
      { grade: "B", premium: 310_000 },
    )).toEqual([]);
    const picks = chooseAlerts({
      candidates: [upgrade],
      alreadySentContractKeys: indexed.contracts,
      alreadySentSetupKeys: indexed.setups,
      sentByContract: indexed.byContract,
      limit: 5,
    });
    expect(picks.map((item) => item.row.ticker)).toEqual(["NFLX"]);
  });

  it("reads the daily cap from the environment and falls back when it is unset or nonsense", () => {
    expect(alertsPerDayLimit(undefined)).toBe(ALERT_POLICY.maxPerDay);
    expect(alertsPerDayLimit("")).toBe(5);
    expect(alertsPerDayLimit("3")).toBe(3);
    expect(alertsPerDayLimit("0")).toBe(5);
    expect(alertsPerDayLimit("100")).toBe(5);
    expect(alertsPerDayLimit("nope")).toBe(5);
  });

  it("does not alert an illiquid row even if the letter says A", () => {
    const picks = chooseAlerts({
      candidates: [candidate({ grade: "A", liquidityPasses: false })],
      alreadySentContractKeys: new Set(),
      alreadySentSetupKeys: new Set(),
      limit: 5,
    });
    expect(picks).toEqual([]);
  });
});
