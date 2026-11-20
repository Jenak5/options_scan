import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import {
  AVWAP_REPEAT_GAP_MS,
  AVWAP_REPEAT_MAX,
  AVWAP_STATUS_KEEP_MS,
  acknowledgeAvwapAlert,
  avwapStatusRows,
  emptyAvwapRepeatBook,
  planAvwapRepeats,
  retainAvwapAlerts,
  type AvwapPendingAlert,
  type AvwapRepeatBook,
} from "@/app/lib/avwapRepeat";
import {
  acknowledgeFromTelegram,
  avwapRepeatsEnabled,
  deliverAvwapOpenAlert,
  runAvwapRepeatPass,
  type AvwapRepeatIo,
} from "@/app/lib/avwapRepeatJob";
import { clearMemoryStoreForTests, updateAvwapRepeat } from "@/app/lib/schwabStore";
import { GET as avwapStatusGet } from "@/app/api/telegram/avwap-status/route";
import { isBearerPath } from "@/app/lib/bearerPaths";
import { formatFlowAlert, sendTelegramAlert, sendTelegramAlertWithButton } from "@/app/lib/telegram";
import { POST as webhookPost } from "@/app/api/telegram/webhook/route";

const SECRET = "fixture-webhook-secret";
const CHAT = "1001";
const OPEN = Date.parse("2026-11-20T15:00:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pending(overrides: Partial<AvwapPendingAlert> = {}): AvwapPendingAlert {
  return {
    id: "alert1",
    tradeId: "trade-1",
    text: "NVDA put paper open",
    isTest: false,
    firstSentAt: OPEN,
    repeatsSent: 0,
    lastSentAt: OPEN,
    acknowledged: false,
    acknowledgedAt: null,
    ackVia: null,
    messageIds: [10],
    stop: null,
    claimToken: null,
    ...overrides,
  };
}

function book(alerts: AvwapPendingAlert[]): AvwapRepeatBook {
  return { version: 1, alerts, lockUntil: null };
}

describe("AVWAP repeat timing", () => {
  it("waits 110 seconds, sends at most 5 repeats, and stops on ack, close, and a closed contract", () => {
    const first = planAvwapRepeats(book([pending()]), OPEN + AVWAP_REPEAT_GAP_MS - 1, new Set(), "t1");
    expect(first.claims).toHaveLength(0);

    let state = book([pending()]);
    const banners: string[] = [];
    for (let n = 1; n <= AVWAP_REPEAT_MAX; n++) {
      const planned = planAvwapRepeats(state, OPEN + n * AVWAP_REPEAT_GAP_MS, new Set(), `t${n}`);
      expect(planned.claims).toHaveLength(1);
      expect(planned.claims[0].text.startsWith(`<b>REPEAT ${n} of ${AVWAP_REPEAT_MAX}</b>`)).toBe(true);
      banners.push(planned.claims[0].text);
      state = planned.book;
    }
    expect(banners[1].startsWith("<b>REPEAT 2 of 5</b>")).toBe(true);
    const sixth = planAvwapRepeats(state, OPEN + 6 * AVWAP_REPEAT_GAP_MS, new Set(), "t6");
    expect(sixth.claims).toHaveLength(0);
    expect(sixth.book.alerts[0].stop).toBe("repeats");

    const acked = acknowledgeAvwapAlert(book([pending()]), "alert1").book;
    expect(planAvwapRepeats(acked, OPEN + AVWAP_REPEAT_GAP_MS, new Set(), "ack").claims).toHaveLength(0);

    const closed = planAvwapRepeats(book([pending()]), OPEN + AVWAP_REPEAT_GAP_MS, new Set(["trade-1"]), "closed");
    expect(closed.claims).toHaveLength(0);
    expect(closed.book.alerts[0].stop).toBe("closed");

    const afterClose = planAvwapRepeats(book([pending()]), Date.parse("2026-11-20T21:00:00.000Z"), new Set(), "close");
    expect(afterClose.claims).toHaveLength(0);
    expect(afterClose.book.alerts[0].stop).toBe("close");

    const nextMorning = planAvwapRepeats(book([pending()]), Date.parse("2026-11-23T15:00:00.000Z"), new Set(), "next");
    expect(nextMorning.claims).toHaveLength(0);
    expect(nextMorning.book.alerts[0].stop).toBe("close");
  });

  it("does not send a second repeat when the book already has the first claim", () => {
    const first = planAvwapRepeats(book([pending()]), OPEN + AVWAP_REPEAT_GAP_MS, new Set(), "one");
    const second = planAvwapRepeats(first.book, OPEN + AVWAP_REPEAT_GAP_MS, new Set(), "two");
    expect(first.claims).toHaveLength(1);
    expect(second.claims).toHaveLength(0);
  });
});

