import { afterEach, describe, expect, it, vi } from "vitest";
import { sendTelegramAlert, TELEGRAM_RETRY_CAP_MS, telegramRetryWaitMs } from "@/app/lib/telegram";

const TOKEN = "fixture-telegram-bot";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("telegram retry wait", () => {
  it("uses retry_after and caps the wait at 15 seconds", () => {
    expect(telegramRetryWaitMs(JSON.stringify({ parameters: { retry_after: 5 } }), null)).toBe(5_000);
    expect(telegramRetryWaitMs("{}", "2")).toBe(2_000);
    expect(telegramRetryWaitMs(JSON.stringify({ parameters: { retry_after: 30 } }), "30")).toBe(TELEGRAM_RETRY_CAP_MS);
    expect(TELEGRAM_RETRY_CAP_MS).toBe(15_000);
    expect(telegramRetryWaitMs("not json", null)).toBe(1_000);
    expect(telegramRetryWaitMs("Too Many Requests: retry after 4", null)).toBe(4_000);
  });
});

describe("sendTelegramAlert", () => {
  it("waits for the capped retry_after and retries a 429 once", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_CHAT_ID", "100");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 30 } }), {
          status: 429,
          headers: { "retry-after": "30" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const pending = sendTelegramAlert("hello");
    await vi.advanceTimersByTimeAsync(TELEGRAM_RETRY_CAP_MS);
    await expect(pending).resolves.toBe(true);
    expect(calls).toBe(2);
    const logs = info.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logs).toContain("retrying once after 15000ms");
    expect(logs).not.toContain(TOKEN);
    expect(error).not.toHaveBeenCalled();
  });

  it("does not retry a second 429", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_CHAT_ID", "100");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({
        ok: false,
        description: `Too Many Requests: retry after 1 bot ${TOKEN}`,
        parameters: { retry_after: 1 },
      }), { status: 429 });
    }));

    const pending = sendTelegramAlert("hello");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);
    expect(calls).toBe(2);
    const logs = error.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logs).toContain("Telegram send failed (429)");
    expect(logs).not.toContain(TOKEN);
    expect(logs).toContain("[redacted]");
  });
});
