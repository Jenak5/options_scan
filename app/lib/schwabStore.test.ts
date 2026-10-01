import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTokens } from "@/app/lib/schwabParse";
import {
  clearMemoryStoreForTests,
  decryptTokenPayload,
  encryptTokenPayload,
  readTokens,
  resolveStoreKind,
  writeTokens,
} from "@/app/lib/schwabStore";

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SESSION_SECRET",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearMemoryStoreForTests();
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("network");
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearMemoryStoreForTests();
  vi.restoreAllMocks();
});

const tokens: StoredTokens = {
  accessToken: "fixture-access",
  refreshToken: "fixture-refresh",
  accessExpiresAt: 1_700_000_000_000,
  refreshExpiresAt: 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000,
};

describe("token store", () => {
  it("keeps tokens in memory when KV is not configured", async () => {
    expect(resolveStoreKind()).toBe("memory");
    expect(await readTokens()).toBeNull();
    await writeTokens(tokens);
    expect(await readTokens()).toEqual(tokens);
  });

  it("selects KV when the REST env vars are present and does not call it", () => {
    process.env.KV_REST_API_URL = "https://example.invalid";
    process.env.KV_REST_API_TOKEN = "fixture-store-token";
    expect(resolveStoreKind()).toBe("kv");
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fixture-store-token";
    expect(resolveStoreKind()).toBe("kv");
  });

  it("encrypts the payload so the token text is not stored in the clear", async () => {
    process.env.SESSION_SECRET = "unit-test-session-secret";
    const json = JSON.stringify(tokens);
    const cipher = await encryptTokenPayload(json);
    expect(cipher.includes("fixture-access")).toBe(false);
    expect(cipher.includes("fixture-refresh")).toBe(false);
    expect(await decryptTokenPayload(cipher)).toBe(json);
  });
});