describe("AVWAP repeat job", () => {
  it("sends one reminder and then nothing until the next gap", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const harness = harnessAt(OPEN + AVWAP_REPEAT_GAP_MS);
    harness.text = JSON.stringify(book([pending()]));
    const first = await runAvwapRepeatPass(harness.io);
    expect(first.sent).toBe(1);
    expect(harness.sent[0].startsWith("<b>REPEAT 1 of 5</b>")).toBe(true);
    const again = await runAvwapRepeatPass(harness.io);
    expect(again.sent).toBe(0);
    expect(harness.sent).toHaveLength(1);
  });

  it("drops a claim when another run already wrote a different token", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const started = book([pending()]);
    let text = JSON.stringify(started);
    const sent: string[] = [];
    const io: AvwapRepeatIo = {
      now: () => OPEN + AVWAP_REPEAT_GAP_MS,
      read: async () => text,
      write: async (change) => {
        change(text);
        const stolen = book([{ ...pending(), repeatsSent: 1, lastSentAt: OPEN + AVWAP_REPEAT_GAP_MS, claimToken: "other-run" }]);
        text = JSON.stringify(stolen);
        return true;
      },
      closedTradeIds: async () => new Set(),
      send: async (message) => {
        sent.push(message);
        return { ok: true, messageId: 1 };
      },
      edit: async () => true,
      answer: async () => true,
    };
    const result = await runAvwapRepeatPass(io);
    expect(result.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("lets only the winning overlapping run send", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    let text = JSON.stringify(book([pending()]));
    const sent: string[] = [];
    const queued: Array<{ change: (current: string | null) => string | null; done: (ok: boolean) => void }> = [];
    let paired = false;
    function io(): AvwapRepeatIo {
      return {
        now: () => OPEN + AVWAP_REPEAT_GAP_MS,
        read: async () => text,
        write: (change) => {
          if (paired) {
            const next = change(text);
            if (next == null) return Promise.resolve(false);
            text = next;
            return Promise.resolve(true);
          }
          return new Promise((resolve) => {
            queued.push({ change, done: resolve });
            if (queued.length < 2) return;
            const snapshot = text;
            const first = queued[0].change(snapshot);
            const second = queued[1].change(snapshot);
            text = second ?? first ?? text;
            paired = true;
            queued[0].done(true);
            queued[1].done(true);
          });
        },
        closedTradeIds: async () => new Set(),
        send: async (message) => {
          sent.push(message);
          return { ok: true, messageId: sent.length };
        },
        edit: async () => true,
        answer: async () => true,
      };
    }
    await Promise.all([runAvwapRepeatPass(io()), runAvwapRepeatPass(io())]);
    expect(sent).toHaveLength(1);
  });

  it("does not repeat when the webhook secret is unset", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    expect(avwapRepeatsEnabled()).toBe(false);
    const harness = harnessAt(OPEN + AVWAP_REPEAT_GAP_MS);
    harness.text = JSON.stringify(book([pending()]));
    const result = await runAvwapRepeatPass(harness.io);
    expect(result.sent).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  it("acknowledges a button, a reply, and a bare ack, and ignores another chat", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const harness = harnessAt(OPEN);
    harness.text = JSON.stringify(book([pending(), pending({ id: "alert2", messageIds: [11], firstSentAt: OPEN + 1 })]));
    const wrong = await acknowledgeFromTelegram(callbackUpdate("alert1", 999), CHAT, harness.io);
    expect(wrong).toBe("reject");
    expect(harness.answers).toHaveLength(0);

    const button = await acknowledgeFromTelegram(callbackUpdate("alert1", Number(CHAT)), CHAT, harness.io);
    expect(button).toBe("ack");
    expect(harness.answers).toEqual(["cb-1"]);
    expect(harness.edits).toHaveLength(1);
    expect(harness.edits[0].text.endsWith("Acknowledged.")).toBe(true);

    const reply = await acknowledgeFromTelegram({
      message: { message_id: 20, text: "seen", chat: { id: Number(CHAT) }, reply_to_message: { message_id: 11 } },
    }, CHAT, harness.io);
    expect(reply).toBe("ack");

    const word = await acknowledgeFromTelegram({
      message: { message_id: 21, text: "Ack", chat: { id: Number(CHAT) } },
    }, CHAT, harness.io);
    expect(word).toBe("ignore");
  });
});

