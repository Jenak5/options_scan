import { describe, expect, it } from "vitest";
import { emptyCheckpoint, parseAlertBook, type StoredAlert } from "@/app/lib/alertBook";
import { backfillFeatures, featuresForAlert, parseFeatureSnapshot } from "@/app/lib/alertFeatures";
import type { CandleBar } from "@/app/lib/candleTypes";
import {
  backfillAlert,
  backfillAlerts,
  barsBefore,
  earningsAt,
  NOT_RECOVERABLE,
  parseEarningsReports,
  parseExpectedEarnings,
  spyTrendAt,
  type BackfillInputs,
  type UnderlyingHistory,
} from "@/app/lib/featureBackfill";
import { candleSubscriptionSymbol } from "@/app/lib/optionStreamer";
import { feedMessages, parseCompactCandles } from "@/app/lib/tastytradeCandles";

const OPEN_UTC = Date.UTC(2026, 9, 1, 13, 30); // 8:30 CT, Thursday 2026-10-01
const SENT = OPEN_UTC + 90 * 60_000; // 10:00 CT
const NOW = new Date(Date.UTC(2026, 9, 14, 15, 0));

function intraday(start: number, step: number): CandleBar[] {
  const bars: CandleBar[] = [];
  for (let i = 0; i < 78; i++) {
    const price = start + step * i;
    bars.push({ t: OPEN_UTC + i * 5 * 60_000, o: price, h: price + 0.1, l: price - 0.1, c: price, v: 1000 });
  }
  return bars;
}

function daily(close: number): CandleBar[] {
  const bars: CandleBar[] = [];
  let day = Date.UTC(2026, 8, 30);
  while (bars.length < 30) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      bars.unshift({ t: day, o: close, h: close + 2, l: close - 2, c: close, v: 1_000_000 });
    }
    day -= 86_400_000;
  }
  return bars;
}

function history(start: number, step: number, close: number): UnderlyingHistory {
  return { intraday: intraday(start, step), daily: daily(close) };
}

function inputs(over: Partial<BackfillInputs> = {}): BackfillInputs {
  return {
    history: new Map([
      ["NVDA", history(100, 0.5, 90)],
      ["SPY", history(600, 0.2, 590)],
      ["QQQ", history(500, -0.2, 510)],
    ]),
    earnings: new Map([["NVDA", { reported: ["2026-08-26"], nextExpected: "2026-11-18" }]]),
    now: NOW,
    ...over,
  };
}

function alert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: `${SENT}-NVDA|2026-10-23|120|call`,
    contractKey: "NVDA|2026-10-23|120|call",
    sentAt: SENT,
    tradingDay: "2026-10-01",
    ticker: "NVDA",
    putCall: "call",
    strike: 120,
    expiration: "2026-10-23",
    bid: 1.9,
    ask: 2,
    mid: 1.95,
    underlyingPrice: 110,
    volume: 800,
    openInterest: 500,
    flowScore: 10,
    liquidityPasses: true,
    side: "estimated at ask",
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "B",
    reasons: ["Flow"],
    note: "",
    levels: null,
    levelsNote: null,
    eventLine: null,
    maxContracts: 1,
    checkpoints: { m15: emptyCheckpoint(), h1: emptyCheckpoint(), close: emptyCheckpoint() },
    outcome: "pending",
    ...over,
  };
}

