import { BlobPreconditionFailedError } from "@vercel/blob";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "@/app/lib/schwab";
import { TOKEN_URL, type StoredTokens } from "@/app/lib/schwabParse";
import { SCHWAB_BLOB_TOKEN_PATH } from "@/app/lib/schwabStorage";
import {
  clearMemoryStoreForTests,
  encryptTokenPayload,
  readTokens,
  setSchwabBlobClientForTests,
  writeTokens,
  type SchwabBlobClient,
  type SchwabBlobGetOptions,
  type SchwabBlobGetResult,
  type SchwabBlobPutOptions,
} from "@/app/lib/schwabStore";

const ENV_KEYS = [
  "BLOB_READ_WRITE_TOKEN",
  "SESSION_SECRET",
  "SCHWAB_CLIENT_ID",
  "SCHWAB_CLIENT_SECRET",
  "SCHWAB_REDIRECT_URI",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

const saved: Record<string, string | undefined> = {};

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createBlobMock() {
  const files = new Map<string, { body: string; etag: string }>();
  let seq = 0;
  const read = async (pathname: string): Promise<SchwabBlobGetResult | null> => {
    const existing = files.get(pathname);
    if (!existing) return null;
    return {
      statusCode: 200,
      stream: textStream(existing.body),
      blob: { etag: existing.etag, pathname },
    };
  };
  const put = vi.fn(async (pathname: string, body: string, options: SchwabBlobPutOptions) => {
    const existing = files.get(pathname);
    if (options.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
      throw new BlobPreconditionFailedError();
    }
    seq += 1;
    const etag = `etag-${seq}`;
    files.set(pathname, { body, etag });
    return { pathname, etag };
  });
  const get = vi.fn(async (pathname: string, _options: SchwabBlobGetOptions) => read(pathname));
  const del = vi.fn(async () => undefined);
  const client: SchwabBlobClient = { put, get, del };
  return { client, put, get, files, read };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearMemoryStoreForTests();
  process.env.BLOB_READ_WRITE_TOKEN = "fixture-blob-token";
  process.env.SESSION_SECRET = "unit-test-session-secret";
  process.env.SCHWAB_CLIENT_ID = "fixture-client";
  process.env.SCHWAB_CLIENT_SECRET = "fixture-secret";
  process.env.SCHWAB_REDIRECT_URI = "https://example.invalid/api/schwab/callback";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearMemoryStoreForTests();
  setSchwabBlobClientForTests(null);
  vi.restoreAllMocks();
});

describe("access-token refresh against blob", () => {
  it("uses a fresher stored access token instead of refreshing a stale read", async () => {
    const mock = createBlobMock();
    setSchwabBlobClientForTests(mock.client);
    const now = Date.now();
    const stale: StoredTokens = {
      accessToken: "fixture-access-stale",
      refreshToken: "fixture-refresh",
      accessExpiresAt: now - 10_000,
      refreshExpiresAt: now + 5 * 24 * 60 * 60 * 1000,
    };
    await writeTokens(stale);
    const fresh: StoredTokens = {
      ...stale,
      accessToken: "fixture-access-fresh",
      accessExpiresAt: now + 20 * 60 * 1000,
    };
    const cipher = await encryptTokenPayload(JSON.stringify(fresh));
    const body = JSON.stringify({
      cipher,
      alerts: { expiryAlertAt: null, refreshFailAlertAt: null },
    });
    let reads = 0;
    mock.get.mockImplementation(async (pathname: string) => {
      reads += 1;
      if (reads === 2) mock.files.set(pathname, { body, etag: "etag-fresh" });
      return mock.read(pathname);
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Schwab should not be called");
    });

    expect(await getAccessToken()).toBe("fixture-access-fresh");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mock.put).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer stored token when the refresh request fails", async () => {
    const mock = createBlobMock();
    setSchwabBlobClientForTests(mock.client);
    const now = Date.now();
    const stale: StoredTokens = {
      accessToken: "fixture-access-stale",
      refreshToken: "fixture-refresh",
      accessExpiresAt: now - 10_000,
      refreshExpiresAt: now + 5 * 24 * 60 * 60 * 1000,
    };
    await writeTokens(stale);
    const fresh: StoredTokens = {
      ...stale,
      accessToken: "fixture-access-fresh",
      refreshToken: "fixture-refresh-fresh",
      accessExpiresAt: now + 20 * 60 * 1000,
    };
    const cipher = await encryptTokenPayload(JSON.stringify(fresh));
    const body = JSON.stringify({
      cipher,
      alerts: { expiryAlertAt: null, refreshFailAlertAt: null },
    });
    let reads = 0;
    mock.get.mockImplementation(async (pathname: string) => {
      reads += 1;
      if (reads >= 3) mock.files.set(pathname, { body, etag: "etag-fresh" });
      return mock.read(pathname);
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe(TOKEN_URL);
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
    });

    expect(await getAccessToken()).toBe("fixture-access-fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readTokens()).toEqual(fresh);
    const stored = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body ?? "";
    expect(stored.includes("fixture-access-fresh")).toBe(false);
    expect(stored.includes("fixture-refresh-fresh")).toBe(false);
  });

  it("persists a rotated refresh token from a successful refresh", async () => {
    const mock = createBlobMock();
    setSchwabBlobClientForTests(mock.client);
    const now = Date.now();
    const stale: StoredTokens = {
      accessToken: "fixture-access-stale",
      refreshToken: "fixture-refresh",
      accessExpiresAt: now - 10_000,
      refreshExpiresAt: now + 5 * 24 * 60 * 60 * 1000,
    };
    await writeTokens(stale);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(TOKEN_URL);
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("fixture-refresh");
      return new Response(JSON.stringify({
        access_token: "fixture-access-rotated",
        refresh_token: "fixture-refresh-rotated",
        expires_in: 1800,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    expect(await getAccessToken()).toBe("fixture-access-rotated");
    const saved = await readTokens();
    expect(saved?.refreshToken).toBe("fixture-refresh-rotated");
    expect(saved?.accessToken).toBe("fixture-access-rotated");
    const stored = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body ?? "";
    expect(stored.includes("fixture-access-rotated")).toBe(false);
    expect(stored.includes("fixture-refresh-rotated")).toBe(false);
    const lastPut = mock.put.mock.calls[mock.put.mock.calls.length - 1];
    expect(lastPut[0]).toBe(SCHWAB_BLOB_TOKEN_PATH);
    expect(lastPut[2].ifMatch).toEqual(expect.any(String));
    expect(lastPut[2].allowOverwrite).toBe(true);
    expect(lastPut[2].addRandomSuffix).toBe(false);
  });
});
