import { describe, expect, it, vi } from "vitest";
import type { OptionContract } from "@/app/lib/contract";
import {
  DEFAULT_FLOW_WATCHLIST,
  FLOW_DISCLAIMER,
  FLOW_MAX_EXPIRATIONS,
  estimateSide,
  filterFlowRows,
  flowChainRequest,
  flowContractKey,
  gateCheckHref,
  keepNearestExpirations,
  liquidityOf,
  notionalPremium,
  parseWatchlist,
  scoreChain,
  selectAlertRows,
  snapshotFromRows,
  volumeOiJump,
  volumeOiRatio,
  volumeSinceLastScan,
  type FlowRow,
} from "@/app/lib/flow";
import { parseOptionChain } from "@/app/lib/schwabParse";

const NOW = new Date("2026-10-01T15:00:00Z");

function contract(over: Partial<OptionContract> = {}): OptionContract {
  return {
    bid: 2,
    ask: 2.1,
    last: 2.08,
    volume: 400,
    openInterest: 800,
    delta: 0.4,
    iv: 0.25,
    strike: 105,
    expiration: "2026-10-08",
    putCall: "call",
    ...over,
  };
}

function chainPayload(extra: Record<string, unknown> = {}) {
  return {
    underlying: { last: 100 },
    isDelayed: false,
    callExpDateMap: {
      "2026-09-25:0": {
        "105.0": [quote({ expirationHint: "2026-09-25", totalVolume: 900, openInterest: 900 })],
      },
      "2026-10-02:1": {
        "105.0": [quote({ totalVolume: 200, openInterest: 600 })],
      },
      "2026-10-03:2": {
        "105.0": [quote({ totalVolume: 150, openInterest: 600 })],
      },
      "2026-10-08:7": {
        "105.0": [quote({
          bid: 2,
          ask: 2.1,
          last: 2.08,
          totalVolume: 400,
          openInterest: 800,
          volatility: 25,
          delta: 0.4,
        })],
      },
      "2026-10-15:14": {
        "105.0": [quote({ totalVolume: 120, openInterest: 700 })],
      },
      "2026-10-22:21": {
        "105.0": [quote({ totalVolume: 5000, openInterest: 9000 })],
      },
    },
    putExpDateMap: {
      "2026-10-08:7": {
        "95.0": [quote({
          putCall: "PUT",
          strikePrice: 95,
          bid: 1.9,
          ask: 2,
          last: 1.92,
          totalVolume: 250,
          openInterest: 1000,
          volatility: 22,
        })],
      },
    },
    ...extra,
  };
}

function quote(over: Record<string, unknown> = {}) {
  return {
    putCall: "CALL",
    bid: 1,
    ask: 1.02,
    last: 1.01,
    totalVolume: 100,
    openInterest: 500,
    volatility: 20,
    strikePrice: 105,
    delta: 0.3,
    ...over,
  };
}

