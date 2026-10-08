import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionContract } from "@/app/lib/contract";
import { parseQuoteEntries, QUOTE_REJECTED } from "@/app/lib/schwabParse";
import * as schwab from "@/app/lib/schwab";
import * as store from "@/app/lib/schwabStore";
import { BRIEF_QUOTE_BATCH, quoteOpenPaperTrades } from "@/app/lib/tradeQuotes";

const ENV_KEYS = ["SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET", "SCHWAB_REDIRECT_URI"] as const;

function trade(input: {
  id: string;
  ticker?: string;
  strike?: number;
  putCall?: "call" | "put";
  expiration?: string;
  closedAt?: number | null;
}) {
  return {
    id: input.id,
    ticker: input.ticker ?? "NVDA",
    putCall: input.putCall ?? "put",
    strike: input.strike ?? 235,
    expiration: input.expiration ?? "2026-11-06",
    closedAt: input.closedAt ?? null,
  };
}

function contract(over: Partial<OptionContract> = {}): OptionContract {
  return {
    bid: 6.5,
    ask: 6.8,
    last: 6.6,
    volume: 10,
    openInterest: 20,
    delta: null,
    iv: null,
    strike: 235,
    expiration: "2026-11-06",
    putCall: "put",
    quoteTime: Date.parse("2026-10-08T15:55:00.000Z"),
    ...over,
  };
}

