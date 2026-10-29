import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Limiter, mapLimit, resetTastytradeMarketForTests, tastytradePeakConcurrency, ttQuotes, TT_MAX_CONCURRENT, withTastytradeAuth } from "@/app/lib/tastytradeMarket";
import { writeStoredTastytradeAccess } from "@/app/lib/tastytradeStore";

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

  it("refreshes once on a 401 and then gives up so the caller can fall back", async () => {
    const waits: number[] = [];
    resetTastytradeMarketForTests({ sleep: async (ms) => void waits.push(ms) });
    const t = fakeTasty({ failFirst: 99 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ttQuotes({ equity: ["XLF"] }, t.fetchImpl)).rejects.toThrow("Tastytrade market data request failed (401)");
    expect(t.calls).toEqual(["t1", "t2"]);
    expect(t.minted()).toBe(2);
    expect(waits).toEqual([250]);
    const logs = warn.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => /401 on attempt 2 \(token age \d+s\)/.test(l))).toBe(true);
    expect(logs.some((l) => /still 401 after one refresh/.test(l))).toBe(true);
    expect(logs.some((l) => /rate limit/.test(l))).toBe(false);
    warn.mockRestore();
  });

  it("reuses a cached access token and does not print it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await writeStoredTastytradeAccess({
      access: "stored-access-token",
      mintedAt: Date.now(),
      expiresAt: Date.now() + 10 * 60_000,
    });
    const t = fakeTasty();
    await ttQuotes({ equity: ["SPY"] }, t.fetchImpl);
    expect(t.minted()).toBe(0);
    expect(t.calls).toEqual(["stored-access-token"]);
    const logs = [...warn.mock.calls, ...info.mock.calls].map((c) => String(c[0])).join(" ");
    expect(logs).not.toContain("stored-access-token");
    warn.mockRestore();
    info.mockRestore();
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
    const t = fakeTasty({ callDelayMs: 10 });
    const opts = Array.from({ length: 450 }, (_, i) => `SPY   261030C00${String(600 + i).padStart(3, "0")}000`);
    await Promise.all(["XLF", "GLD", "TLT", "SPY", "QQQ", "IWM"].map(() => ttQuotes({ options: opts }, t.fetchImpl)));
    expect(t.calls.length).toBe(30);
    expect(tastytradePeakConcurrency()).toBe(TT_MAX_CONCURRENT);
    expect(TT_MAX_CONCURRENT).toBe(2);
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
