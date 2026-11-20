import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/telegram/mute/route";
import { clearMemoryStoreForTests, readTelegramMute } from "@/app/lib/schwabStore";
import {
  classifyScannerWarnings,
  emptyMuteBook,
  planFailureNotices,
  TELEGRAM_WARN_GAP_MS,
  withMutedLine,
} from "@/app/lib/telegramMute";
import { clearTelegramWarningMemoryForTests, readMuteView, setTelegramMuted } from "@/app/lib/telegramMuteJob";
import { sendTelegramAlert, sendTelegramAlertWithButton } from "@/app/lib/telegram";

const TOKEN = "fixture-telegram-bot";

beforeEach(() => {
  clearMemoryStoreForTests();
  clearTelegramWarningMemoryForTests();
});

afterEach(() => {
  clearMemoryStoreForTests();
  clearTelegramWarningMemoryForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telegram mute categories", () => {
  it("mutes other, keeps avwap and system, and returns a handled result", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_CHAT_ID", "100");
    const bodies = captureFetch();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    let recorded = 0;
    const delivered = await sendTelegramAlert("NVDA put flow\nsecond line stays out");
    if (delivered) recorded += 1;
    expect(recorded).toBe(1);
    expect(bodies).toHaveLength(0);
    expect(info.mock.calls.map((call) => String(call[0])).join(" ")).toContain("Telegram muted: NVDA put flow");
    expect(info.mock.calls.map((call) => String(call[0])).join(" ")).not.toContain("second line");

    const stored = await readTelegramMute();
    expect(stored.state).toBe("ok");
    expect(stored.state === "ok" ? stored.text : "").toContain("NVDA put flow");
    expect(stored.state === "ok" ? stored.text : "").not.toContain("second line");

    await sendTelegramAlert("AVWAP open stays", "avwap");
    await sendTelegramAlert("Scanner warning: still sent", "system");
    await sendTelegramAlertWithButton("AVWAP button stays", "ack:alert1");
    expect(bodies.some((body) => body.includes("AVWAP open stays"))).toBe(true);
    expect(bodies.some((body) => body.includes("Scanner warning: still sent"))).toBe(true);
    expect(bodies.some((body) => body.includes("inline_keyboard") && body.includes("AVWAP button stays"))).toBe(true);
    expect(bodies.some((body) => body.includes(TOKEN))).toBe(false);
  });

  it("sends other alerts again after the setting is turned off", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_CHAT_ID", "100");
    const bodies = captureFetch();
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await sendTelegramAlert("muted first")).toBe(true);
    expect(bodies).toHaveLength(0);
    expect(await setTelegramMuted(false)).toBe(true);
    expect(await sendTelegramAlert("unmuted second")).toBe(true);
    expect(bodies.some((body) => body.includes("unmuted second"))).toBe(true);
  });

  it("forces every alert on when TELEGRAM_MUTE_OTHER=0", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_CHAT_ID", "100");
    vi.stubEnv("TELEGRAM_MUTE_OTHER", "0");
    const bodies = captureFetch();
    expect(await setTelegramMuted(true)).toBe(true);
    expect(await sendTelegramAlert("forced on")).toBe(true);
    expect(bodies.some((body) => body.includes("forced on"))).toBe(true);
  });

  it("keeps only the last 50 muted lines", () => {
    let book = emptyMuteBook();
    for (let i = 0; i < 55; i++) book = withMutedLine(book, i, `line ${i}`);
    expect(book.log).toHaveLength(50);
    expect(book.log[0].text).toBe("line 5");
    expect(book.log[49].text).toBe("line 54");
  });
});