describe("quoteOpenPaperTrades", () => {
  const saved: Record<string, string | undefined> = {};
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (!(key in saved)) continue;
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
    vi.restoreAllMocks();
  });

  it("quotes open trades in one batched request and skips a closed trade", async () => {
    configure(saved);
    const chain = vi.spyOn(schwab, "getOptionChain").mockRejectedValue(new Error("no chain"));
    const shadowWrite = vi.spyOn(store, "updateShadowBook");
    const tradeWrite = vi.spyOn(store, "updateTradeLog");
    const quoted = vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue({
      entries: [{
        symbol: "NVDA  261106P00235000",
        contract: contract(),
      }, {
        symbol: "SPY   261016C00570000",
        contract: contract({
          bid: 2,
          ask: 2.1,
          strike: 570,
          expiration: "2026-10-16",
          putCall: "call",
          quoteTime: null,
        }),
      }],
      problem: null,
    });

    const second = trade({ id: "t_quote_nvda_two", ticker: "NVDA" });
    const batch = await quoteOpenPaperTrades([
      trade({ id: "t_quote_nvda_one" }),
      second,
      trade({ id: "t_quote_spy_call", ticker: "SPY", strike: 570, putCall: "call", expiration: "2026-10-16" }),
      trade({ id: "t_quote_closed01", closedAt: Date.parse("2026-10-07T18:00:00.000Z") }),
    ]);

    expect(quoted).toHaveBeenCalledTimes(1);
    expect(quoted.mock.calls[0][0]).toEqual(["NVDA  261106P00235000", "SPY   261016C00570000"]);
    expect(batch.quotes.t_quote_nvda_one).toEqual({
      bid: 6.5,
      ask: 6.8,
      mid: 6.65,
      quotedAt: Date.parse("2026-10-08T15:55:00.000Z"),
    });
    expect(batch.quotes.t_quote_nvda_two).toEqual(batch.quotes.t_quote_nvda_one);
    expect(batch.quotes.t_quote_spy_call).toEqual({ bid: 2, ask: 2.1, mid: 2.05, quotedAt: null });
    expect(batch.quotes.t_quote_closed01).toBeUndefined();
    expect(batch.misses).toEqual({});
    expect(chain).not.toHaveBeenCalled();
    expect(shadowWrite).not.toHaveBeenCalled();
    expect(tradeWrite).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("reads the real Schwab option quote shape onto the open trade", async () => {
    configure(saved);
    const quoteTime = Date.parse("2026-10-08T17:50:00.000Z");
    const entries = parseQuoteEntries({
      "NVDA  261106P00235000": {
        assetMainType: "OPTION",
        symbol: "NVDA  261106P00235000",
        realtime: true,
        reference: {
          contractType: "P",
          expirationDay: 6,
          expirationMonth: 11,
          expirationYear: 2026,
          strikePrice: 235,
          underlying: "NVDA",
        },
        quote: {
          bidPrice: 9.75,
          askPrice: 9.95,
          lastPrice: 9.85,
          quoteTime,
          tradeTime: quoteTime,
          openInterest: 120,
          totalVolume: 40,
          volatility: 32.5,
          delta: -0.42,
        },
      },
    });
    vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue({ entries, problem: null });
    const batch = await quoteOpenPaperTrades([trade({ id: "t_quote_nvda_live" })]);
    expect(batch.quotes.t_quote_nvda_live).toEqual({
      bid: 9.75,
      ask: 9.95,
      mid: 9.85,
      quotedAt: quoteTime,
    });
    expect(batch.misses).toEqual({});
  });

  it("splits a long list into batches and stops when a batch fails", async () => {
    configure(saved);
    const quoted = vi.spyOn(schwab, "getQuoteEntries").mockImplementation(async (symbols) => {
      if (symbols.length === 1) throw new Error("second batch failed");
      return {
        entries: [{
          symbol: symbols[0],
          contract: contract({ bid: 1.2, ask: 1.4, quoteTime: 1_760_000_000_000 }),
        }],
        problem: null,
      };
    });
    const trades = [];
    for (let i = 0; i < BRIEF_QUOTE_BATCH + 1; i++) {
      trades.push(trade({
        id: `t_batch_${String(i).padStart(2, "0")}`,
        ticker: "SPY",
        strike: 100 + i,
        putCall: "call",
        expiration: "2026-10-16",
      }));
    }
    const batch = await quoteOpenPaperTrades(trades);
    const lastId = `t_batch_${String(BRIEF_QUOTE_BATCH).padStart(2, "0")}`;
    expect(quoted).toHaveBeenCalledTimes(2);
    expect(quoted.mock.calls[0][0]).toHaveLength(BRIEF_QUOTE_BATCH);
    expect(quoted.mock.calls[1][0]).toHaveLength(1);
    expect(batch.quotes.t_batch_00).toMatchObject({ bid: 1.2, ask: 1.4, mid: 1.3 });
    expect(batch.quotes[lastId]).toBeUndefined();
    expect(batch.misses[lastId]).toBe("The Schwab quote failed.");
    expect(loggedText(errorLog)).not.toContain("second batch failed");
  });

  it("returns nothing when Schwab is slow, so the brief can use the stored mark", async () => {
    configure(saved);
    vi.spyOn(schwab, "getQuoteEntries").mockImplementation((_symbols, signal) => new Promise((resolve, reject) => {
      const fail = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    }));
    const batch = await quoteOpenPaperTrades([trade({ id: "t_quote_timeout" })], 30);
    expect(batch.quotes).toEqual({});
    expect(batch.misses).toEqual({ t_quote_timeout: "The Schwab quote timed out." });
  });

  it("does not call Schwab when nothing is open or Schwab is not configured", async () => {
    configure(saved);
    const quoted = vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue({ entries: [], problem: null });
    expect(await quoteOpenPaperTrades([
      trade({ id: "t_quote_closed02", closedAt: Date.parse("2026-10-07T18:00:00.000Z") }),
    ])).toEqual({ quotes: {}, misses: {} });
    delete process.env.SCHWAB_CLIENT_ID;
    expect(await quoteOpenPaperTrades([trade({ id: "t_quote_nvda_off" })])).toEqual({
      quotes: {},
      misses: { t_quote_nvda_off: "Schwab is not configured." },
    });
    expect(quoted).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("ignores a quote that has no bid and no mid", async () => {
    configure(saved);
    vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue({
      entries: [{
        symbol: "NVDA  261106P00235000",
        contract: contract({ bid: 0, ask: 0.1, quoteTime: null }),
      }],
      problem: null,
    });
    const batch = await quoteOpenPaperTrades([trade({ id: "t_quote_empty_bid" })]);
    expect(batch.quotes).toEqual({});
    expect(batch.misses).toEqual({
      t_quote_empty_bid: "Schwab returned a quote with no bid and no mid.",
    });
  });

  it("keeps a rejected symbol out of the quote and out of the log secrets", async () => {
    configure(saved);
    vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue({
      entries: [],
      problem: QUOTE_REJECTED,
    });
    const batch = await quoteOpenPaperTrades([trade({ id: "t_quote_rejected" })]);
    expect(batch.quotes).toEqual({});
    expect(batch.misses.t_quote_rejected).toBe(QUOTE_REJECTED);
    const http = vi.spyOn(schwab, "getQuoteEntries").mockRejectedValue(
      new Error("Schwab market data request failed (400) access_token=super-secret"),
    );
    const failed = await quoteOpenPaperTrades([trade({ id: "t_quote_http" })]);
    expect(http).toHaveBeenCalled();
    expect(failed.misses.t_quote_http).toBe("Schwab market data request failed (400).");
    const text = loggedText(errorLog);
    expect(text).toContain("Brief quote missing for NVDA  261106P00235000: Schwab rejected the option symbol.");
    expect(text).toContain("Schwab market data request failed (400).");
    expect(text.includes("super-secret")).toBe(false);
    expect(text.includes("access_token")).toBe(false);
  });
});

function loggedText(errorLog: ReturnType<typeof vi.spyOn>): string {
  return errorLog.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function configure(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (!(key in saved)) saved[key] = process.env[key];
  }
  process.env.SCHWAB_CLIENT_ID = "client";
  process.env.SCHWAB_CLIENT_SECRET = "secret";
  process.env.SCHWAB_REDIRECT_URI = "https://example.test/callback";
}
