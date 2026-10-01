import { describe, expect, it } from "vitest";
import { arrangeFlowCards, type FlowCardOrder } from "@/app/components/flowArrange";

function row(over: Partial<FlowCardOrder> & Pick<FlowCardOrder, "id">): FlowCardOrder {
  return {
    ticker: "SPY",
    strike: 100,
    putCall: "call",
    notionalPremium: 10_000,
    volOiRatio: 1,
    verdict: { verdict: "WATCH", grade: "C" },
    ...over,
  };
}

describe("flow card order", () => {
  const rows = [
    row({ id: "skip", ticker: "ZZZ", notionalPremium: 9_000_000, volOiRatio: 20, verdict: { verdict: "SKIP", grade: "D" } }),
    row({ id: "watch", ticker: "AAA", notionalPremium: 50_000, volOiRatio: 0.4, verdict: { verdict: "WATCH", grade: "B" } }),
    row({ id: "take", ticker: "MMM", notionalPremium: 20_000, volOiRatio: 2, verdict: { verdict: "TAKE", grade: "A" } }),
    row({ id: "stop", ticker: "SPY", putCall: "put", notionalPremium: 80_000, volOiRatio: 3, verdict: { verdict: "STOP", grade: "B" } }),
  ];

  it("leads with TAKE and WATCH, and keeps STOP with TAKE", () => {
    const ordered = arrangeFlowCards(rows, { verdict: "all", right: "all", sort: "notional" });
    expect(ordered.map((item) => item.id)).toEqual(["stop", "take", "watch", "skip"]);
  });

  it("sorts by grade inside a verdict, then by notional", () => {
    const extra = row({ id: "take-b", ticker: "BBB", notionalPremium: 90_000, verdict: { verdict: "TAKE", grade: "B" } });
    const ordered = arrangeFlowCards(rows.concat(extra), { verdict: "all", right: "all", sort: "grade" });
    expect(ordered.map((item) => item.id).slice(0, 3)).toEqual(["take", "take-b", "stop"]);
  });

  it("filters to calls and to TAKE, including STOP", () => {
    expect(arrangeFlowCards(rows, { verdict: "TAKE", right: "all", sort: "grade" }).map((item) => item.id)).toEqual(["take", "stop"]);
    expect(arrangeFlowCards(rows, { verdict: "WATCH", right: "call", sort: "volOi" }).map((item) => item.id)).toEqual(["watch"]);
    expect(arrangeFlowCards(rows, { verdict: "all", right: "put", sort: "grade" }).map((item) => item.id)).toEqual(["stop"]);
  });
});