describe("feature backfill from Tastytrade history", () => {
  it("fills trend, index direction, minutes, earnings, and levels on an alert with no snapshot", () => {
    const result = backfillAlert(alert(), inputs());
    const f = result.features;
    expect(f.minutesSinceOpen).toBe(90);
    expect(f.priceVsVwap).toBe("above");
    expect(f.priceVsSma20).toBe("above");
    expect(f.trendAlignment).toBe("with");
    expect(f.spyDirection).toBe("up");
    expect(f.qqqDirection).toBe("down");
    expect(f.marketAlignment).toBe("mixed");
    expect(f.earnings).toBe("after");
    expect(f.rewardDistance).not.toBeNull();
    expect(f.riskDistance).not.toBeNull();
    expect(f.capturedAtAlert).toBe(false);
    expect(f.backfilled?.source).toBe("tastytrade-history");
    expect(f.backfilled?.fields).toEqual(expect.arrayContaining([
      "minutesSinceOpen", "priceVsVwap", "priceVsSma20", "trendAlignment", "spyDirection",
      "qqqDirection", "marketAlignment", "earnings", "rewardDistance", "riskDistance",
    ]));
  });

  it("never invents chain-only fields", () => {
    const f = backfillAlert(alert(), inputs()).features;
    expect(f.iv).toBeNull();
    expect(f.delta).toBeNull();
    expect(f.volumeJump).toBeNull();
    expect(f.flowSignalCount).toBeNull();
    expect(f.ivVsRecent).toBeNull();
    expect(f.repeatFlow).toBeNull();
    expect(f.pairedFlow).toBeNull();
    expect(Object.keys(NOT_RECOVERABLE)).toEqual(expect.arrayContaining(["iv", "delta", "volumeJump", "repeatFlow"]));
  });

  it("keeps values captured at send time and fills only the unknown ones", () => {
    const captured = {
      ...backfillFeatures(alert()),
      capturedAtAlert: true,
      minutesSinceOpen: 88,
      priceVsVwap: "unknown" as const,
      priceVsSma20: "below" as const,
      trendAlignment: "unknown" as const,
      spyDirection: "unknown" as const,
      qqqDirection: "unknown" as const,
      marketAlignment: "unknown" as const,
      earnings: "inside" as const,
      iv: 0.3,
    };
    const f = backfillAlert(alert({ features: captured }), inputs()).features;
    expect(f.capturedAtAlert).toBe(true);
    expect(f.minutesSinceOpen).toBe(88);
    expect(f.priceVsSma20).toBe("below");
    expect(f.earnings).toBe("inside");
    expect(f.iv).toBe(0.3);
    expect(f.priceVsVwap).toBe("above");
    // Captured below the 20-day plus filled above VWAP on a call is mixed.
    expect(f.trendAlignment).toBe("mixed");
    expect(f.backfilled?.fields).not.toContain("minutesSinceOpen");
    expect(f.backfilled?.fields).not.toContain("earnings");
  });

  it("leaves the alert alone when no history came back", () => {
    const result = backfillAlert(alert({ sentAt: Date.UTC(2026, 9, 3, 1, 0) }), inputs({ history: new Map(), earnings: new Map() }));
    expect(result.filled).toEqual([]);
    expect(result.features.backfilled).toBeUndefined();
  });

  it("uses only 5-minute bars that had closed by the send time", () => {
    const bars = intraday(100, 1);
    const used = barsBefore(bars, OPEN_UTC + 12 * 60_000);
    expect(used.map((bar) => bar.t)).toEqual([OPEN_UTC, OPEN_UTC + 5 * 60_000]);
  });

  it("reads SPY trend for research paths saved as unknown", () => {
    expect(spyTrendAt(history(600, 0.2, 590), SENT, NOW)).toBe("up");
    expect(spyTrendAt(undefined, SENT, NOW)).toBe("unknown");
  });

  it("places earnings inside, after, none, or unknown", () => {
    expect(earningsAt({ reported: ["2026-10-20"], nextExpected: null }, "2026-10-01", "2026-10-23")).toBe("inside");
    expect(earningsAt({ reported: ["2026-08-26"], nextExpected: "2026-11-18" }, "2026-10-01", "2026-10-23")).toBe("after");
    expect(earningsAt({ reported: [], nextExpected: null }, "2026-10-01", "2026-10-23")).toBe("none");
    expect(earningsAt({ reported: ["2026-08-26"], nextExpected: null }, "2026-10-01", "2026-10-23")).toBe("unknown");
    expect(earningsAt(null, "2026-10-01", "2026-10-23")).toBe("unknown");
  });

  it("counts fills per field and keeps the marker through a save and reload", () => {
    const out = backfillAlerts([alert(), alert({ id: `${SENT}-X`, ticker: "ZZZZ" })], inputs());
    expect(out.counts.alerts).toBe(2);
    expect(out.counts.filled.priceVsVwap).toBe(1);
    expect(out.counts.filled.minutesSinceOpen).toBe(2);
    expect(out.counts.notRecoverable.iv).toBe(2);
    const reloaded = parseAlertBook(JSON.stringify({ version: 1, records: out.alerts }));
    const saved = reloaded.records[0];
    expect(saved.features?.backfilled?.fields).toContain("priceVsVwap");
    expect(featuresForAlert(saved).priceVsVwap).toBe("above");
    expect(parseFeatureSnapshot({ ...saved.features, backfilled: { source: "other", at: 1, fields: ["x"] } })?.backfilled).toBeUndefined();
  });

  it("parses Tastytrade earnings payloads", () => {
    expect(parseEarningsReports({ data: { items: [{ "occurred-date": "2026-07-30" }, { "occurred-date": "bad" }] } })).toEqual(["2026-07-30"]);
    const expected = parseExpectedEarnings({ data: { items: [{ symbol: "AAPL", earnings: { "expected-report-date": "2026-11-02" } }, { symbol: "SPY" }] } });
    expect(expected.get("AAPL")).toBe("2026-11-02");
    expect(expected.get("SPY")).toBeNull();
  });
});

describe("underlying candles", () => {
  it("subscribes with the requested period", () => {
    expect(candleSubscriptionSymbol("AAPL", "5m")).toBe("AAPL{=5m}");
    expect(candleSubscriptionSymbol(".TLT261113P77.5")).toBe(".TLT261113P77.5{=1m}");
    const add = (feedMessages([{ streamer: "SPY", fromTime: 1, period: "1d" }])[2] as { add: { symbol: string }[] }).add;
    expect(add[0].symbol).toBe("SPY{=1d}");
  });

  it("keeps equity rows with volume and option rows without it", () => {
    const rows = parseCompactCandles([
      "Candle",
      ["AAPL{=5m}", 1_757_000_000_000, 200, 201, 199, 200.5, 4500, ".TLT261113P77.5{=1m}", 1_757_000_000_000, 1.2, 1.5, 1.1, 1.4, 8],
    ]);
    expect(rows[0]).toEqual({ symbol: "AAPL", t: 1_757_000_000_000, o: 200, h: 201, l: 199, c: 200.5, v: 4500 });
    expect(rows[1]).toEqual({ symbol: ".TLT261113P77.5", t: 1_757_000_000_000, o: 1.2, h: 1.5, l: 1.1, c: 1.4 });
  });
});
