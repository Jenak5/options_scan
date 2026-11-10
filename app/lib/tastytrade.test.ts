import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, getBalances, probeTastytrade, tastytradeEnabled } from "@/app/lib/tastytrade";

const KEYS = [
  "TASTYTRADE_ENABLED",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
  "TASTYTRADE_ACCOUNT_NUMBER",
] as const;

describe("tastytrade flag", () => {
  afterEach(() => {
    for (let i = 0; i < KEYS.length; i++) delete process.env[KEYS[i]];
    vi.restoreAllMocks();
  });

  it("stays off unless the flag and the three values are set", () => {
    expect(tastytradeEnabled()).toBe(false);
    process.env.TASTYTRADE_ENABLED = "true";
    expect(tastytradeEnabled()).toBe(false);
    process.env.TASTYTRADE_CLIENT_SECRET = "secret";
    process.env.TASTYTRADE_REFRESH_TOKEN = "refresh";
    process.env.TASTYTRADE_ACCOUNT_NUMBER = "account";
    expect(tastytradeEnabled()).toBe(true);
    process.env.TASTYTRADE_ENABLED = "TRUE";
    expect(tastytradeEnabled()).toBe(false);
    process.env.TASTYTRADE_ENABLED = "true";
    process.env.TASTYTRADE_ACCOUNT_NUMBER = "  ";
    expect(tastytradeEnabled()).toBe(false);
  });

  it("sends cache no-store on the OAuth token and the account read", async () => {
    process.env.TASTYTRADE_ENABLED = "true";
    process.env.TASTYTRADE_CLIENT_SECRET = "secret";
    process.env.TASTYTRADE_REFRESH_TOKEN = "refresh-token-value";
    process.env.TASTYTRADE_ACCOUNT_NUMBER = "account";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await authenticate();
    await getBalances();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ cache: "no-store" });
    }
    const logs = [...warn.mock.calls, ...info.mock.calls, ...error.mock.calls].map((call) => String(call[0])).join(" ");
    expect(logs).not.toContain("refresh-token-value");
    expect(logs).not.toContain("access-token");
  });

  it("does not call Tastytrade when the flag is off", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    process.env.TASTYTRADE_CLIENT_SECRET = "secret";
    process.env.TASTYTRADE_REFRESH_TOKEN = "refresh";
    process.env.TASTYTRADE_ACCOUNT_NUMBER = "account";
    const result = await probeTastytrade();
    expect(result.status).toBeNull();
    expect(result.message).toMatch(/isn't connected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
