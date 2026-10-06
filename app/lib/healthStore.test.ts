import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHealthReport } from "@/app/lib/healthReport";
import { emptyScanHealth } from "@/app/lib/scanHealth";
import { SCHWAB_BLOB_STORE_STATUS_PATH } from "@/app/lib/schwabStorage";
import {
  clearMemoryStoreForTests,
  readScanHealth,
  setSchwabBlobClientForTests,
  writeScanHealth,
  type SchwabBlobClient,
  type SchwabBlobGetResult,
  type SchwabBlobPutOptions,
} from "@/app/lib/schwabStore";

const ENV_KEYS = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "BLOB_READ_WRITE_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearMemoryStoreForTests();
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

describe("scan health shared store", () => {
  it("shows a scan finished on another instance in the health check", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "fixture-blob-token";
    const mock = createBlobMock();
    setSchwabBlobClientForTests(mock.client);

    const oldAt = Date.parse("2026-10-06T18:30:44.000Z");
    expect(await writeScanHealth({
      ...emptyScanHealth(),
      lastRunAt: oldAt,
      lastOutcome: "success",
    })).toBe(true);
    expect((await readScanHealth()).lastRunAt).toBe(oldAt);
    expect((await readScanHealth()).lastShadowAt).toBeNull();

    const scanAt = Date.parse("2026-10-06T18:47:20.000Z");
    mock.files.set(SCHWAB_BLOB_STORE_STATUS_PATH, {
      body: statusBody({
        lastRunAt: scanAt,
        lastSuccessAt: scanAt,
        lastOutcome: "success",
        lastShadowAt: scanAt,
      }),
      etag: "etag-other-instance",
    });

    const report = buildHealthReport({
      health: await readScanHealth(),
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [],
      openShadows: 6,
      resolvedShadows: 0,
      now: new Date(scanAt + 120_000),
    });
    expect(report.lastScanAt).toBe("2026-10-06T18:47:20.000Z");
    expect(report.lastScanOutcome).toBe("success");
    expect(report.lastShadowAt).toBe("2026-10-06T18:47:20.000Z");

    expect(await writeScanHealth({
      ...emptyScanHealth(),
      lastRunAt: scanAt,
      lastSuccessAt: scanAt,
      lastOutcome: "success",
      lastShadowAt: scanAt,
    })).toBe(true);
    clearMemoryStoreForTests();
    const saved = buildHealthReport({
      health: await readScanHealth(),
      schwabConnected: true,
      tastytradeEnabled: false,
      alerts: [],
      openShadows: 6,
      resolvedShadows: 0,
      now: new Date(scanAt + 120_000),
    });
    expect(saved.lastScanAt).toBe("2026-10-06T18:47:20.000Z");
    expect(saved.lastScanOutcome).toBe("success");
    expect(saved.lastShadowAt).toBe("2026-10-06T18:47:20.000Z");
  });

  it("logs a warning when the scan health write does not land", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "fixture-blob-token";
    const mock = createBlobMock();
    setSchwabBlobClientForTests(mock.client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock.put.mockRejectedValueOnce(Object.assign(new Error("blob down vercel_blob_rw_secret"), { status: 503 }));

    const scanAt = Date.parse("2026-10-06T18:47:20.000Z");
    expect(await writeScanHealth({
      ...emptyScanHealth(),
      lastRunAt: scanAt,
      lastOutcome: "success",
      lastShadowAt: scanAt,
    })).toBe(false);

    const line = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(line).toContain("Scan health could not be written:");
    expect(line).toContain("blob down");
    expect(line).toContain("status 503");
    expect(line.includes("vercel_blob_rw_secret")).toBe(false);
    expect((await readScanHealth()).lastRunAt).toBeNull();
    expect((await readScanHealth()).lastShadowAt).toBeNull();
  });
});

function statusBody(scan: Partial<ReturnType<typeof emptyScanHealth>>): string {
  return JSON.stringify({
    failures: {},
    alertsSentUnsavedAt: null,
    scan: { ...emptyScanHealth(), ...scan },
  });
}

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
  const put = vi.fn(async (pathname: string, body: string, _options: SchwabBlobPutOptions) => {
    seq += 1;
    const etag = `etag-${seq}`;
    files.set(pathname, { body, etag });
    return { pathname, etag };
  });
  const get = vi.fn(async (pathname: string) => read(pathname));
  const del = vi.fn(async () => undefined);
  const head = vi.fn(async (pathname: string) => {
    const existing = files.get(pathname);
    if (!existing) return null;
    return { etag: existing.etag };
  });
  const client: SchwabBlobClient = { put, get, del, head };
  return { client, put, files };
}
