import { describe, expect, it, vi } from "vitest";
import type { OptionContract } from "@/app/lib/contract";
import {
  DEBIT_SPREAD_SUGGESTION,
  checkBidAskSpread,
  dailyStopPasses,
  debitSpreadMaxLoss,
  evaluateGate,
  findContract,
  longOptionMaxLoss,
  openInterestPasses,
  singleContractExceedsCap,
  volumePasses,
  type GateInput,
  type GateResult,
} from "@/app/lib/gate";
import { parseOptionChain } from "@/app/lib/schwabParse";
import {
  ACCOUNT_SIZE_DOLLARS,
  MAX_LOSS_DOLLARS,
  MAX_RISK_FRACTION,
  MIN_CONTRACT_VOLUME,
  MIN_OPEN_INTEREST,
} from "@/app/lib/risk";

function contract(over: Partial<OptionContract> = {}): OptionContract {
  return {
    bid: 2,
    ask: 2.05,
    last: 2.02,
    volume: 150,
    openInterest: 900,
    delta: 0.41,
    iv: 0.22,
    strike: 570,
    expiration: "2026-10-16",
    putCall: "call",
    ...over,
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    contract: contract(),
    contracts: 1,
    plannedEntry: 2.02,
    debitSpreadWidth: null,
    underlyingStop: "Out if SPY trades 568",
    timeStop: "Flat by 15:30 ET",
    profitRule: "Sell half at +30%",
    consecutiveLosses: 0,
    delayed: false,
    ...over,
  };
}

