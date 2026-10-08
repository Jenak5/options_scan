import { describe, expect, it } from "vitest";
import { normalizeOptionSymbol, schwabOptionSymbol } from "@/app/lib/optionSymbol";

describe("schwab option symbol", () => {
  it("builds the OCC symbol Schwab uses for quotes", () => {
    expect(schwabOptionSymbol({
      ticker: "NVDA",
      expiration: "2026-11-06",
      strike: 235,
      putCall: "put",
    })).toBe("NVDA  261106P00235000");
    expect(schwabOptionSymbol({
      ticker: "spy",
      expiration: "2026-10-16",
      strike: 570,
      putCall: "call",
    })).toBe("SPY   261016C00570000");
    expect(schwabOptionSymbol({
      ticker: "BRK.B",
      expiration: "2026-11-20",
      strike: 500.5,
      putCall: "call",
    })).toBe("BRKB  261120C00500500");
  });

  it("rejects a root that does not fit the 6-character symbol", () => {
    expect(schwabOptionSymbol({
      ticker: "TOOLONG",
      expiration: "2026-11-06",
      strike: 10,
      putCall: "call",
    })).toBeNull();
    expect(schwabOptionSymbol({
      ticker: "NVDA",
      expiration: "11/06/2026",
      strike: 235,
      putCall: "put",
    })).toBeNull();
  });

  it("treats spacing as the same symbol", () => {
    expect(normalizeOptionSymbol("NVDA  261106P00235000")).toBe("NVDA261106P00235000");
    expect(normalizeOptionSymbol(" nvda261106p00235000 ")).toBe("NVDA261106P00235000");
  });
});
