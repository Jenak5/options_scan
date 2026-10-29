import type { ChainParseResult, PriceCandle } from "@/app/lib/schwabParse";
import type { QuoteEntriesResult } from "@/app/lib/schwab";
import * as schwab from "@/app/lib/schwab";
import { ttOptionChain, ttPriceHistory, ttQuoteEntries } from "@/app/lib/tastytradeMarket";

/**
 * One read-only market-data surface for the scanner.
 * Chains carry open interest, volume, and Greeks (delta, and gamma, theta,
 * vega, rho when DXLink sent them). Quotes carry the same fields.
 * Price history is candles. Tastytrade is primary. Schwab is the backup.
 *
 * No order, account-write, or transaction calls. GET market data only.
 */

export type ChainInput = Parameters<typeof schwab.getOptionChain>[0];
export type HistoryInput = Parameters<typeof schwab.getPriceHistory>[0];

export interface MarketDataProvider {
  readonly name: "tastytrade" | "schwab";
  getOptionChain(input: ChainInput): Promise<ChainParseResult>;
  getQuoteEntries(symbols: string[], signal?: AbortSignal): Promise<QuoteEntriesResult>;
  getPriceHistory(input: HistoryInput): Promise<PriceCandle[]>;
}

export function createTastytradeProvider(): MarketDataProvider {
  return {
    name: "tastytrade",
    getOptionChain(input) {
      return ttOptionChain(input);
    },
    getQuoteEntries(symbols, signal) {
      return ttQuoteEntries(symbols, signal);
    },
    getPriceHistory(input) {
      return ttPriceHistory(input);
    },
  };
}

export function createSchwabProvider(): MarketDataProvider {
  return {
    name: "schwab",
    getOptionChain(input) {
      return schwab.getOptionChain(input);
    },
    getQuoteEntries(symbols, signal) {
      return schwab.getQuoteEntries(symbols, signal);
    },
    getPriceHistory(input) {
      return schwab.getPriceHistory(input);
    },
  };
}