describe("estimated flow scoring", () => {
  it("does not call the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network");
    });
    const parsed = parseOptionChain(chainPayload());
    scoreChain({
      ticker: "SPY",
      contracts: parsed.contracts,
      underlyingPrice: parsed.underlyingPrice,
      delayed: parsed.delayed,
      previous: null,
      now: NOW,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("scores a fixture chain: notional, side, OTM distance, DTE, and volume versus OI", () => {
    const parsed = parseOptionChain(chainPayload());
    const previous = {
      scannedAt: new Date("2026-10-01T14:00:00Z").getTime(),
      volumes: { "2026-10-08|105|call": 250 },
    };
    const rows = scoreChain({
      ticker: "SPY",
      contracts: parsed.contracts,
      underlyingPrice: parsed.underlyingPrice,
      delayed: parsed.delayed,
      previous,
      now: NOW,
    });

    const call = rows.find((row) => row.expiration === "2026-10-08" && row.putCall === "call");
    expect(call).toBeTruthy();
    if (!call) return;
    expect(call.mid).toBeCloseTo(2.05, 10);
    expect(call.notionalPremium).toBeCloseTo(400 * 2.05 * 100, 6);
    expect(call.volOiRatio).toBeCloseTo(0.5, 10);
    expect(call.volumeOiJump).toBe(-400);
    expect(call.volumeExceedsOi).toBe(false);
    expect(call.previousVolume).toBe(250);
    expect(call.volumeJump).toBe(150);
    expect(call.otm).toBe(true);
    expect(call.otmPoints).toBe(5);
    expect(call.otmFraction).toBeCloseTo(0.05, 10);
    expect(call.dte).toBe(7);
    expect(call.side).toBe("estimated at ask");
    expect(call.sideNote).toMatch(/not a sweep/i);
    expect(call.spreadQuality).toBe("acceptable");
    expect(call.liquidityPasses).toBe(true);
    expect(call.iv).toBeCloseTo(0.25, 10);
    expect(call.score).toBeGreaterThan(0);
    expect(FLOW_DISCLAIMER).toMatch(/not true sweeps/i);
  });

  it("keeps only the nearest four expirations and drops expired contracts", () => {
    const parsed = parseOptionChain(chainPayload());
    const dates = new Set(parsed.contracts.map((row) => row.expiration));
    expect(dates.has("2026-09-25")).toBe(true);
    expect(dates.has("2026-10-22")).toBe(true);
    const rows = scoreChain({
      ticker: "SPY",
      contracts: parsed.contracts,
      underlyingPrice: parsed.underlyingPrice,
      delayed: false,
      previous: null,
      now: NOW,
    });
    const kept = Array.from(new Set(rows.map((row) => row.expiration))).sort();
    expect(kept).toEqual(["2026-10-02", "2026-10-03", "2026-10-08", "2026-10-15"]);
    expect(kept).toHaveLength(FLOW_MAX_EXPIRATIONS);
    expect(rows.some((row) => row.expiration === "2026-09-25")).toBe(false);
    expect(rows.some((row) => row.expiration === "2026-10-22")).toBe(false);
  });

  it("ignores a volume snapshot from a prior New York session", () => {
    const jump = volumeSinceLastScan(400, {
      scannedAt: new Date("2026-09-30T15:00:00Z").getTime(),
      volumes: { "2026-10-08|105|call": 10 },
    }, "2026-10-08|105|call", NOW);
    expect(jump).toEqual({ previousVolume: null, volumeJump: null });
  });

  it("labels side from last versus the bid and ask", () => {
    expect(estimateSide(1, 2, 1.65).label).toBe("estimated at ask");
    expect(estimateSide(1, 2, 1.649).label).toBe("estimated mid");
    expect(estimateSide(1, 2, 1.35).label).toBe("estimated at bid");
    expect(estimateSide(1, 2, 1.351).label).toBe("estimated mid");
    expect(estimateSide(1, 2, 2.4).label).toBe("estimated at ask");
    expect(estimateSide(1, 2, 0.2).label).toBe("estimated at bid");
    expect(estimateSide(2, 1, 1.5).label).toBe("estimated unknown");
    expect(estimateSide(Number.NaN, 1, 1).label).toBe("estimated unknown");
  });

  it("prices notional as volume times mid times 100", () => {
    expect(notionalPremium(10, 1.5)).toBe(1500);
    expect(notionalPremium(10, 0)).toBeNull();
    expect(notionalPremium(Number.NaN, 1)).toBeNull();
    expect(volumeOiRatio(250, 100)).toBe(2.5);
    expect(volumeOiRatio(10, 0)).toBeNull();
    expect(volumeOiJump(250, 100)).toBe(150);
  });

  it("uses the gate liquidity bars and hides failures by default", () => {
    const liquid = liquidityOf(contract());
    expect(liquid.passes).toBe(true);
    expect(liquidityOf(contract({ openInterest: 499 })).passes).toBe(false);
    expect(liquidityOf(contract({ openInterest: 500, volume: 100, bid: 1.95, ask: 2.05 })).passes).toBe(true);
    expect(liquidityOf(contract({ volume: 99 })).passes).toBe(false);
    expect(liquidityOf(contract({ bid: 1.95, ask: 2.06 })).passes).toBe(false);

    const rows = scoreChain({
      ticker: "AMD",
      contracts: [
        contract({ openInterest: 100, volume: 50, bid: 1, ask: 1.4 }),
        contract({ strike: 110 }),
      ],
      underlyingPrice: 100,
      delayed: false,
      previous: null,
      now: NOW,
    });
    expect(rows).toHaveLength(2);
    const visible = filterFlowRows(rows, { minPremium: 0, otmOnly: false, liquidOnly: true, limit: 20 });
    expect(visible.every((row) => row.liquidityPasses)).toBe(true);
    expect(visible.some((row) => row.openInterest === 100)).toBe(false);
  });

  it("does not alert on a fat premium that fails the liquidity filters", () => {
    const wide = scoreChain({
      ticker: "COIN",
      contracts: [contract({ bid: 1, ask: 1.5, last: 1.45, volume: 5000, openInterest: 8000 })],
      underlyingPrice: 100,
      delayed: false,
      previous: null,
      now: NOW,
    });
    expect(wide[0].notionalPremium).toBeGreaterThan(100_000);
    expect(wide[0].liquidityPasses).toBe(false);
    expect(selectAlertRows(wide, { minPremium: 100_000, otmOnly: false, limit: 10 })).toEqual([]);

    const tight = scoreChain({
      ticker: "COIN",
      contracts: [contract()],
      underlyingPrice: 100,
      delayed: false,
      previous: null,
      now: NOW,
    });
    expect(selectAlertRows(tight, { minPremium: 50_000, otmOnly: true, limit: 10 })).toHaveLength(1);
    expect(selectAlertRows(tight, { minPremium: 50_000, otmOnly: false, limit: 10 })[0].otm).toBe(true);
  });

  it("builds a gate link that prefills the contract and the mid", () => {
    const row = scoreChain({
      ticker: "NVDA",
      contracts: [contract()],
      underlyingPrice: 100,
      delayed: false,
      previous: null,
      now: NOW,
    })[0];
    expect(gateCheckHref(row)).toBe("/gate?ticker=NVDA&expiration=2026-10-08&strike=105&putCall=call&plannedEntry=2.05");
  });

  it("asks Schwab for near-the-money strikes and a short expiration window", () => {
    expect(flowChainRequest("nvda", NOW)).toEqual({
      symbol: "NVDA",
      contractType: "ALL",
      range: "NTM",
      strikeCount: 6,
      fromDate: "2026-10-01",
      toDate: "2026-11-05",
    });
  });

  it("parses a watchlist and falls back to the liquid default", () => {
    expect(parseWatchlist("spy, qqq, SPY, !!!, amd")).toEqual(["SPY", "QQQ", "AMD"]);
    expect(parseWatchlist("")).toEqual([...DEFAULT_FLOW_WATCHLIST]);
    expect(parseWatchlist(undefined)).toHaveLength(15);
    expect(DEFAULT_FLOW_WATCHLIST).toContain("SOFI");
    expect(DEFAULT_FLOW_WATCHLIST).toContain("NFLX");
  });

  it("stores the volumes that the next scan will diff", () => {
    const rows = scoreChain({
      ticker: "QQQ",
      contracts: [contract()],
      underlyingPrice: 100,
      delayed: false,
      previous: null,
      now: NOW,
    });
    const snap = snapshotFromRows(rows, NOW.getTime());
    expect(snap.volumes[flowContractKey(rows[0])]).toBe(400);
    const again = volumeSinceLastScan(460, snap, flowContractKey(rows[0]), NOW);
    expect(again.volumeJump).toBe(60);
  });

  it("filters OTM and minimum premium without dropping the score order", () => {
    const rows: FlowRow[] = [
      fakeRow({ id: "a", score: 10, notionalPremium: 80_000, otm: false, liquidityPasses: true }),
      fakeRow({ id: "b", score: 30, notionalPremium: 40_000, otm: true, liquidityPasses: true }),
      fakeRow({ id: "c", score: 20, notionalPremium: 90_000, otm: true, liquidityPasses: true }),
    ];
    expect(filterFlowRows(rows, { minPremium: 50_000, otmOnly: true, liquidOnly: true, limit: 10 }).map((row) => row.id)).toEqual(["c"]);
  });
});

