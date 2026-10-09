import { describe, expect, it } from "vitest";
import {
  connectionNotice,
  emptyScanHealth,
  formatChicagoStamp,
  formatScanRunLine,
  refreshCountdown,
  scanFreshness,
  scanIsStale,
  scanSlotDecision,
  skipNotifyDue,
  skipTelegramText,
  skipWarning,
  SCAN_IN_PROGRESS_MS,
  SCAN_RECENT_SUCCESS_MS,
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

  it("stays quiet on a full-day holiday during the usual session", () => {
    const thanksgiving = Date.parse("2026-11-26T15:00:00Z");
    const notice = connectionNotice({
      configured: true,
      connected: true,
      refreshExpired: false,
      warnRefreshSoon: false,
      refreshDaysLeft: 5,
      now: thanksgiving,
      health: health({ lastSuccessAt: null }),
    });
    expect(notice.severity).toBe("ok");
    expect(notice.lines).toEqual([]);
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
      showTastytrade: true,
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

  it("hides a stored Tastytrade failure while Tastytrade is turned off", () => {
    const notice = connectionNotice({
      configured: true,
      connected: true,
      refreshExpired: false,
      warnRefreshSoon: false,
      refreshDaysLeft: 5,
      now: CLOSED,
      showTastytrade: false,
      health: health({
        lastSuccessAt: CLOSED - 60_000,
        tastytradeOk: false,
        tastytradeStatus: 400,
        tastytradeMessage: "Tastytrade login failed (HTTP 400).",
      }),
    });
    expect(notice.severity).toBe("ok");
    expect(notice.lines).toEqual([]);
  });
});

describe("scan slot", () => {
  it("lets one run through and holds the slot while it is unfinished or just succeeded", () => {
    const now = SESSION;
    expect(scanSlotDecision(health(), now)).toBe("ok");
    expect(scanSlotDecision(health({ runStartedAt: now - 60_000 }), now)).toBe("busy");
    expect(scanSlotDecision(health({
      runStartedAt: now - 60_000,
      lastRunAt: now - 10_000,
    }), now)).toBe("ok");
    expect(scanSlotDecision(health({
      runStartedAt: now - SCAN_IN_PROGRESS_MS - 1,
    }), now)).toBe("ok");
    expect(scanSlotDecision(health({ lastSuccessAt: now - 60_000 }), now)).toBe("recent");
    expect(scanSlotDecision(health({ lastSuccessAt: now - SCAN_RECENT_SUCCESS_MS }), now)).toBe("ok");
  });
});

describe("scan log line", () => {
  it("is one line with the counts and no secret", () => {
    const line = formatScanRunLine({
      outcome: "success",
      tickers: 29,
      alertsSaved: 1,
      shadowsOpened: 1,
      shadowsMarked: 4,
      shadowsClosed: 0,
      reason: "chain\nerror",
    });
    expect(line).toBe("Scan success: 29 tickers, 1 alert saved, 1 shadow opened, 4 marked, 0 closed. chain error");
    expect(line.includes("\n")).toBe(false);
    const fresh = scanFreshness(health({
      lastRunAt: Date.parse("2026-10-06T18:05:00Z"),
      lastOutcome: "success",
      lastShadowAt: Date.parse("2026-10-06T18:05:00Z"),
    }));
    expect(fresh.lastScan).toContain("Last scan:");
    expect(fresh.lastScan).toContain("success");
    expect(fresh.lastShadow).toContain("Last shadow update:");
    expect(formatChicagoStamp(Date.parse("2026-10-06T18:05:00Z"))).toMatch(/1:05/);
    expect(formatChicagoStamp(Date.parse("2026-10-06T18:05:00Z"))).toMatch(/CT|CDT|CST/);
    const browser = scanFreshness(health({
      lastRunAt: Date.parse("2026-10-06T17:00:00Z"),
      lastOutcome: "skipped",
      lastBrowserScanAt: Date.parse("2026-10-06T18:05:00Z"),
    }));
    expect(browser.lastScan).toContain("success");
    expect(browser.lastScanAt).toBe(Date.parse("2026-10-06T18:05:00Z"));
  });
});
