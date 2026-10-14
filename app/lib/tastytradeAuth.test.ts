import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTastytradeMarketForTests, ttQuotes, withTastytradeAuth } from "@/app/lib/tastytradeMarket";

const ENV = { TASTYTRADE_CLIENT_ID: "id", TASTYTRADE_CLIENT_SECRET: "secret", TASTYTRADE_REFRESH_TOKEN: "refresh" };

function fakeTasty(opts: { badTokens?: Set<string>; expiresIn?: number; oauthDelayMs?: number } = {}) {
  let minted = 0;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/oauth/token")) {
      minted += 1;
      if (opts.oauthDelayMs) await new Promise((r) => setTimeout(r, opts.oauthDelayMs));
      return new Response(JSON.stringify({ access_token: `t${minted}`, expires_in: opts.expiresIn ?? 900 }), { status: 200 });
    }
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const token = auth.replace("Bearer ", "");
    calls.push(token);
    if (opts.badTokens?.has(token)) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, minted: () => minted, calls };
}

describe("Tastytrade auth", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    resetTastytradeMarketForTests({ sleep: async () => {} });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("shares one refresh across parallel callers", async () => {
    const t = fakeTasty({ oauthDelayMs: 20 });
    await Promise.all(Array.from({ length: 8 }, () => ttQuotes({ equity: ["SPY"] }, t.fetchImpl)));
    expect(t.minted()).toBe(1);
    expect(new Set(t.calls)).toEqual(new Set(["t1"]));
  });

  it("reuses the token until a minute before expires_in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = fakeTasty({ expiresIn: 900 });
    await ttQuotes({ equity: ["SPY"] }, t.fetchImpl);
    vi.setSystemTime(Date.now() + 830_000);
    await ttQuotes({ equity: ["SPY"] }, t.fetchImpl);
    expect(t.minted()).toBe(1);
    vi.setSystemTime(Date.now() + 20_000);
    await ttQuotes({ equity: ["SPY"] }, t.fetchImpl);
    expect(t.minted()).toBe(2);
  });

  it("refreshes and retries on a 401, then succeeds", async () => {
    const t = fakeTasty({ badTokens: new Set(["t1"]) });
    await ttQuotes({ equity: ["XLF"] }, t.fetchImpl);
    expect(t.calls).toEqual(["t1", "t2"]);
  });

  it("retries twice when a fresh token also gets a 401", async () => {
    const t = fakeTasty({ badTokens: new Set(["t1", "t2"]) });
    await ttQuotes({ equity: ["XLF"] }, t.fetchImpl);
    expect(t.calls).toEqual(["t1", "t2", "t3"]);
  });

  it("gives up after three 401s with the same error text as before", async () => {
    const t = fakeTasty({ badTokens: new Set(["t1", "t2", "t3"]) });
    await expect(ttQuotes({ equity: ["XLF"] }, t.fetchImpl)).rejects.toThrow("Tastytrade market data request failed (401)");
  });

  it("parallel 401s on one token mint only one replacement", async () => {
    const t = fakeTasty({ badTokens: new Set(["t1"]), oauthDelayMs: 10 });
    await Promise.all(Array.from({ length: 5 }, () => ttQuotes({ equity: ["SPY"] }, t.fetchImpl)));
    expect(t.minted()).toBe(2);
  });

  it("does not drop a newer token when an old one gets a 401", async () => {
    const t = fakeTasty();
    let first = true;
    const seen: string[] = [];
    await withTastytradeAuth("x", t.fetchImpl, async (access) => {
      seen.push(access);
      if (first) {
        first = false;
        return { status: 401 };
      }
      return { status: 200, value: 1 };
    });
    expect(seen).toEqual(["t1", "t2"]);
    await withTastytradeAuth("x", t.fetchImpl, async (access) => ({ status: 200, value: access }));
    expect(t.minted()).toBe(2);
  });
});
