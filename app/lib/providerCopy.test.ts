import { describe, expect, it } from "vitest";
import { flowPageFailure } from "@/app/lib/flowPageError";
import { preferredDataSource } from "@/app/lib/dataSourcePref";
import { delayedChainDetail, namedSource, providerFailureText } from "@/app/lib/providerCopy";
import { BothSourcesFailedError } from "@/app/lib/marketData";

const tasty = {
  MARKET_DATA_PRIMARY: "tastytrade",
  TASTYTRADE_CLIENT_ID: "id",
  TASTYTRADE_CLIENT_SECRET: "secret",
  TASTYTRADE_REFRESH_TOKEN: "refresh",
};

describe("provider copy", () => {
  it("names Tastytrade for a timeout and does not tell the reader to reconnect Schwab", () => {
    const previous = process.env.DATA_SOURCE;
    const primary = process.env.MARKET_DATA_PRIMARY;
    const id = process.env.TASTYTRADE_CLIENT_ID;
    const secret = process.env.TASTYTRADE_CLIENT_SECRET;
    const refresh = process.env.TASTYTRADE_REFRESH_TOKEN;
    process.env.DATA_SOURCE = undefined;
    Object.assign(process.env, tasty);
    try {
      expect(namedSource()).toBe("Tastytrade");
      expect(namedSource() === "Tastytrade").toBe(preferredDataSource() === "tastytrade");
      expect(namedSource({ DATA_SOURCE: "schwab" })).toBe("Schwab");
      expect(preferredDataSource({ DATA_SOURCE: "schwab" })).toBe("schwab");
      expect(providerFailureText(new Error("DXLink fetch exceeded 200 s"))).toBe("Tastytrade timed out.");
      expect(providerFailureText(new Error("socket closed"))).toBe("Tastytrade market data request failed.");
      expect(delayedChainDetail()).toBe("Tastytrade marked this chain delayed. Real-time data is required.");
      const both = new BothSourcesFailedError("SPXW", "Tastytrade timed out", "Schwab backup returned 400");
      expect(providerFailureText(both)).toBe("SPXW skipped: Tastytrade timed out; Schwab backup returned 400");
      expect(providerFailureText(new Error("nope"))).not.toMatch(/Reconnect Schwab/);
    } finally {
      process.env.DATA_SOURCE = previous;
      if (primary === undefined) delete process.env.MARKET_DATA_PRIMARY;
      else process.env.MARKET_DATA_PRIMARY = primary;
      if (id === undefined) delete process.env.TASTYTRADE_CLIENT_ID;
      else process.env.TASTYTRADE_CLIENT_ID = id;
      if (secret === undefined) delete process.env.TASTYTRADE_CLIENT_SECRET;
      else process.env.TASTYTRADE_CLIENT_SECRET = secret;
      if (refresh === undefined) delete process.env.TASTYTRADE_REFRESH_TOKEN;
      else process.env.TASTYTRADE_REFRESH_TOKEN = refresh;
    }
  });
});

describe("flow page errors", () => {
  it("offers Reconnect Schwab only when the response includes that link", () => {
    expect(flowPageFailure(409, {
      connected: false,
      error: "Schwab is not connected. Use Reconnect Schwab.",
      reconnect: "/api/schwab/connect",
    })).toEqual({
      kind: "reconnect",
      href: "/api/schwab/connect",
      message: "Schwab is not connected. Use Reconnect Schwab.",
    });
    expect(flowPageFailure(503, { error: "Tastytrade timed out." })).toEqual({
      kind: "error",
      message: "Tastytrade timed out.",
    });
    expect(flowPageFailure(502, { connected: true, error: "Tastytrade market data request failed. Tap Refresh to retry." })).toEqual({
      kind: "error",
      message: "Tastytrade market data request failed. Tap Refresh to retry.",
    });
    const plain = flowPageFailure(503, {});
    expect(plain?.kind).toBe("error");
    if (plain?.kind === "error") expect(plain.message).not.toMatch(/Schwab/);
    expect(flowPageFailure(200, { connected: true })).toBeNull();
  });
});
