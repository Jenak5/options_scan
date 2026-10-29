import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactMarketText, parseStoredMarketDataHealth } from "@/app/lib/marketDataHealth";

/**
 * The market-data path is read-only. These files are the provider, the router,
 * the Tastytrade client, and DXLink. Account reads live in app/lib/tastytrade.ts
 * and are not used by the scanner.
 */
const FILES = [
  "app/lib/marketProviders.ts",
  "app/lib/marketData.ts",
  "app/lib/tastytradeMarket.ts",
  "app/lib/tastytradeDxlink.ts",
  "app/lib/tastytradeStore.ts",
  "app/lib/tastytradeCandles.ts",
  "app/lib/dataSourcePref.ts",
];

const BANNED = [
  /\/orders\b/,
  /\/transactions\b/,
  /\/sessions\b/,
  /remember-token/i,
  /remember_token/i,
  /place-order/i,
  /placeOrder/,
  /dry-run/,
  /getLiveOrders/,
];

describe("market data stays off order endpoints", () => {
  it("does not call orders, transactions, or legacy session login", () => {
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const pattern of BANNED) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
    const schwab = readFileSync("app/lib/schwab.ts", "utf8");
    expect(schwab).toMatch(/path: "chains" \| "quotes" \| "pricehistory"/);
    expect(schwab).not.toMatch(/\/trader\/v1/);
  });

  it("strips secrets from a stored status record", () => {
    expect(redactMarketText("failed bearer abc.def token")).toBe("failed bearer [redacted] token");
    const parsed = parseStoredMarketDataHealth({
      primary: "tastytrade",
      preferred: "tastytrade",
      fallbacks: 2,
      lastError: "Tastytrade failed (401) bearer super-secret-access",
      tradeSideDataAvailable: "yes",
      counts: { tastytrade: 3, schwab: 2 },
      active: { chain: "schwab", quotes: "tastytrade" },
      lastTastytradeSuccessAt: "2026-10-29T20:10:00.000Z",
    });
    expect(parsed?.fallbackCount).toBe(2);
    expect(parsed?.lastError).not.toContain("super-secret-access");
    expect(parsed?.tradeSideDataAvailable).toBe("yes");
    expect(parsed?.active.chain).toBe("schwab");
    expect(parsed?.active.quotes).toBe("tastytrade");
    expect(parsed?.lastTastytradeSuccessAt).toBe("2026-10-29T20:10:00.000Z");
  });
});