describe("scanner failure warnings", () => {
  it("throttles for 60 minutes and sends one recovered message", () => {
    const first = planFailureNotices(emptyMuteBook(), 1_000, { scan: true });
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0].text).toContain("scan did not finish");
    const again = planFailureNotices(first.book, 1_000 + TELEGRAM_WARN_GAP_MS - 1, { scan: true });
    expect(again.notices).toHaveLength(0);
    const later = planFailureNotices(first.book, 1_000 + TELEGRAM_WARN_GAP_MS, { scan: true });
    expect(later.notices).toHaveLength(1);
    const cleared = planFailureNotices(first.book, 2_000, { scan: false });
    expect(cleared.notices).toHaveLength(1);
    expect(cleared.notices[0].text).toContain("recovered");
    expect(planFailureNotices(cleared.book, 3_000, { scan: false }).notices).toHaveLength(0);
  });

  it("does not warn when only the Schwab backup is down", () => {
    const quiet = classifyScannerWarnings({
      outcome: "success",
      reason: null,
      rowsScanned: 4,
      preferred: "tastytrade",
      schwabOnlyFailure: true,
      bothSourcesFailed: false,
      avwapFailed: false,
      storeUnsaved: false,
    });
    expect(quiet.feed).toBe(false);
    expect(quiet.scan).toBe(false);

    const primary = classifyScannerWarnings({
      outcome: "skipped",
      reason: "Schwab is not connected.",
      rowsScanned: 0,
      preferred: "schwab",
      schwabOnlyFailure: true,
      bothSourcesFailed: false,
      avwapFailed: false,
      storeUnsaved: false,
    });
    expect(primary.feed).toBe(true);
    expect(primary.scan).toBe(true);

    const budgetInput = {
      outcome: "partial" as const,
      reason: "time budget",
      rowsScanned: 0,
      preferred: "tastytrade" as const,
      schwabOnlyFailure: false,
      bothSourcesFailed: false,
      avwapFailed: true,
      storeUnsaved: true,
    };
    const budget = classifyScannerWarnings(budgetInput);
    expect(budget.scan).toBe(true);
    expect(budget.avwap).toBe(true);
    expect(budget.store).toBe(true);
    expect(budget.feed).toBe(false);

    const scored = classifyScannerWarnings({
      ...budgetInput,
      rowsScanned: 2,
      avwapFailed: false,
      storeUnsaved: false,
    });
    expect(scored.scan).toBe(false);
  });

  it("defaults to muted and warns once when the mute store cannot be read", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_CHAT_ID", "100");
    const bodies = captureFetch();
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await sendTelegramAlert("hello flow alert")).toBe(true);
    expect(bodies.some((body) => body.includes("hello flow alert"))).toBe(false);
    expect(bodies.some((body) => body.includes("alert settings could not be read"))).toBe(true);
    const count = bodies.length;
    expect(await sendTelegramAlert("another flow alert")).toBe(true);
    expect(bodies).toHaveLength(count);
    const view = await readMuteView();
    expect(view.muted).toBe(true);
    expect(view.storeUnreadable).toBe(true);
  });
});

describe("telegram mute route", () => {
  it("requires a session or bearer and toggles the stored setting", async () => {
    vi.stubEnv("CRON_SECRET", "cron-token");
    const denied = await GET(new NextRequest("https://options-scan.vercel.app/api/telegram/mute"));
    expect(denied.status).toBe(401);
    const deniedPost = await POST(new NextRequest("https://options-scan.vercel.app/api/telegram/mute", {
      method: "POST",
      body: JSON.stringify({ muted: false }),
    }));
    expect(deniedPost.status).toBe(401);

    const headers = { authorization: "Bearer cron-token" };
    const first = await GET(new NextRequest("https://options-scan.vercel.app/api/telegram/mute", { headers }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ muted: true, forced: false, mutedToday: 0 });

    const bad = await POST(new NextRequest("https://options-scan.vercel.app/api/telegram/mute", {
      method: "POST",
      headers,
      body: "{}",
    }));
    expect(bad.status).toBe(400);

    const off = await POST(new NextRequest("https://options-scan.vercel.app/api/telegram/mute", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ muted: false }),
    }));
    expect(off.status).toBe(200);
    expect((await off.json()).muted).toBe(false);
    const again = await GET(new NextRequest("https://options-scan.vercel.app/api/telegram/mute", { headers }));
    expect((await again.json()).muted).toBe(false);

    vi.stubEnv("TELEGRAM_MUTE_OTHER", "0");
    const forced = await GET(new NextRequest("https://options-scan.vercel.app/api/telegram/mute", { headers }));
    expect(await forced.json()).toMatchObject({ muted: false, forced: true });
  });
});

function captureFetch(): string[] {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  }));
  return bodies;
}
