import { describe, expect, it, vi } from "vitest";
import type { OptionContract, PutCall } from "@/app/lib/contract";
import {
  CHEAP_SPREAD_POINTS,
  RICH_SPREAD_POINTS,
  VOL_DEFINITIONS,
  VOL_DISCLAIMER,
  buildVolArbReading,
  formatVolArbSummary,
  realizedVol,
  signalFromSpread,
} from "@/app/lib/volArb";

const AS_OF = "2026-10-01";

function contract(
  overrides: Partial<OptionContract> & Pick<OptionContract, "strike" | "expiration" | "putCall">,
): OptionContract {
  return {
    bid: 1.2,
    ask: 1.3,
    last: 1.25,
    volume: 40,
    openInterest: 200,
    delta: null,
    iv: 0.2,
    ...overrides,
  };
}

function side(expiration: string, strike: number, putCall: PutCall, iv: number, extra: Partial<OptionContract> = {}): OptionContract {
  return contract({ expiration, strike, putCall, iv, ...extra });
}

function pricesFromReturns(start: number, returns: number[]): number[] {
  const prices = [start];
  for (let i = 0; i < returns.length; i++) prices.push(prices[prices.length - 1] * Math.exp(returns[i]));
  return prices;
}

describe("signalFromSpread", () => {
  it("uses the cheap and rich gaps", () => {
    expect(signalFromSpread(CHEAP_SPREAD_POINTS)).toBe("CHEAP");
    expect(signalFromSpread(CHEAP_SPREAD_POINTS + 0.1)).toBe("NEUTRAL");
    expect(signalFromSpread(RICH_SPREAD_POINTS)).toBe("RICH");
    expect(signalFromSpread(RICH_SPREAD_POINTS - 0.1)).toBe("NEUTRAL");
    expect(signalFromSpread(0)).toBe("NEUTRAL");
    expect(signalFromSpread(null)).toBe("NO_READ");
    expect(signalFromSpread(Number.NaN)).toBe("NO_READ");
  });
});

describe("realizedVol", () => {
  it("annualizes the sample deviation of the last window only", () => {
    const returns = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const prices = pricesFromReturns(100, returns);
    const expected20 = Math.sqrt(0.002 / 19) * Math.sqrt(252) * 100;
    const expected10 = Math.sqrt(0.001 / 9) * Math.sqrt(252) * 100;
    expect(realizedVol(prices, 20)).toBeCloseTo(expected20, 6);
    expect(realizedVol(prices, 10)).toBeCloseTo(expected10, 6);
    expect(realizedVol([50, ...Array(21).fill(100)], 20)).toBe(0);
  });

  it("returns null when a close in the window is missing or the series is short", () => {
    expect(realizedVol(Array(20).fill(100), 20)).toBeNull();
    const broken = Array(21).fill(100);
    broken[10] = 0;
    expect(realizedVol(broken, 20)).toBeNull();
    expect(realizedVol([], 20)).toBeNull();
    expect(realizedVol(Array(30).fill(100), 1)).toBeNull();
  });
});

