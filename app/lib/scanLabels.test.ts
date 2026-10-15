import { describe, expect, it } from "vitest";
import { ALERT_POLICY, TRADE_RULES } from "@/app/lib/alertConfig";
import { chooseAlerts, type AlertCandidate } from "@/app/lib/alertPolicy";
import { arrangeFlowCards } from "@/app/components/flowArrange";
import { formatFlowAlert } from "@/app/lib/telegram";
import {
  alertLabels,
  big3mFirst,
  check60,
  flowRowLabels,
  inWeakWindow,
  isBig3m,
  isRepeatAlert,
  suggestedExitText,
  tickerSentToday,
} from "@/app/lib/scanLabels";

const CT = (h: number, m: number) => Date.parse(`2026-10-14T${String(h + 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);

function h1(at: number | null, underlying: number | null, status = "quoted") {
  return { h1: { at, underlying, status } };
}

function alert(over: Record<string, unknown> = {}) {
  return {
    id: "x1",
    ticker: "SPY",
    tradingDay: "2026-10-14",
    sentAt: CT(9, 0),
    putCall: "call" as const,
    underlyingPrice: 100,
    volume: 10_000,
    mid: 4,
    features: { flowPremium: 4_000_000, trendAlignment: "with" },
    checkpoints: h1(CT(10, 5), 99.6),
    ...over,
  };
}

describe("scan labels", () => {
  it("flags $3M+ flow, the 11:00-11:59 CT window and ticker trend", () => {
    expect(isBig3m(3_000_000)).toBe(true);
    expect(isBig3m(2_999_999)).toBe(false);
    expect(isBig3m(null)).toBe(false);
    expect(inWeakWindow(CT(10, 59))).toBe(false);
    expect(inWeakWindow(CT(11, 0))).toBe(true);
    expect(inWeakWindow(CT(11, 59))).toBe(true);
    expect(inWeakWindow(CT(12, 0))).toBe(false);
    expect(flowRowLabels({ notionalPremium: 5e6, context: { trendAlignment: "with" } }, CT(11, 30)))
      .toEqual(["$3M+ flow", "weak window", "with ticker trend"]);
    expect(flowRowLabels({ notionalPremium: 1e6, context: { trendAlignment: "against" } }, CT(9, 30))).toEqual([]);
  });

  it("labels a second alert on the same ticker that day as repeat", () => {
    const first = alert();
    const second = alert({ id: "x2", sentAt: CT(9, 30) });
    const other = alert({ id: "x3", ticker: "QQQ", sentAt: CT(9, 45) });
    const all = [first, second, other];
    expect(isRepeatAlert(first, all)).toBe(false);
    expect(isRepeatAlert(second, all)).toBe(true);
    expect(isRepeatAlert(other, all)).toBe(false);
    expect(tickerSentToday(all, "SPY", "2026-10-14")).toBe(true);
    expect(tickerSentToday(all, "SPY", "2026-10-15")).toBe(false);
  });

  it("60-minute check: cut when the stock is 0.3% or more against the trade", () => {
    expect(check60(alert()).status).toBe("cut"); // call, stock -0.4%
    expect(check60(alert({ checkpoints: h1(CT(10, 5), 99.8) })).status).toBe("ok"); // -0.2%
    expect(check60(alert({ putCall: "put" })).status).toBe("ok"); // put, stock down is with the trade
    expect(check60(alert({ putCall: "put", checkpoints: h1(CT(10, 5), 100.3) })).status).toBe("cut");
    expect(check60(alert({ checkpoints: h1(null, null, "pending") })).status).toBe("pending");
    expect(check60(alert({ underlyingPrice: null })).status).toBe("unknown");
    expect(check60(alert({ checkpoints: h1(CT(11, 0), 99) })).status).toBe("unknown"); // 120 min, too late
    expect(alertLabels(alert(), [alert()])).toEqual(["$3M+ flow", "with ticker trend", "cut"]);
  });

  it("suggested exit is a label: -30% stop, no target, trail 15% after +20%", () => {
    expect(suggestedExitText(2)).toBe(
      "Suggested exit (label only, not the live exit): stop $1.40 (-30%), no fixed target; once it reaches $2.40 (+20%), sell if it falls 15% below its best price.",
    );
    expect(suggestedExitText(0)).toBeNull();
  });

  it("sorts $3M+ rows to the top of their verdict group in the Flow display only", () => {
    const rows = [
      { id: "a", ticker: "A", strike: 1, putCall: "call" as const, notionalPremium: 500_000, volOiRatio: 1, verdict: { verdict: "TAKE" as const, grade: "A" } },
      { id: "b", ticker: "B", strike: 1, putCall: "call" as const, notionalPremium: 4_000_000, volOiRatio: 1, verdict: { verdict: "WATCH" as const, grade: "C" } },
      { id: "c", ticker: "C", strike: 1, putCall: "call" as const, notionalPremium: 3_500_000, volOiRatio: 1, verdict: { verdict: "TAKE" as const, grade: "B" } },
    ];
    const copy = rows.slice();
    expect(arrangeFlowCards(rows, { verdict: "all", right: "all", sort: "grade" }).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(rows).toEqual(copy);
    expect(big3mFirst(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("live behavior is unchanged", () => {
  it("keeps live exits, the daily cap and alert selection", () => {
    expect(TRADE_RULES.profitTargetFraction).toBe(0.40);
    expect(TRADE_RULES.stopLossFraction).toBe(0.25);
    expect(TRADE_RULES.flatAfterTradingDays).toBe(3);
    expect(ALERT_POLICY.maxPerDay).toBe(5);
    const cand = (id: string, grade: "A" | "B", premium: number, score: number) => ({
      row: { id, ticker: id, putCall: "call", strike: 1, expiration: "2026-11-20", score, notionalPremium: premium, liquidityPasses: true, delayed: false },
      verdict: { verdict: "TAKE", grade, maxContracts: 1 },
    }) as unknown as AlertCandidate;
    const candidates = [cand("S1", "A", 500_000, 9), cand("B3", "B", 5_000_000, 20), cand("S2", "A", 800_000, 5)];
    const before = chooseAlerts({ candidates, alreadySentContractKeys: new Set(), alreadySentSetupKeys: new Set(), limit: 2 }).map((c) => c.row.id);
    arrangeFlowCards(candidates.map((c) => ({ ...c.row, volOiRatio: 1, verdict: c.verdict })), { verdict: "all", right: "all", sort: "grade" });
    const after = chooseAlerts({ candidates, alreadySentContractKeys: new Set(), alreadySentSetupKeys: new Set(), limit: 2 }).map((c) => c.row.id);
    expect(after).toEqual(before);
    // A before B still wins; $3M+ flow does not jump the queue.
    expect(after).toEqual(["S1", "S2"]);
  });

  it("Telegram text is unchanged when no labels are passed; labels only add lines", () => {
    const base = {
      ticker: "NVDA", putCall: "call" as const, strike: 100, expiration: "2026-11-20", ask: 2,
      notionalPremium: 4_000_000, volume: 1000, openInterest: 500, iv: null, side: "estimated at ask",
      otm: true, volumeExceedsOi: true, volOiRatio: 2,
    };
    const plain = formatFlowAlert(base);
    expect(plain).not.toContain("🔖");
    expect(plain).not.toContain("Suggested exit");
    const labeled = formatFlowAlert({ ...base, labels: ["$3M+ flow", "repeat"] });
    expect(labeled).toContain("🔖 $3M+ flow · repeat");
    expect(labeled).toContain("Suggested exit (label only");
    const stripTime = (s: string) => s.split("\n").filter((l) => !l.startsWith("⏰") && !l.startsWith("🔖") && !l.startsWith("Suggested exit")).join("\n");
    expect(stripTime(labeled)).toBe(stripTime(plain));
  });
});
