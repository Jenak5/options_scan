import { afterEach, describe, expect, it, vi } from "vitest";
import type { OptionContract } from "@/app/lib/contract";
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
    const quoted = vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue([{
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
    }]);

    const second = trade({ id: "t_quote_nvda_two", ticker: "NVDA" });
    const quotes = await quoteOpenPaperTrades([
      trade({ id: "t_quote_nvda_one" }),
      second,
      trade({ id: "t_quote_spy_call", ticker: "SPY", strike: 570, putCall: "call", expiration: "2026-10-16" }),
      trade({ id: "t_quote_closed01", closedAt: Date.parse("2026-10-07T18:00:00.000Z") }),
    ]);

    expect(quoted).toHaveBeenCalledTimes(1);
    expect(quoted.mock.calls[0][0]).toEqual(["NVDA  261106P00235000", "SPY   261016C00570000"]);
    expect(quotes.t_quote_nvda_one).toEqual({
      bid: 6.5,
      ask: 6.8,
      mid: 6.65,
      quotedAt: Date.parse("2026-10-08T15:55:00.000Z"),
    });
    expect(quotes.t_quote_nvda_two).toEqual(quotes.t_quote_nvda_one);
    expect(quotes.t_quote_spy_call).toEqual({ bid: 2, ask: 2.1, mid: 2.05, quotedAt: null });
    expect(quotes.t_quote_closed01).toBeUndefined();
    expect(chain).not.toHaveBeenCalled();
    expect(shadowWrite).not.toHaveBeenCalled();
    expect(tradeWrite).not.toHaveBeenCalled();
  });

  it("splits a long list into batches and stops when a batch fails", async () => {
    configure(saved);
    const quoted = vi.spyOn(schwab, "getQuoteEntries").mockImplementation(async (symbols) => {
      if (symbols.length === 1) throw new Error("second batch failed");
      return [{
        symbol: symbols[0],
        contract: contract({ bid: 1.2, ask: 1.4, quoteTime: 1_760_000_000_000 }),
      }];
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
    const quotes = await quoteOpenPaperTrades(trades);
    expect(quoted).toHaveBeenCalledTimes(2);
    expect(quoted.mock.calls[0][0]).toHaveLength(BRIEF_QUOTE_BATCH);
    expect(quoted.mock.calls[1][0]).toHaveLength(1);
    expect(quotes.t_batch_00).toMatchObject({ bid: 1.2, ask: 1.4, mid: 1.3 });
    expect(quotes[`t_batch_${String(BRIEF_QUOTE_BATCH).padStart(2, "0")}`]).toBeUndefined();
  });

  it("returns nothing when Schwab is slow, so the brief can use the stored mark", async () => {
    configure(saved);
    vi.spyOn(schwab, "getQuoteEntries").mockImplementation((_symbols, signal) => new Promise((resolve, reject) => {
      const fail = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    }));
    const quotes = await quoteOpenPaperTrades([trade({ id: "t_quote_timeout" })], 30);
    expect(quotes).toEqual({});
  });

  it("does not call Schwab when nothing is open or Schwab is not configured", async () => {
    configure(saved);
    const quoted = vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue([]);
    expect(await quoteOpenPaperTrades([
      trade({ id: "t_quote_closed02", closedAt: Date.parse("2026-10-07T18:00:00.000Z") }),
    ])).toEqual({});
    delete process.env.SCHWAB_CLIENT_ID;
    expect(await quoteOpenPaperTrades([trade({ id: "t_quote_nvda_off" })])).toEqual({});
    expect(quoted).not.toHaveBeenCalled();
  });

  it("ignores a quote that has no bid and no mid", async () => {
    configure(saved);
    vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue([{
      symbol: "NVDA  261106P00235000",
      contract: contract({ bid: 0, ask: 0.1, quoteTime: null }),
    }]);
    expect(await quoteOpenPaperTrades([trade({ id: "t_quote_empty_bid" })])).toEqual({});
  });
});

function configure(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (!(key in saved)) saved[key] = process.env[key];
  }
  process.env.SCHWAB_CLIENT_ID = "client";
  process.env.SCHWAB_CLIENT_SECRET = "secret";
  process.env.SCHWAB_REDIRECT_URI = "https://example.test/callback";
}