describe("buildVolArbReading", () => {
  it("does not call the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network");
    });
    buildVolArbReading({
      symbol: "SPY",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [],
      closes: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("averages ATM call and put IV, reads term and 25-delta skew, and flags rich vol", () => {
    const contracts = [
      side("2026-10-08", 100, "call", 0.4, { delta: 0.5 }),
      side("2026-10-08", 100, "put", 0.4, { delta: -0.5 }),
      side("2026-10-30", 100, "call", 0.2, { delta: 0.5 }),
      side("2026-10-30", 100, "put", 0.22, { delta: -0.5 }),
      side("2026-10-30", 90, "put", 0.3, { delta: -0.25 }),
      side("2026-10-30", 110, "call", 0.16, { delta: 0.25 }),
      side("2026-12-01", 100, "call", 0.18, { delta: 0.5 }),
      side("2026-12-01", 100, "put", 0.18, { delta: -0.5 }),
      side("2026-10-08", 80, "put", 0.9, { delta: -0.25 }),
    ];
    const reading = buildVolArbReading({
      symbol: "spy",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts,
      closes: Array(30).fill(100),
    });
    expect(reading.symbol).toBe("SPY");
    expect(reading.status).toBe("ok");
    expect(reading.atmExpiration).toBe("2026-10-30");
    expect(reading.atmDte).toBe(29);
    expect(reading.atmIv30).toBe(21);
    expect(reading.rv20).toBe(0);
    expect(reading.ivRvSpread).toBe(21);
    expect(reading.signal).toBe("RICH");
    expect(reading.signalNote).toMatch(/21\.0 points above/);
    expect(reading.signalNote).toMatch(/Research only/);
    expect(reading.frontExpiration).toBe("2026-10-08");
    expect(reading.frontDte).toBe(7);
    expect(reading.frontAtmIv).toBe(40);
    expect(reading.backExpiration).toBe("2026-12-01");
    expect(reading.backDte).toBe(61);
    expect(reading.backAtmIv).toBe(18);
    expect(reading.termSlope).toBe(-22);
    expect(reading.skew).toBe(14);
    expect(reading.skewMethod).toBe("25-delta");
    expect(reading.skewPutStrike).toBe(90);
    expect(reading.skewCallStrike).toBe(110);
    expect(reading.notable.find((row) => row.expiration === "2026-10-08")).toBeUndefined();
  });

  it("prefers the nearer expiration when two are equally close to 30 days", () => {
    const reading = buildVolArbReading({
      symbol: "QQQ",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [
        side("2026-10-24", 100, "call", 0.15),
        side("2026-10-24", 100, "put", 0.15),
        side("2026-11-07", 100, "call", 0.33),
        side("2026-11-07", 100, "put", 0.33),
      ],
      closes: Array(30).fill(50),
    });
    expect(reading.atmExpiration).toBe("2026-10-24");
    expect(reading.atmDte).toBe(23);
    expect(reading.atmIv30).toBe(15);
  });

  it("uses about-5% strikes when delta is missing", () => {
    const reading = buildVolArbReading({
      symbol: "IWM",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [
        side("2026-10-30", 100, "call", 0.2, { delta: 0.05 }),
        side("2026-10-30", 100, "put", 0.2, { delta: -0.05 }),
        side("2026-10-30", 90, "put", 0.28),
        side("2026-10-30", 110, "call", 0.18),
      ],
      closes: Array(30).fill(100),
    });
    expect(reading.skewMethod).toBe("otm");
    expect(reading.skew).toBe(10);
    expect(reading.skewPutStrike).toBe(90);
    expect(reading.skewCallStrike).toBe(110);
  });

  it("picks ATM from the 50-delta call when the stock price is missing", () => {
    const reading = buildVolArbReading({
      symbol: "AAPL",
      asOf: AS_OF,
      underlyingPrice: null,
      delayed: false,
      contracts: [
        side("2026-10-30", 90, "call", 0.4, { delta: 0.8 }),
        side("2026-10-30", 110, "call", 0.19, { delta: 0.48 }),
        side("2026-10-30", 110, "put", 0.21, { delta: -0.52 }),
      ],
      closes: Array(30).fill(100),
    });
    expect(reading.atmIv30).toBe(20);
    expect(reading.underlyingPrice).toBeNull();
  });

  it("lists liquid strikes that are cheap or rich versus that expiration's ATM IV", () => {
    const reading = buildVolArbReading({
      symbol: "AMD",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [
        side("2026-10-30", 100, "call", 0.2),
        side("2026-10-30", 100, "put", 0.2),
        side("2026-10-30", 90, "put", 0.16),
        side("2026-10-30", 95, "put", 0.161),
        side("2026-10-30", 110, "call", 0.26),
        side("2026-10-30", 85, "put", 0.05, { openInterest: 0, volume: 0 }),
        side("2026-10-30", 115, "call", 0.4, { bid: 0.1, ask: 2, openInterest: 800 }),
      ],
      closes: Array(30).fill(100),
    });
    const labels = reading.notable.map((row) => `${row.strike}${row.putCall[0].toUpperCase()}:${row.label}:${row.versusAtm}`);
    expect(labels).toContain("90P:CHEAP:-4");
    expect(labels).toContain("110C:RICH:6");
    expect(labels.some((label) => label.startsWith("95"))).toBe(false);
    expect(labels.some((label) => label.startsWith("85"))).toBe(false);
    expect(labels.some((label) => label.startsWith("115"))).toBe(false);
  });

  it("marks cheap vol when implied vol sits under realized vol", () => {
    const returns = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.02));
    const reading = buildVolArbReading({
      symbol: "NVDA",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [
        side("2026-10-30", 100, "call", 0.1),
        side("2026-10-30", 100, "put", 0.1),
      ],
      closes: pricesFromReturns(100, returns),
    });
    expect(reading.rv20).toBeGreaterThan(30);
    expect(reading.ivRvSpread).not.toBeNull();
    expect(reading.ivRvSpread!).toBeLessThanOrEqual(CHEAP_SPREAD_POINTS);
    expect(reading.signal).toBe("CHEAP");
    expect(reading.signalNote).toMatch(/below 20-day realized vol/);
  });

  it("marks neutral when the rounded IV matches realized vol", () => {
    const returns = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const closes = pricesFromReturns(100, returns);
    const rv = realizedVol(closes, 20);
    expect(rv).not.toBeNull();
    const rounded = Math.round(rv! * 10) / 10;
    const reading = buildVolArbReading({
      symbol: "MSFT",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [
        side("2026-10-30", 100, "call", rounded / 100),
        side("2026-10-30", 100, "put", rounded / 100),
      ],
      closes,
    });
    expect(reading.atmIv30).toBe(rounded);
    expect(reading.rv20).toBe(rounded);
    expect(reading.ivRvSpread).toBe(0);
    expect(reading.signal).toBe("NEUTRAL");
  });

  it("drops a delayed chain instead of showing its implied vol", () => {
    const reading = buildVolArbReading({
      symbol: "TSLA",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: true,
      contracts: [side("2026-10-30", 100, "call", 0.9), side("2026-10-30", 100, "put", 0.9)],
      closes: Array(30).fill(100),
    });
    expect(reading.status).toBe("delayed");
    expect(reading.signal).toBe("NO_READ");
    expect(reading.underlyingPrice).toBeNull();
    expect(reading.atmIv30).toBeNull();
    expect(reading.rv20).toBeNull();
    expect(reading.ivRvSpread).toBeNull();
    expect(reading.notable).toEqual([]);
    expect(reading.message).toMatch(/delayed/);
    expect(reading.message).toMatch(/[Rr]eal-time/);
  });

  it("keeps implied vol when daily prices are missing and says which piece failed", () => {
    const base = {
      symbol: "META",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [side("2026-10-30", 100, "call", 0.25), side("2026-10-30", 100, "put", 0.25)],
    };
    const failed = buildVolArbReading({ ...base, closes: [], priceHistoryFailed: true });
    expect(failed.status).toBe("missing");
    expect(failed.signal).toBe("NO_READ");
    expect(failed.atmIv30).toBe(25);
    expect(failed.rv20).toBeNull();
    expect(failed.message).toMatch(/did not load/);

    const short = buildVolArbReading({ ...base, closes: [100, 101, 102] });
    expect(short.message).toMatch(/Not enough Schwab daily prices/);
    expect(short.atmIv30).toBe(25);

    const noIv = buildVolArbReading({
      symbol: "META",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [side("2026-10-30", 100, "call", 0), side("2026-10-30", 100, "put", 5.5)],
      closes: Array(30).fill(100),
    });
    expect(noIv.atmIv30).toBeNull();
    expect(noIv.rv20).toBe(0);
    expect(noIv.message).toMatch(/no usable at-the-money implied vol/);
  });

  it("formats the alert line from the same IV and realized-vol numbers", () => {
    const rich = buildVolArbReading({
      symbol: "SPY",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: false,
      contracts: [
        side("2026-10-30", 100, "call", 0.21),
        side("2026-10-30", 100, "put", 0.21),
      ],
      closes: Array(30).fill(100),
    });
    const line = formatVolArbSummary(rich);
    expect(line).toBe("RICH — ATM IV 21.0% vs RV 20d 0.0% (+21.0)");
    expect(line.includes("UNKNOWN")).toBe(false);

    const withheld = buildVolArbReading({
      symbol: "SPY",
      asOf: AS_OF,
      underlyingPrice: 100,
      delayed: true,
      contracts: [side("2026-10-30", 100, "call", 0.4)],
      closes: Array(30).fill(100),
    });
    const missing = formatVolArbSummary(withheld);
    expect(missing).toMatch(/delayed/);
    expect(missing.includes("UNKNOWN")).toBe(false);
  });

  it("says what each published number is, and does not call it an IV rank", () => {
    expect(VOL_DISCLAIMER).toMatch(/Research view only/);
    expect(VOL_DISCLAIMER).toMatch(/does not place orders/);
    expect(VOL_DISCLAIMER).toMatch(/not a 52-week IV rank/);
    const labels = VOL_DEFINITIONS.map((item) => item.label);
    expect(labels).toEqual([
      "ATM IV (~30d)",
      "RV 20d",
      "RV 10d",
      "IV − RV",
      "Term",
      "Skew",
      "Cheap / rich strikes",
    ]);
    for (const item of VOL_DEFINITIONS) expect(item.text.length).toBeGreaterThan(20);
  });
});
