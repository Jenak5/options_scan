import { describe, expect, it } from "vitest";
import {
  connectionNotice,
  emptyScanHealth,
  refreshCountdown,
  scanIsStale,
  skipNotifyDue,
  skipTelegramText,
  skipWarning,
  SCAN_STALE_MS,
  SKIP_NOTIFY_COOLDOWN_MS,
  type ScanHealth,
} from "@/app/lib/scanHealth";

const SESSION = Date.parse("2026-10-06T15:00:00Z");
const CLOSED = Date.parse("2026-10-06T22:00:00Z");

function health(over: Partial<ScanHealth> = {}): ScanHealth {
  return { ...emptyScanHealth(), ...over };
}

describe("scan staleness", () => {
  it("warns during market hours when the last success is missing or older than 30 minutes", () => {
    expect(scanIsStale(SESSION, null, true)).toBe(true);
    expect(scanIsStale(SESSION, SESSION - SCAN_STALE_MS - 1, true)).toBe(true);
    expect(scanIsStale(SESSION, SESSION - SCAN_STALE_MS + 60_000, true)).toBe(false);
    expect(scanIsStale(CLOSED, null, false)).toBe(false);
    expect(scanIsStale(CLOSED, SESSION - SCAN_STALE_MS - 1, false)).toBe(false);
  });
});

describe("skip notification", () => {
  it("sends on the first skip and waits 30 minutes before the next one", () => {
    expect(skipNotifyDue(null, SESSION)).toBe(true);
    expect(skipNotifyDue(SESSION - SKIP_NOTIFY_COOLDOWN_MS + 1, SESSION)).toBe(false);
    expect(skipNotifyDue(SESSION - SKIP_NOTIFY_COOLDOWN_MS, SESSION)).toBe(true);
    expect(skipWarning("Schwab is not connected.")).toBe("Schwab scan skipped: Schwab is not connected.");
    expect(skipTelegramText("Refresh token expired")).toContain("Refresh token expired");
    expect(skipTelegramText("Refresh token expired")).toMatch(/did not place an order/i);
  });
});

describe("connection notice", () => {
  it("names a disconnected Schwab login", () => {
    const notice = connectionNotice({
      configured: true,
      connected: false,
      refreshExpired: true,
      warnRefreshSoon: true,
      refreshDaysLeft: 0,
      now: SESSION,
      health: health(),
    });
    expect(notice.severity).toBe("down");
    expect(notice.lines.join(" ")).toMatch(/disconnected/i);
    expect(notice.lines.join(" ")).toMatch(/expired/i);
  });

  it("counts down a refresh token that is inside two days", () => {
    expect(refreshCountdown(1.5, false)).toMatch(/about 36 hours/);
    expect(refreshCountdown(3, false)).toMatch(/about 3 days/);
    const notice = connectionNotice({
      configured: true,
      connected: true,
      refreshExpired: false,
      warnRefreshSoon: true,
      refreshDaysLeft: 1.2,
      now: CLOSED,
      health: health({ lastSuccessAt: CLOSED - 60_000 }),
    });
    expect(notice.severity).toBe("warn");
    expect(notice.lines.join(" ")).toMatch(/about 29 hours/);
    expect(notice.lines.join(" ")).not.toMatch(/30 minutes/);
  });

  it("warns when the session has gone more than 30 minutes without a successful scan", () => {
    const notice = connectionNotice({
      configured: true,
      connected: true,
      refreshExpired: false,
      warnRefreshSoon: false,
      refreshDaysLeft: 5,
      now: SESSION,
      health: health({ lastSuccessAt: SESSION - 31 * 60_000 }),
    });
    expect(notice.severity).toBe("warn");
    expect(notice.lines.join(" ")).toMatch(/31 minutes ago/);
    expect(notice.lines.join(" ")).toMatch(/30 minutes/);
  });

  it("stays quiet outside market hours when the last scan is old", () => {
    const notice = connectionNotice({
      configured: true,
      connected: true,
      refreshExpired: false,
      warnRefreshSoon: false,
      refreshDaysLeft: 5,
      now: CLOSED,
      health: health({ lastSuccessAt: CLOSED - 3 * 60 * 60_000 }),
    });
    expect(notice.severity).toBe("ok");
    expect(notice.lines).toEqual([]);
  });

  it("surfaces a Tastytrade HTTP 400 without hiding Schwab", () => {
    const notice = connectionNotice({
      configured: true,
      connected: true,
      refreshExpired: false,
      warnRefreshSoon: false,
      refreshDaysLeft: 5,
      now: CLOSED,
      health: health({
        lastSuccessAt: CLOSED - 60_000,
        tastytradeOk: false,
        tastytradeStatus: 400,
        tastytradeMessage: "Tastytrade login failed (HTTP 400). The refresh token was rejected, so positions and balances are unavailable until that token is replaced in Vercel. Schwab quotes are separate.",
      }),
    });
    expect(notice.severity).toBe("warn");
    expect(notice.lines.join(" ")).toMatch(/HTTP 400/);
    expect(notice.lines.join(" ")).toMatch(/Schwab quotes are separate/);
  });
});
