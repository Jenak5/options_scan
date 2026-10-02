import { BlobPreconditionFailedError } from "@vercel/blob";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTokens } from "@/app/lib/schwabParse";
import {
  SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
  SCHWAB_BLOB_FLOW_PATH,
  SCHWAB_BLOB_TOKEN_PATH,
} from "@/app/lib/schwabStorage";
import {
  clearMemoryStoreForTests,
  commitRefreshedTokens,
  decryptTokenPayload,
  encryptTokenPayload,
  readAlertMeta,
  readFlowSnapshots,
  readTokens,
  resolveStoreKind,
  setSchwabBlobClientForTests,
  writeAlertMeta,
  writeFlowSnapshots,
  writeTokens,
  type SchwabBlobClient,
  type SchwabBlobGetOptions,
  type SchwabBlobGetResult,
  type SchwabBlobPutOptions,
} from "@/app/lib/schwabStore";

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
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
  setSchwabBlobClientForTests(null);
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

  it("refuses in-memory storage in production when KV, Upstash, and Blob are unset", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVercel = process.env.VERCEL;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.VERCEL;
      expect(resolveStoreKind()).toBe("unconfigured");
      await expect(writeTokens(tokens)).rejects.toThrow(/storage is not configured/);
      expect(await readTokens()).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();

      process.env.NODE_ENV = "test";
      process.env.VERCEL = "1";
      expect(resolveStoreKind()).toBe("unconfigured");

      process.env.BLOB_READ_WRITE_TOKEN = "fixture-blob-token";
      expect(resolveStoreKind()).toBe("blob");

      process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
      process.env.UPSTASH_REDIS_REST_TOKEN = "fixture-store-token";
      expect(resolveStoreKind()).toBe("kv");

      process.env.KV_REST_API_URL = "https://example.invalid";
      process.env.KV_REST_API_TOKEN = "fixture-store-token";
      expect(resolveStoreKind()).toBe("kv");
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }
  });

  it("keeps flow volume snapshots in memory without calling the network", async () => {
    expect(await readFlowSnapshots()).toEqual({});
    await writeFlowSnapshots({
      QQQ: { scannedAt: 1_700_000_000_000, volumes: { "2026-10-08|500|put": 120 } },
    });
    expect((await readFlowSnapshots()).QQQ.volumes["2026-10-08|500|put"]).toBe(120);
    await writeFlowSnapshots({
      SPY: { scannedAt: 1_700_000_000_100, volumes: { "2026-10-08|105|call": 10 } },
    });
    const book = await readFlowSnapshots();
    expect(book.QQQ.volumes["2026-10-08|500|put"]).toBe(120);
    expect(book.SPY.volumes["2026-10-08|105|call"]).toBe(10);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps quote points and drops a point that is not a quote", async () => {
    await writeFlowSnapshots({
      SPY: {
        scannedAt: 1_700_000_000_000,
        volumes: { "2026-10-08|105|call": 10 },
        quotes: {
          "2026-10-08|105|call": [
            { at: 1, volume: 4, last: 1.2, lastSize: 2, bid: 1.1, ask: 1.3, tradeTime: 50 },
            { at: Number.NaN, volume: 1, last: null, lastSize: null, bid: null, ask: null, tradeTime: null },
          ],
        },
      },
    });
    const points = (await readFlowSnapshots()).SPY.quotes?.["2026-10-08|105|call"];
    expect(points).toEqual([
      { at: 1, volume: 4, last: 1.2, lastSize: 2, bid: 1.1, ask: 1.3, tradeTime: 50 },
    ]);
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

describe("blob token store", () => {
  let mock: ReturnType<typeof createBlobMock>;

  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = "fixture-blob-token";
    process.env.SESSION_SECRET = "unit-test-session-secret";
    mock = createBlobMock();
    setSchwabBlobClientForTests(mock.client);
  });

  it("stores an encrypted envelope with private blob options and reads it back", async () => {
    expect(resolveStoreKind()).toBe("blob");
    await writeTokens(tokens);
    expect(await readTokens()).toEqual(tokens);

    const putCall = mock.put.mock.calls[0];
    expect(putCall[0]).toBe(SCHWAB_BLOB_TOKEN_PATH);
    expect(putCall[2]).toMatchObject({
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: SCHWAB_BLOB_CACHE_CONTROL_MAX_AGE,
      contentType: "application/json",
      token: "fixture-blob-token",
    });
    expect(putCall[2].ifMatch).toBeUndefined();

    const getCall = mock.get.mock.calls[0];
    expect(getCall[0]).toBe(SCHWAB_BLOB_TOKEN_PATH);
    expect(getCall[1]).toMatchObject({
      access: "private",
      useCache: false,
      token: "fixture-blob-token",
    });

    const stored = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body ?? "";
    expect(stored.includes("fixture-access")).toBe(false);
    expect(stored.includes("fixture-refresh")).toBe(false);
    expect(mock.del).not.toHaveBeenCalled();
  });

  it("prefers a complete KV pair over Upstash and Blob, and Blob when Redis pairs are incomplete", () => {
    process.env.KV_REST_API_URL = "https://example.invalid";
    expect(resolveStoreKind()).toBe("blob");
    process.env.UPSTASH_REDIS_REST_TOKEN = "fixture-store-token";
    expect(resolveStoreKind()).toBe("blob");
    process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
    expect(resolveStoreKind()).toBe("kv");
    process.env.KV_REST_API_TOKEN = "fixture-store-token";
    expect(resolveStoreKind()).toBe("kv");
  });

  it("does not call Blob when the KV pair is selected", async () => {
    process.env.KV_REST_API_URL = "https://example.invalid";
    process.env.KV_REST_API_TOKEN = "fixture-store-token";
    await expect(writeTokens(tokens)).rejects.toThrow(/network/);
    expect(mock.put).not.toHaveBeenCalled();
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.del).not.toHaveBeenCalled();
  });

  it("deletes an unreadable blob before writing a new encrypted envelope", async () => {
    mock.seed(SCHWAB_BLOB_TOKEN_PATH, "not-json");
    await writeTokens(tokens);
    expect(mock.del).toHaveBeenCalledWith(SCHWAB_BLOB_TOKEN_PATH, {
      token: "fixture-blob-token",
      ifMatch: expect.any(String),
    });
    expect(await readTokens()).toEqual(tokens);
    const stored = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body ?? "";
    expect(stored.includes("fixture-access")).toBe(false);
  });

  it("keeps alert metadata when the token envelope is replaced", async () => {
    await writeTokens(tokens);
    await writeAlertMeta({ expiryAlertAt: 42, refreshFailAlertAt: null });
    await writeTokens({ ...tokens, accessToken: "fixture-access-2" });
    expect(await readAlertMeta()).toEqual({ expiryAlertAt: 42, refreshFailAlertAt: null });
    expect(await readTokens()).toEqual({ ...tokens, accessToken: "fixture-access-2" });
    expect(mock.put.mock.calls[1][2].ifMatch).toEqual(expect.any(String));
  });

  it("re-reads and does not overwrite a newer refresh token", async () => {
    await writeTokens(tokens);
    const next: StoredTokens = {
      ...tokens,
      accessToken: "fixture-access-next",
      refreshToken: "fixture-refresh-next",
      accessExpiresAt: tokens.accessExpiresAt + 1_000,
    };
    const newer: StoredTokens = {
      ...tokens,
      accessToken: "fixture-access-newer",
      refreshToken: "fixture-refresh-newer",
      accessExpiresAt: tokens.accessExpiresAt + 5_000,
    };
    const cipher = await encryptTokenPayload(JSON.stringify(newer));
    const won = JSON.stringify({
      cipher,
      alerts: { expiryAlertAt: null, refreshFailAlertAt: null },
    });
    mock.put.mockImplementationOnce(async () => {
      mock.files.set(SCHWAB_BLOB_TOKEN_PATH, { body: won, etag: "etag-won" });
      throw new BlobPreconditionFailedError();
    });

    const saved = await commitRefreshedTokens(tokens, next);
    expect(saved).toEqual(newer);
    expect(await readTokens()).toEqual(newer);
    const stored = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body ?? "";
    expect(stored.includes("fixture-refresh-next")).toBe(false);
    expect(stored.includes("fixture-refresh-newer")).toBe(false);
    expect(mock.put).toHaveBeenCalledTimes(2);
  });

  it("writes the refresh when the stored etag still matches", async () => {
    await writeTokens(tokens);
    await writeAlertMeta({ expiryAlertAt: 7, refreshFailAlertAt: 8 });
    const etag = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.etag;
    const next: StoredTokens = {
      ...tokens,
      accessToken: "fixture-access-next",
      refreshToken: "fixture-refresh-next",
      accessExpiresAt: tokens.accessExpiresAt + 1_000,
    };
    const putsBefore = mock.put.mock.calls.length;
    const saved = await commitRefreshedTokens(tokens, next);
    expect(saved).toEqual(next);
    expect(await readTokens()).toEqual(next);
    expect(await readAlertMeta()).toEqual({ expiryAlertAt: 7, refreshFailAlertAt: 8 });
    const options = mock.put.mock.calls[putsBefore][2];
    expect(options.ifMatch).toBe(etag);
    expect(options.allowOverwrite).toBe(true);
    expect(options.addRandomSuffix).toBe(false);
    expect(options.access).toBe("private");
    const stored = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body ?? "";
    expect(stored.includes("fixture-refresh-next")).toBe(false);
  });

  it("stores volume snapshots on a separate pathname and leaves the token blob alone", async () => {
    await writeTokens(tokens);
    const tokenBody = mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body;
    await writeFlowSnapshots({
      SPY: { scannedAt: 1_700_000_000_000, volumes: { "2026-10-08|105|call": 400 } },
    });
    expect(mock.files.get(SCHWAB_BLOB_TOKEN_PATH)?.body).toBe(tokenBody);
    const flowBody = mock.files.get(SCHWAB_BLOB_FLOW_PATH)?.body ?? "";
    expect(flowBody).toContain("2026-10-08|105|call");
    expect(flowBody.includes("fixture-access")).toBe(false);
    const book = await readFlowSnapshots();
    expect(book.SPY.volumes["2026-10-08|105|call"]).toBe(400);
    const flowPut = mock.put.mock.calls.find((call) => call[0] === SCHWAB_BLOB_FLOW_PATH);
    expect(flowPut?.[2]).toMatchObject({
      access: "private",
      token: "fixture-blob-token",
      addRandomSuffix: false,
    });
  });

  it("uses the strong etag from head when get returns a different weak etag", async () => {
    await writeFlowSnapshots({
      SPY: { scannedAt: 1_700_000_000_000, volumes: { "2026-10-08|105|call": 1 } },
    });
    const strong = mock.files.get(SCHWAB_BLOB_FLOW_PATH)?.etag ?? "";
    mock.get.mockImplementation(async (pathname: string) => {
      const result = await mock.read(pathname);
      if (!result) return result;
      return { ...result, blob: { ...result.blob, etag: 'W/"compressed-body-hash"' } };
    });
    await writeFlowSnapshots({
      SPY: { scannedAt: 1_700_000_000_001, volumes: { "2026-10-08|105|call": 2 } },
    });
    const puts = mock.put.mock.calls.filter((call) => call[0] === SCHWAB_BLOB_FLOW_PATH);
    expect(puts[puts.length - 1][2].ifMatch).toBe(strong);
    expect(puts[puts.length - 1][2].ifMatch).not.toBe('"compressed-body-hash"');
    expect(String(puts[puts.length - 1][2].ifMatch).startsWith("W/")).toBe(false);
    expect((await readFlowSnapshots()).SPY.volumes["2026-10-08|105|call"]).toBe(2);
  });

  it("logs the blob error message and status when a snapshot put fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mock.put.mockRejectedValue(Object.assign(new Error("Vercel Blob: Access denied, please provide a valid token for this resource. vercel_blob_rw_secret"), { status: 403 }));
    await writeFlowSnapshots({
      SPY: { scannedAt: 1_700_000_000_000, volumes: { "2026-10-08|105|call": 1 } },
    });
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line.startsWith("Flow snapshot store could not be written:")).toBe(true);
    expect(line).toContain("Access denied");
    expect(line).toContain("status 403");
    expect(line.includes("vercel_blob_rw_secret")).toBe(false);
    expect(line).toContain("[token]");
    spy.mockRestore();
  });

  it("does not put when the blob read fails", async () => {
    mock.get.mockImplementation(async () => {
      throw new Error("blob down");
    });
    await expect(writeTokens(tokens)).rejects.toThrow(/could not be read/);
    expect(mock.put).not.toHaveBeenCalled();
    expect(mock.del).not.toHaveBeenCalled();
  });
});

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
  const del = vi.fn(async (pathname: string, options?: { ifMatch?: string }) => {
    const existing = files.get(pathname);
    if (options?.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
      throw new BlobPreconditionFailedError();
    }
    files.delete(pathname);
  });
  const head = vi.fn(async (pathname: string) => {
    const existing = files.get(pathname);
    if (!existing) return null;
    return { etag: existing.etag };
  });
  const client: SchwabBlobClient = { put, get, del, head };
  return { client, put, get, del, files, read, seed: (pathname: string, body: string) => {
    seq += 1;
    files.set(pathname, { body, etag: `etag-${seq}` });
  } };
}