function check(result: GateResult, id: string) {
  const found = result.checks.find((row) => row.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

describe("account constants", () => {
  it("caps one trade at 15% of a $3,000 account", () => {
    expect(ACCOUNT_SIZE_DOLLARS).toBe(3000);
    expect(MAX_RISK_FRACTION).toBe(0.15);
    expect(MAX_LOSS_DOLLARS).toBe(450);
  });
});

describe("open interest", () => {
  it("passes at the minimum and fails just under", () => {
    expect(openInterestPasses(MIN_OPEN_INTEREST)).toBe(true);
    expect(openInterestPasses(MIN_OPEN_INTEREST - 1)).toBe(false);
    expect(openInterestPasses(0)).toBe(false);
    expect(openInterestPasses(-1)).toBe(false);
    expect(openInterestPasses(Number.NaN)).toBe(false);
    expect(check(evaluateGate(input({ contract: contract({ openInterest: 499 }) })), "openInterest").status).toBe("FAIL");
    expect(check(evaluateGate(input({ contract: contract({ openInterest: 500 }) })), "openInterest").status).toBe("PASS");
  });
});

describe("volume", () => {
  it("passes at 100 contracts today and fails below that", () => {
    expect(volumePasses(MIN_CONTRACT_VOLUME)).toBe(true);
    expect(volumePasses(MIN_CONTRACT_VOLUME - 1)).toBe(false);
    expect(volumePasses(0)).toBe(false);
    expect(volumePasses(Number.NaN)).toBe(false);
    expect(check(evaluateGate(input({ contract: contract({ volume: 99 }) })), "volume").status).toBe("FAIL");
    expect(check(evaluateGate(input({ contract: contract({ volume: 100 }) })), "volume").status).toBe("PASS");
  });
});

describe("bid-ask spread", () => {
  it("passes at exactly 5% of mid", () => {
    const result = checkBidAskSpread(1.95, 2.05);
    expect(result.mid).toBe(2);
    expect(result.fraction).toBeCloseTo(0.05, 10);
    expect(result.pass).toBe(true);
    expect(check(evaluateGate(input({ contract: contract({ bid: 1.95, ask: 2.05 }) })), "spread").status).toBe("PASS");
  });

  it("fails when the spread is just over 5% of mid", () => {
    const result = checkBidAskSpread(1.95, 2.06);
    expect(result.pass).toBe(false);
    expect(check(evaluateGate(input({ contract: contract({ bid: 1.95, ask: 2.06 }) })), "spread").status).toBe("FAIL");
  });

  it("fails a zero midpoint, a crossed market, a zero bid, and a missing quote", () => {
    expect(checkBidAskSpread(0, 0).pass).toBe(false);
    expect(checkBidAskSpread(0, 0).detail).toMatch(/zero/i);
    expect(checkBidAskSpread(1.2, 1.1).pass).toBe(false);
    expect(checkBidAskSpread(1.2, 1.1).detail).toMatch(/crossed/i);
    expect(checkBidAskSpread(0, 0.1).pass).toBe(false);
    expect(checkBidAskSpread(Number.NaN, 1).pass).toBe(false);
    expect(checkBidAskSpread(-0.05, 0.1).pass).toBe(false);
  });
});

describe("max loss", () => {
  it("prices a long option as contracts × ask × 100", () => {
    expect(longOptionMaxLoss(1, 4.5)).toBe(450);
    expect(longOptionMaxLoss(2, 2)).toBe(400);
    expect(longOptionMaxLoss(0, 1)).toBeNull();
    expect(longOptionMaxLoss(1.5, 1)).toBeNull();
    expect(longOptionMaxLoss(1, 0)).toBeNull();
    expect(longOptionMaxLoss(1, Number.NaN)).toBeNull();
  });

  it("passes a $450 long and fails $451", () => {
    const atCap = evaluateGate(input({ contract: contract({ bid: 4.5, ask: 4.5 }), plannedEntry: 4.5 }));
    expect(check(atCap, "maxLoss").status).toBe("PASS");
    expect(atCap.singleContractExceedsCap).toBe(false);
    expect(atCap.suggestion).toBeNull();

    const over = evaluateGate(input({ contract: contract({ bid: 4.51, ask: 4.51 }), plannedEntry: 4.51 }));
    expect(check(over, "maxLoss").status).toBe("FAIL");
    expect(over.maxLoss).toBeCloseTo(451, 5);
    expect(over.singleContractExceedsCap).toBe(true);
    expect(over.suggestion).toBe(DEBIT_SPREAD_SUGGESTION);
    expect(singleContractExceedsCap(4.51)).toBe(true);
    expect(singleContractExceedsCap(4.5)).toBe(false);
  });

  it("does not suggest a debit spread when one contract is inside the cap", () => {
    const result = evaluateGate(input({
      contract: contract({ bid: 3, ask: 3 }),
      contracts: 2,
      plannedEntry: 3,
    }));
    expect(result.maxLoss).toBe(600);
    expect(check(result, "maxLoss").status).toBe("FAIL");
    expect(result.singleContractExceedsCap).toBe(false);
    expect(result.suggestion).toBeNull();
  });

  it("uses strike width × 100 × contracts for a debit spread", () => {
    expect(debitSpreadMaxLoss(1, 4.5)).toBe(450);
    expect(debitSpreadMaxLoss(1, 4.51)).toBeCloseTo(451, 5);
    expect(debitSpreadMaxLoss(1, 0)).toBeNull();
    expect(debitSpreadMaxLoss(1, -1)).toBeNull();

    const passed = evaluateGate(input({
      contract: contract({ bid: 6, ask: 6, openInterest: 800, volume: 200 }),
      debitSpreadWidth: 4,
      plannedEntry: 2.5,
    }));
    expect(passed.maxLoss).toBe(400);
    expect(check(passed, "maxLoss").status).toBe("PASS");
    expect(passed.singleContractExceedsCap).toBe(true);
    expect(passed.suggestion).toBe(DEBIT_SPREAD_SUGGESTION);
    expect(passed.overall).toBe("PASS");

    const failed = evaluateGate(input({
      contract: contract({ bid: 6, ask: 6 }),
      debitSpreadWidth: 5,
      plannedEntry: 2.5,
    }));
    expect(check(failed, "maxLoss").status).toBe("FAIL");
    expect(check(evaluateGate(input({ debitSpreadWidth: 0 })), "maxLoss").status).toBe("FAIL");
  });

  it("rejects a contract count that is not a whole number from 1 to 100", () => {
    expect(check(evaluateGate(input({ contracts: 0 })), "maxLoss").status).toBe("FAIL");
    expect(check(evaluateGate(input({ contracts: 1.2 })), "maxLoss").status).toBe("FAIL");
    expect(check(evaluateGate(input({ contracts: -1 })), "maxLoss").status).toBe("FAIL");
    expect(check(evaluateGate(input({ contracts: 101 })), "maxLoss").status).toBe("FAIL");
  });
});

describe("plan and daily stop", () => {
  it("requires a planned entry, an underlying stop, a time stop, and a profit rule", () => {
    expect(check(evaluateGate(input({ plannedEntry: 0 })), "plannedEntry").status).toBe("FAIL");
    expect(check(evaluateGate(input({ plannedEntry: -1 })), "plannedEntry").status).toBe("FAIL");
    expect(check(evaluateGate(input({ plannedEntry: Number.NaN })), "plannedEntry").status).toBe("FAIL");
    expect(check(evaluateGate(input({ underlyingStop: "   " })), "underlyingStop").status).toBe("FAIL");
    expect(check(evaluateGate(input({ timeStop: "" })), "timeStop").status).toBe("FAIL");
    expect(check(evaluateGate(input({ profitRule: "\n" })), "profitRule").status).toBe("FAIL");
    expect(check(evaluateGate(input()), "underlyingStop").status).toBe("PASS");
    expect(check(evaluateGate(input()), "timeStop").status).toBe("PASS");
    expect(check(evaluateGate(input()), "profitRule").status).toBe("PASS");
  });

  it("is NO for the day after two losses and passes before that", () => {
    expect(dailyStopPasses(0)).toBe(true);
    expect(dailyStopPasses(1)).toBe(true);
    expect(dailyStopPasses(2)).toBe(false);
    expect(dailyStopPasses(3)).toBe(false);
    expect(dailyStopPasses(-1)).toBe(false);
    expect(dailyStopPasses(1.5)).toBe(false);
    expect(check(evaluateGate(input({ consecutiveLosses: 1 })), "dailyStop").status).toBe("PASS");
    const stopped = evaluateGate(input({ consecutiveLosses: 2 }));
    expect(check(stopped, "dailyStop").status).toBe("FAIL");
    expect(stopped.overall).toBe("NO");
    expect(check(evaluateGate(input({ consecutiveLosses: Number.NaN })), "dailyStop").status).toBe("FAIL");
  });
});

describe("overall", () => {
  it("is PASS only when every check passes", () => {
    expect(evaluateGate(input()).overall).toBe("PASS");
  });

  it("is NO when any one check fails", () => {
    const result = evaluateGate(input({ contract: contract({ volume: 10 }) }));
    expect(check(result, "volume").status).toBe("FAIL");
    expect(check(result, "openInterest").status).toBe("PASS");
    expect(result.overall).toBe("NO");
  });

  it("is NO when the chain did not include the strike", () => {
    const result = evaluateGate(input({ contract: null }));
    expect(result.overall).toBe("NO");
    expect(check(result, "contract").status).toBe("FAIL");
    expect(check(result, "openInterest").status).toBe("FAIL");
    expect(check(result, "spread").status).toBe("FAIL");
    expect(check(result, "maxLoss").status).toBe("FAIL");
  });

  it("is NO when Schwab marks the chain delayed", () => {
    const result = evaluateGate(input({ delayed: true }));
    expect(check(result, "delayed").status).toBe("FAIL");
    expect(result.overall).toBe("NO");
  });

  it("does not call the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network");
    });
    evaluateGate(input());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("fixture chain", () => {
  const fixture = {
    isDelayed: false,
    underlyingPrice: 570.12,
    callExpDateMap: {
      "2026-10-16:15": {
        "570.0": [{
          putCall: "CALL",
          bid: 1.95,
          ask: 2.05,
          last: 2,
          totalVolume: 140,
          openInterest: 800,
          volatility: 22.5,
          delta: 0.48,
          strikePrice: 570,
        }],
        "575.0": [{
          putCall: "CALL",
          bid: 0.4,
          ask: 0.42,
          last: 0.41,
          totalVolume: 10,
          openInterest: 40,
          volatility: 20,
          delta: 0.12,
          strikePrice: 575,
        }],
      },
    },
    putExpDateMap: {
      "2026-10-16:15": {
        "570.0": [{
          putCall: "PUT",
          bid: 1.9,
          ask: 1.98,
          last: 1.94,
          totalVolume: 220,
          openInterest: 1500,
          volatility: 24,
          delta: -0.46,
          strikePrice: 570,
        }],
      },
    },
  };

  it("finds the call and ignores the put and the thin strike", () => {
    const parsed = parseOptionChain(fixture);
    expect(parsed.delayed).toBe(false);
    expect(parsed.underlyingPrice).toBe(570.12);
    const call = findContract(parsed.contracts, { expiration: "2026-10-16", strike: 570, putCall: "call" });
    const put = findContract(parsed.contracts, { expiration: "2026-10-16T21:00:00.000Z", strike: 570, putCall: "put" });
    expect(call).toMatchObject({
      bid: 1.95,
      ask: 2.05,
      last: 2,
      volume: 140,
      openInterest: 800,
      delta: 0.48,
      iv: 0.225,
      strike: 570,
      expiration: "2026-10-16",
      putCall: "call",
    });
    expect(put?.putCall).toBe("put");
    expect(put?.iv).toBe(0.24);
    expect(findContract(parsed.contracts, { expiration: "2026-10-16", strike: 570, putCall: "call" })?.putCall).toBe("call");
    expect(findContract(parsed.contracts, { expiration: "2026-10-17", strike: 570, putCall: "call" })).toBeNull();
    expect(findContract(parsed.contracts, { expiration: "2026-10-16", strike: 571, putCall: "call" })).toBeNull();

    const result = evaluateGate(input({ contract: call }));
    expect(result.overall).toBe("PASS");
    const thin = findContract(parsed.contracts, { expiration: "2026-10-16", strike: 575, putCall: "call" });
    expect(evaluateGate(input({ contract: thin })).overall).toBe("NO");
  });
});