describe("nearest expirations", () => {
  it("sorts calendar dates and ignores the past", () => {
    const kept = keepNearestExpirations([
      contract({ expiration: "2026-10-20" }),
      contract({ expiration: "2026-09-01" }),
      contract({ expiration: "2026-10-03", strike: 1 }),
      contract({ expiration: "2026-10-10", strike: 2 }),
    ], 2, "2026-10-01");
    expect(kept.map((row) => row.expiration).sort()).toEqual(["2026-10-03", "2026-10-10"]);
  });
});

function fakeRow(over: Partial<FlowRow>): FlowRow {
  return {
    id: "x",
    ticker: "SPY",
    putCall: "call",
    strike: 105,
    expiration: "2026-10-08",
    bid: 2,
    ask: 2.1,
    last: 2.08,
    volume: 400,
    openInterest: 800,
    iv: 0.25,
    delta: 0.4,
    mid: 2.05,
    notionalPremium: 82_000,
    volOiRatio: 0.5,
    volumeOiJump: -400,
    volumeExceedsOi: false,
    previousVolume: null,
    volumeJump: null,
    otmPoints: 5,
    otmFraction: 0.05,
    otm: true,
    dte: 7,
    spreadFraction: 0.048,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "Estimated from the last price versus the bid and ask. Not a sweep print.",
    askFraction: 0.8,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 100,
    levels: null,
    score: 50,
    ...over,
  };
}
