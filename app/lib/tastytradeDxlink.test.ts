import { describe, expect, it, vi } from "vitest";
import type { CandleTransport } from "@/app/lib/tastytradeCandles";
import {
  applyDxlinkOverlay,
  chainFeedMessages,
  collectDxlinkFeed,
  parseAggressorSide,
  parseDxlinkFeedData,
  QUOTE_FIELDS,
  TIME_AND_SALE_FIELDS,
} from "@/app/lib/tastytradeDxlink";
import type { TtQuoteItem } from "@/app/lib/tastytradeMarketParse";
import { getTradeSideDataAvailable, resetTradeSideForTests } from "@/app/lib/marketDataHealth";
import { noteDxlinkTradeSide } from "@/app/lib/tastytradeDxlink";

function scripted(messages: string[]): { transport: CandleTransport; sent: string[] } {
  const sent: string[] = [];
  let index = 0;
  const transport: CandleTransport = {
    send(data) {
      sent.push(data);
    },
    close() {},
    async next() {
      if (index >= messages.length) return "timeout";
      return messages[index++];
    },
  };
  return { transport, sent };
}

const quoteItem: TtQuoteItem = {
  symbol: "SPY   261030C00670000",
  instrumentType: "Equity Option",
  bid: 1,
  ask: 1.1,
  last: 1.05,
  mark: 1.05,
  volume: 10,
  openInterest: 3,
  delta: 0.4,
  volatility: 0.2,
  bidSize: 1,
  askSize: 1,
  updatedAt: null,
  prevClose: null,
};

describe("DXLink chain feed", () => {
  it("asks for Quote, Greeks, Summary, and TimeAndSale, not an order stream", () => {
    const messages = chainFeedMessages([".SPY261030C670"]);
    const setup = messages.find((row) => (row as { type?: string }).type === "FEED_SETUP") as {
      acceptEventFields: Record<string, string[]>;
    };
    expect(Object.keys(setup.acceptEventFields)).toEqual(["Quote", "Greeks", "Summary", "TimeAndSale"]);
    expect(setup.acceptEventFields.Quote).toEqual([...QUOTE_FIELDS]);
    expect(setup.acceptEventFields.TimeAndSale).toEqual([...TIME_AND_SALE_FIELDS]);
    expect(JSON.stringify(messages)).not.toMatch(/\/orders|TimeAndSaleOrder|transactions/i);
  });

  it("reads a compact print with aggressor side and overlays the REST quote", async () => {
    const data = [
      "Quote", [".SPY261030C670", 1.2, 1.3, 8, 9],
      "Greeks", [".SPY261030C670", 0.25, 0.41, 0.02, -0.03, 0.11, 0.01],
      "Summary", [".SPY261030C670", 4400],
      "TimeAndSale", [".SPY261030C670", 1_700_000_000_000, 1.25, 4, "BUY"],
    ];
    const parsed = parseDxlinkFeedData(data);
    expect(parsed.prints.get(".SPY261030C670")).toEqual({
      time: 1_700_000_000_000,
      price: 1.25,
      size: 4,
      aggressorSide: "buy",
    });
    expect(parseAggressorSide("SELL")).toBe("sell");
    expect(parseAggressorSide("UNDEFINED")).toBe("unknown");

    const { transport, sent } = scripted([
      JSON.stringify({ type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" }),
      JSON.stringify({ type: "FEED_DATA", channel: 1, data }),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snap = await collectDxlinkFeed(transport, "dxlink-quote-token", [".SPY261030C670"], 3_000);
    expect(snap.tradeSideDataAvailable).toBe("yes");
    expect(snap.summaries.get(".SPY261030C670")?.openInterest).toBe(4400);
    expect(snap.greeks.get(".SPY261030C670")?.gamma).toBe(0.02);
    const overlaid = applyDxlinkOverlay([quoteItem], snap);
    expect(overlaid.items[0].openInterest).toBe(4400);
    expect(overlaid.items[0].gamma).toBe(0.02);
    expect(overlaid.items[0].bid).toBe(1.2);
    expect(overlaid.items[0].aggressorSide).toBe("buy");
    expect(overlaid.trades.get(".SPY261030C670")?.size).toBe(4);
    const logs = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).not.toContain("dxlink-quote-token");
    expect(sent.some((row) => row.includes("TimeAndSale"))).toBe(true);
    warn.mockRestore();
  });

  it("reports trade-side data as no when the feed rejects TimeAndSale", async () => {
    resetTradeSideForTests();
    const { transport } = scripted([
      JSON.stringify({ type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" }),
      JSON.stringify({ type: "ERROR", channel: 1, message: "TimeAndSale is not enabled" }),
    ]);
    const snap = await collectDxlinkFeed(transport, "dxlink-quote-token", [".SPY261030C670"], 3_000);
    expect(snap.tradeSideDataAvailable).toBe("no");
    noteDxlinkTradeSide(snap.tradeSideDataAvailable);
    expect(getTradeSideDataAvailable()).toBe("no");
  });
});
