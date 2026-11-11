import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/app/lib/telegram", () => ({
  sendTelegramAlert: send,
}));

import { GET } from "@/app/api/cron/daily-note/route";
import {
  applyScanDay,
  dailyNoteDecision,
  deliverDailyNote,
  emptyDayTally,
  formatDailyNote,
  parseDayTally,
  recordAbandonedScan,
  recordScanDay,
  resetDayTallyForTests,
  type DayTally,
} from "@/app/lib/dayTally";
import { NextRequest } from "next/server";

const CST_NOTE = new Date("2026-11-11T21:05:00.000Z");
const CST_EARLY = new Date("2026-11-11T20:05:00.000Z");
const CDT_NOTE = new Date("2026-07-15T20:05:00.000Z");
const CDT_LATE = new Date("2026-07-15T21:05:00.000Z");
const HOLIDAY = new Date("2026-11-26T21:05:00.000Z");

describe("daily note copy", () => {
  it("renders the close note in plain wording", () => {
    const tally: DayTally = {
      ...emptyDayTally("2026-11-11"),
      scans: 78,
      schwabScans: 0,
      timedOut: 2,
      failed: 0,
      qualifiedKeys: [],
      alertsSent: 0,
    };
    expect(formatDailyNote(tally, "Tastytrade")).toBe(
      "Options scanner today: 78 scans ran on Tastytrade (0 used Schwab, 2 timed out). 0 setups qualified, so no alerts were sent.",
    );
  });

  it("names Schwab when every scan fell back, and counts qualified setups once", () => {
    const first = applyScanDay(emptyDayTally("2026-11-11"), "2026-11-11", {
      at: Date.parse("2026-11-11T15:00:00.000Z"),
      outcome: "partial",
      reason: "time budget",
      usedSchwab: true,
      qualifiedKeys: ["AAPL|2026-11-20|270|call"],
      alertsSent: 1,
    });
    const second = applyScanDay(first, "2026-11-11", {
      at: Date.parse("2026-11-11T15:05:00.000Z"),
      outcome: "success",
      reason: null,
      usedSchwab: true,
      qualifiedKeys: ["AAPL|2026-11-20|270|call", "MSFT|2026-11-20|400|put"],
      alertsSent: 0,
    });
    expect(second.scans).toBe(2);
    expect(second.qualifiedKeys).toEqual(["AAPL|2026-11-20|270|call", "MSFT|2026-11-20|400|put"]);
    expect(second.timedOut).toBe(1);
    expect(formatDailyNote(second, "Tastytrade")).toBe(
      "Options scanner today: 2 scans ran on Schwab (2 used Schwab, 1 timed out). 2 setups qualified (A/B), 1 alert was sent.",
    );
  });

  it("says no alert was sent when a setup qualified and Telegram did not", () => {
    const tally = applyScanDay(emptyDayTally("2026-11-11"), "2026-11-11", {
      at: CST_NOTE.getTime(),
      outcome: "failed",
      reason: "Tastytrade timed out",
      usedSchwab: false,
      qualifiedKeys: ["NVDA|2026-11-20|140|call"],
      alertsSent: 0,
    });
    expect(tally.failed).toBe(0);
    expect(tally.timedOut).toBe(1);
    expect(formatDailyNote(tally)).toContain("1 setup qualified (A/B), but no alerts were sent.");
  });
});

describe("daily note schedule", () => {
  it("runs at 3:05pm Chicago in both winter and summer, and skips the other hour", () => {
    expect(dailyNoteDecision(CST_NOTE, false)).toEqual({ run: true, reason: null });
    expect(dailyNoteDecision(CST_EARLY, false).run).toBe(false);
    expect(dailyNoteDecision(CDT_NOTE, false)).toEqual({ run: true, reason: null });
    expect(dailyNoteDecision(CDT_LATE, false).run).toBe(false);
    expect(dailyNoteDecision(HOLIDAY, false)).toEqual({ run: false, reason: "market holiday" });
    expect(dailyNoteDecision(HOLIDAY, true)).toEqual({ run: false, reason: "market holiday" });
    expect(dailyNoteDecision(CST_EARLY, true)).toEqual({ run: true, reason: null });
  });
});

describe("daily note delivery", () => {
  const env = {
    MARKET_DATA_PRIMARY: process.env.MARKET_DATA_PRIMARY,
    TASTYTRADE_CLIENT_ID: process.env.TASTYTRADE_CLIENT_ID,
    TASTYTRADE_CLIENT_SECRET: process.env.TASTYTRADE_CLIENT_SECRET,
    TASTYTRADE_REFRESH_TOKEN: process.env.TASTYTRADE_REFRESH_TOKEN,
  };

  afterEach(() => {
    resetDayTallyForTests();
    send.mockReset();
    send.mockResolvedValue(true);
    delete process.env.CRON_SECRET;
    for (const key of Object.keys(env) as (keyof typeof env)[]) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function useTastytrade(): void {
    process.env.MARKET_DATA_PRIMARY = "tastytrade";
    process.env.TASTYTRADE_CLIENT_ID = "id";
    process.env.TASTYTRADE_CLIENT_SECRET = "secret";
    process.env.TASTYTRADE_REFRESH_TOKEN = "refresh";
  }

  it("counts an abandoned scan once and sends one note even if called twice", async () => {
    useTastytrade();
    await recordScanDay({
      at: CST_NOTE.getTime(),
      outcome: "success",
      reason: null,
      usedSchwab: false,
      qualifiedKeys: [],
      alertsSent: 0,
    });
    await recordAbandonedScan(Date.parse("2026-11-11T20:55:00.000Z"), CST_NOTE.getTime());
    await recordAbandonedScan(Date.parse("2026-11-11T20:55:00.000Z"), CST_NOTE.getTime());
    const first = await deliverDailyNote(CST_NOTE, false);
    const second = await deliverDailyNote(CST_NOTE, false);
    expect(first.sent).toBe(true);
    if (first.sent) {
      expect(first.note).toBe(
        "Options scanner today: 2 scans ran on Tastytrade (0 used Schwab, 1 timed out). 0 setups qualified, so no alerts were sent.",
      );
    }
    expect(second).toMatchObject({ sent: false, reason: "already sent" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when Telegram does not accept the note", async () => {
    useTastytrade();
    send.mockResolvedValueOnce(false);
    const failed = await deliverDailyNote(CST_NOTE, true);
    expect(failed).toMatchObject({ sent: false, reason: "Telegram did not accept the note" });
    send.mockResolvedValueOnce(true);
    const retried = await deliverDailyNote(CST_NOTE, true);
    expect(retried.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not send outside the window", async () => {
    const skipped = await deliverDailyNote(CST_EARLY, false);
    expect(skipped.sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("requires the cron bearer and does not send on an unauthorized call", async () => {
    useTastytrade();
    process.env.CRON_SECRET = "cron-token";
    const denied = await GET(new NextRequest("https://options-scan.vercel.app/api/cron/daily-note"));
    expect(denied.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    const allowed = await GET(new NextRequest("https://options-scan.vercel.app/api/cron/daily-note?manual=true", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body.sent).toBe(true);
    expect(body.note).toContain("Options scanner today:");
    expect(body.note).not.toContain("Reconnect Schwab");
  });
});

describe("day tally parse", () => {
  it("drops a body that is not a tally", () => {
    expect(parseDayTally("[]")).toBeNull();
    expect(parseDayTally("{\"date\":\"2026-11-11\",\"scans\":2,\"qualifiedKeys\":[\"AAPL\"]}")?.scans).toBe(2);
  });
});
