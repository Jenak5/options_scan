import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as backfillGet, POST as backfillPost } from "@/app/api/candles/backfill/route";
import { GET as candleCron } from "@/app/api/cron/candles/route";
import { middleware } from "@/middleware";

const ENV = ["CRON_SECRET", "HEALTH_TOKEN", "BLOB_READ_WRITE_TOKEN", "TASTYTRADE_CLIENT_ID", "TASTYTRADE_CLIENT_SECRET", "TASTYTRADE_REFRESH_TOKEN"] as const;

describe("candle routes", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (let i = 0; i < ENV.length; i++) delete process.env[ENV[i]];
  });

  it("lets the candle cron and the backfill through middleware", async () => {
    const cron = await middleware(new NextRequest("https://options-scan.vercel.app/api/cron/candles"));
    const backfill = await middleware(new NextRequest("https://options-scan.vercel.app/api/candles/backfill"));
    expect(cron.status).not.toBe(401);
    expect(backfill.status).not.toBe(401);
    expect(cron.headers.get("location")).toBeNull();
  });

  it("rejects a candle cron without the cron bearer and skips the off-season UTC slot", async () => {
    process.env.CRON_SECRET = "cron-token";
    const denied = await candleCron(new NextRequest("https://options-scan.vercel.app/api/cron/candles"));
    expect(denied.status).toBe(401);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T21:30:00Z"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    const skipped = await candleCron(authed("https://options-scan.vercel.app/api/cron/candles", "cron-token"));
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs the daylight-time slot and the standard-time slot only when it is 3:30pm Chicago", async () => {
    process.env.CRON_SECRET = "cron-token";
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not be called"));
    vi.setSystemTime(new Date("2026-10-13T20:30:00Z"));
    const cdt = await candleCron(authed("https://options-scan.vercel.app/api/cron/candles", "cron-token"));
    expect(cdt.status).toBe(500);
    expect((await cdt.json()).reason).toMatch(/Blob/);

    vi.setSystemTime(new Date("2026-12-14T21:30:00Z"));
    const cst = await candleCron(authed("https://options-scan.vercel.app/api/cron/candles", "cron-token"));
    expect(cst.status).toBe(500);

    vi.setSystemTime(new Date("2026-11-26T21:30:00Z"));
    const holiday = await candleCron(authed("https://options-scan.vercel.app/api/cron/candles", "cron-token"));
    expect(holiday.status).toBe(200);
    expect(await holiday.json()).toMatchObject({ skipped: "market holiday" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("protects the backfill with the health bearer and allows a repeat call", async () => {
    process.env.HEALTH_TOKEN = "health-token";
    process.env.CRON_SECRET = "cron-token";
    const denied = await backfillPost(new NextRequest("https://options-scan.vercel.app/api/candles/backfill", {
      method: "POST",
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(denied.status).toBe(401);
    const accepted = await backfillGet(authed("https://options-scan.vercel.app/api/candles/backfill", "health-token"));
    expect(accepted.status).toBe(500);
    expect((await accepted.json()).reason).toMatch(/Blob/);
  });
});

function authed(url: string, token: string): NextRequest {
  return new NextRequest(url, { headers: { authorization: `Bearer ${token}` } });
}