describe("telegram webhook auth", () => {
  it("rejects a missing or wrong secret and lets the public path through middleware", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const missing = await webhookPost(new NextRequest("https://options-scan.vercel.app/api/telegram/webhook", {
      method: "POST",
      body: "{}",
    }));
    expect(missing.status).toBe(401);
    const wrong = await webhookPost(new NextRequest("https://options-scan.vercel.app/api/telegram/webhook", {
      method: "POST",
      body: "{}",
      headers: { "x-telegram-bot-api-secret-token": "not-the-secret" },
    }));
    expect(wrong.status).toBe(401);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    const unset = await webhookPost(new NextRequest("https://options-scan.vercel.app/api/telegram/webhook", {
      method: "POST",
      body: "{}",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    }));
    expect(unset.status).toBe(401);

    const passed = await middleware(new NextRequest("https://options-scan.vercel.app/api/telegram/webhook", { method: "POST" }));
    expect(passed.status).toBe(200);
    expect(isBearerPath("/api/cron/avwap-repeat")).toBe(true);
    expect(isBearerPath("/api/telegram/webhook")).toBe(false);
  });
});

describe("other telegram alerts stay on the plain sender", () => {
  it("keeps flow alerts and the other senders off the button sender", () => {
    const flow = formatFlowAlert({
      ticker: "NVDA",
      putCall: "put",
      strike: 180,
      expiration: "2026-11-27",
      ask: 2.5,
      notionalPremium: 250000,
      volume: 1000,
      openInterest: 500,
      iv: 0.4,
      side: "ask",
      otm: true,
      volumeExceedsOi: true,
      volOiRatio: 2,
    });
    expect(flow).not.toContain("reply_markup");
    expect(sendTelegramAlert.toString()).not.toContain("reply_markup");
    expect(sendTelegramAlertWithButton.toString()).toContain("inline_keyboard");
    const files = [
      "app/lib/jgVwapRun.ts",
      "app/lib/callsPaperRun.ts",
      "app/lib/dayTally.ts",
      "app/api/cron/route.ts",
      "app/lib/pageScan.ts",
      "app/lib/schwab.ts",
      "app/api/alerts/route.ts",
    ];
    for (let i = 0; i < files.length; i++) {
      const source = readFileSync(resolve(process.cwd(), files[i]), "utf8");
      expect(source).toContain("sendTelegramAlert");
      expect(source).not.toContain("sendTelegramAlertWithButton");
    }
  });
});

