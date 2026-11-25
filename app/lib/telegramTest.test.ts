import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { AVWAP_REPEAT_GAP_MS, emptyAvwapRepeatBook, parseAvwapRepeatBook, planAvwapRepeats } from "@/app/lib/avwapRepeat";
import { acknowledgeFromTelegram, deliverTelegramProbe, runAvwapRepeatPass, TELEGRAM_PROBE_PREFIX, type AvwapRepeatIo } from "@/app/lib/avwapRepeatJob";
import { POST as testPost } from "@/app/api/telegram/test/route";

const OPEN = Date.parse("2026-11-25T17:00:00.000Z");
const TOKEN = "123456:fixture-bot-token";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function harness(nowMs: number) {
  const state = { text: JSON.stringify(emptyAvwapRepeatBook()), now: nowMs };
  const sent: Array<{ text: string; callback: string }> = [];
  const io: AvwapRepeatIo = {
    now: () => state.now,
    read: async () => state.text,
    write: async (change) => {
      const next = change(state.text);
      if (next == null) return false;
      state.text = next;
      return true;
    },
    closedTradeIds: async () => new Set(),
    send: async (text, callback) => {
      sent.push({ text, callback });
      return { ok: true, messageId: 700 + sent.length };
    },
    edit: async () => true,
    answer: async () => true,
  };
  return { state, sent, io };
}

describe("telegram test alert", () => {
  it("sends one TEST ONLY alert with the real button, never repeats, and still acks", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "fixture-secret");
    const h = harness(OPEN);
    const probe = await deliverTelegramProbe(h.io);
    expect(probe.sent && probe.saved).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text.startsWith(TELEGRAM_PROBE_PREFIX)).toBe(true);
    expect(h.sent[0].callback).toBe(`ack:${probe.id}`);
    const stored = parseAvwapRepeatBook(h.state.text)!;
    expect(stored.alerts[0]).toMatchObject({ id: probe.id, tradeId: null, isTest: true, stop: "probe" });

    for (let n = 1; n <= 6; n++) {
      h.state.now = OPEN + n * AVWAP_REPEAT_GAP_MS;
      expect(planAvwapRepeats(parseAvwapRepeatBook(h.state.text)!, h.state.now, new Set(), `t${n}`).claims).toHaveLength(0);
      const pass = await runAvwapRepeatPass(h.io);
      expect(pass.sent).toBe(0);
    }
    expect(h.sent).toHaveLength(1);

    const ack = await acknowledgeFromTelegram({ callback_query: { id: "cb", data: `ack:${probe.id}`, message: { message_id: 701, chat: { id: 55 } } } }, "55", h.io);
    expect(ack).toBe("ack");
  });

  it("requires the health bearer and returns only safe webhook fields", async () => {
    vi.stubEnv("HEALTH_TOKEN", "health-fixture");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "fixture-secret");
    const url = "https://options-scan.vercel.app/api/telegram/test?action=webhookinfo";
    expect((await middleware(new NextRequest(url, { method: "POST" }))).status).toBe(200);
    expect((await testPost(new NextRequest(url, { method: "POST" }))).status).toBe(401);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        url: "https://example.test/hook?x=1",
        has_custom_certificate: false,
        pending_update_count: 3,
        last_error_date: 1795620000,
        last_error_message: `Wrong response ${TOKEN}`,
        allowed_updates: ["callback_query", "message"],
        ip_address: "1.2.3.4",
      },
    }), { status: 200 })));
    const res = await testPost(new NextRequest(url, { method: "POST", headers: { authorization: "Bearer health-fixture" } }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      url: "https://example.test/hook",
      pending_update_count: 3,
      last_error_date: 1795620000,
      last_error_message: "Wrong response [redacted]",
      allowed_updates: ["callback_query", "message"],
      description: null,
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});
