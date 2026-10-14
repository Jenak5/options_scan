import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Limiter, mapLimit, resetTastytradeMarketForTests, tastytradePeakConcurrency, ttQuotes, withTastytradeAuth } from "@/app/lib/tastytradeMarket";

const ENV = { TASTYTRADE_CLIENT_ID: "id", TASTYTRADE_CLIENT_SECRET: "secret", TASTYTRADE_REFRESH_TOKEN: "refresh" };

function fakeTasty(opts: { badTokens?: Set<string>; expiresIn?: number; oauthDelayMs?: number; failFirst?: number; callDelayMs?: number } = {}) {
  let failed = 0;
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
    if (opts.callDelayMs) await new Promise((r) => setTimeout(r, opts.callDelayMs));
    if (opts.badTokens?.has(token)) return new Response("{}", { status: 401 });
    if (opts.failFirst && failed < opts.failFirst) {
      failed += 1;
      return new Response("{}", { status: 401 });
    }
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

  it("treats a 401 that survives a fresh token as a rate limit and backs off with jitter", async () => {
    const waits: number[] = [];
    resetTastytradeMarketForTests({ sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
    const t = fakeTasty({ failFirst: 2 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ttQuotes({ equity: ["XLF"] }, t.fetchImpl);
    expect(t.calls).toEqual(["t1", "t2", "t2"]);
    expect(t.minted()).toBe(2);
    expect(waits).toEqual([250, 1875]);
    const logs = warn.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => /401 on attempt 2 \(token age \d+s\)/.test(l))).toBe(true);
    expect(logs.some((l) => /treating 401 as rate limit, backing off 1875ms/.test(l))).toBe(true);
    warn.mockRestore();
  });

  it("jitter stays within base to 1.5x base", async () => {
    for (const r of [0, 0.999]) {
      const waits: number[] = [];
      resetTastytradeMarketForTests({ sleep: async (ms) => void waits.push(ms), random: () => r });
      const t = fakeTasty({ failFirst: 3 });
      await ttQuotes({ equity: ["XLF"] }, t.fetchImpl);
      expect(waits[1]).toBeGreaterThanOrEqual(1500);
      expect(waits[1]).toBeLessThanOrEqual(2250);
      expect(waits[2]).toBeGreaterThanOrEqual(3000);
      expect(waits[2]).toBeLessThanOrEqual(4500);
    }
  });

  it("gives up after four 401s so the caller can fall back to Schwab", async () => {
    const t = fakeTasty({ failFirst: 99 });
    await expect(ttQuotes({ equity: ["XLF"] }, t.fetchImpl)).rejects.toThrow("Tastytrade market data request failed (401)");
    expect(t.calls.length).toBe(4);
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

  it("caps Tastytrade requests in flight across parallel tickers", async () => {
    resetTastytradeMarketForTests({ sleep: async () => {}, maxConcurrent: 4 });
    const t = fakeTasty({ callDelayMs: 10 });
    const opts = Array.from({ length: 450 }, (_, i) => `SPY   261030C00${String(600 + i).padStart(3, "0")}000`);
    await Promise.all(["XLF", "GLD", "TLT", "SPY", "QQQ", "IWM"].map(() => ttQuotes({ options: opts }, t.fetchImpl)));
    expect(t.calls.length).toBe(30);
    expect(tastytradePeakConcurrency()).toBe(4);
  });

  it("caps batches per ticker", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBe(2);
  });

  it("Limiter keeps order of results and releases on errors", async () => {
    const lim = new Limiter(1);
    await expect(lim.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await lim.run(async () => 7)).toBe(7);
  });
});