describe("AVWAP repeat status", () => {
  it("keeps a finished alert for 7 days and drops it after that", () => {
    const now = OPEN;
    const recent = pending({
      id: "recent1",
      stop: "ack",
      acknowledged: true,
      acknowledgedAt: now - 6 * 24 * 60 * 60 * 1000,
      lastSentAt: now - 6 * 24 * 60 * 60 * 1000,
    });
    const stale = pending({
      id: "stale01",
      stop: "close",
      acknowledgedAt: now - AVWAP_STATUS_KEEP_MS - 60_000,
      lastSentAt: now - AVWAP_STATUS_KEEP_MS - 60_000,
    });
    const kept = retainAvwapAlerts([recent, stale, pending()], now);
    expect(kept.map((row) => row.id)).toEqual(["alert1", "recent1"]);
  });

  it("logs create, repeat, ack, and stop without the rest of the message", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const long = `${"A".repeat(40)}TAIL-SHOULD-NOT-LOG`;
    const harness = harnessAt(OPEN);
    const created = await deliverAvwapOpenAlert(long, null, harness.io);
    expect(created.saved).toBe(true);
    const createdLine = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(createdLine).toContain("AVWAP pending alert");
    expect(createdLine).toContain("test=yes");
    expect(createdLine).toContain("A".repeat(40));
    expect(createdLine).not.toContain("TAIL-SHOULD-NOT-LOG");

    info.mockClear();
    harness.text = JSON.stringify(book([pending({ text: long })]));
    const repeat = harnessAt(OPEN + AVWAP_REPEAT_GAP_MS);
    repeat.text = harness.text;
    await runAvwapRepeatPass(repeat.io);
    const repeatLine = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(repeatLine).toContain("AVWAP repeat 1 of 5");
    expect(repeatLine).not.toContain("TAIL-SHOULD-NOT-LOG");

    info.mockClear();
    const acked = await acknowledgeFromTelegram(callbackUpdate("alert1", Number(CHAT)), CHAT, repeat.io);
    expect(acked).toBe("ack");
    const ackLine = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(ackLine).toContain("AVWAP ack alert1 via button");
    expect(ackLine).toContain("reason acknowledged");
    expect(ackLine).not.toContain(CHAT);

    info.mockClear();
    const reply = harnessAt(OPEN);
    reply.text = JSON.stringify(book([pending({ id: "alert8", messageIds: [11] })]));
    const replied = await acknowledgeFromTelegram({
      message: { message_id: 31, text: "seen", chat: { id: Number(CHAT) }, reply_to_message: { message_id: 11 } },
    }, CHAT, reply.io);
    expect(replied).toBe("ack");
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toContain("AVWAP ack alert8 via reply");

    info.mockClear();
    const word = harnessAt(OPEN);
    word.text = JSON.stringify(book([pending({ id: "alert9" })]));
    const worded = await acknowledgeFromTelegram({
      message: { message_id: 30, text: "ack", chat: { id: Number(CHAT) } },
    }, CHAT, word.io);
    expect(worded).toBe("ack");
    const wordLine = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(wordLine).toContain("AVWAP ack alert9 via ack");
    expect(wordLine).not.toContain(CHAT);

    info.mockClear();
    const closing = harnessAt(OPEN + AVWAP_REPEAT_GAP_MS);
    closing.text = JSON.stringify(book([pending()]));
    closing.io.closedTradeIds = async () => new Set(["trade-1"]);
    await runAvwapRepeatPass(closing.io);
    const stopLine = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(stopLine).toContain("AVWAP repeats stopped alert1 reason trade closed");
  });

  it("serves the last alerts without message text, and rejects a missing session", async () => {
    clearMemoryStoreForTests();
    vi.stubEnv("CRON_SECRET", "cron-token");
    const phrase = "PHRASE-NOT-IN-STATUS";
    await updateAvwapRepeat(() => JSON.stringify(book([pending({ text: `NVDA ${phrase} put` })])));
    const denied = await avwapStatusGet(new NextRequest("https://options-scan.vercel.app/api/telegram/avwap-status"));
    expect(denied.status).toBe(401);
    const allowed = await avwapStatusGet(new NextRequest("https://options-scan.vercel.app/api/telegram/avwap-status", {
      headers: { authorization: "Bearer cron-token" },
    }));
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain(phrase);
    expect(encoded).not.toContain("messageIds");
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({
      id: "alert1",
      isTest: false,
      repeatsSent: 0,
      acknowledged: false,
      acknowledgedAt: null,
      ackVia: null,
      stoppedReason: null,
    });
    const rows = avwapStatusRows(book([pending({ text: phrase, isTest: true, stop: "ack", acknowledged: true, ackVia: "reply" })]));
    expect(JSON.stringify(rows)).not.toContain(phrase);
    expect(rows[0].isTest).toBe(true);
    expect(rows[0].stoppedReason).toBe("acknowledged");
    expect(rows[0].ackVia).toBe("reply");
    clearMemoryStoreForTests();
  });
});

function callbackUpdate(alertId: string, chatId: number) {
  return {
    callback_query: {
      id: "cb-1",
      data: `ack:${alertId}`,
      message: { message_id: 10, chat: { id: chatId } },
    },
  };
}

function harnessAt(nowMs: number) {
  let text = JSON.stringify(emptyAvwapRepeatBook());
  const sent: string[] = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  const answers: string[] = [];
  const io: AvwapRepeatIo = {
    now: () => nowMs,
    read: async () => text,
    write: async (change) => {
      const next = change(text);
      if (next == null) return false;
      text = next;
      return true;
    },
    closedTradeIds: async () => new Set(),
    send: async (message, callback) => {
      expect(callback.startsWith("ack:")).toBe(true);
      sent.push(message);
      return { ok: true, messageId: 40 + sent.length };
    },
    edit: async (messageId, next) => {
      edits.push({ messageId, text: next });
      return true;
    },
    answer: async (callbackId) => {
      answers.push(callbackId);
      return true;
    },
  };
  return {
    io,
    sent,
    edits,
    answers,
    get text() { return text; },
    set text(value: string) { text = value; },
  };
}
