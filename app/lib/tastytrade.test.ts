import { afterEach, describe, expect, it, vi } from "vitest";
import { probeTastytrade, tastytradeEnabled } from "@/app/lib/tastytrade";

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
