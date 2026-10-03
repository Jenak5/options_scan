import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { TRADE_RULES } from "@/app/lib/alertConfig";
import { planExits } from "@/app/lib/exits";
import { SHADOW_QUOTES_PER_RUN } from "@/app/lib/flow";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import {
  clearMemoryStoreForTests,
  readShadowBookText,
  updateAlertBook,
  updateShadowBook,
  updateTradeLog,
} from "@/app/lib/schwabStore";
import {
  addMissingShadows,
  applyShadowQuote,
  emptyShadowBook,
  LAST_WEEK_CALENDAR_DAYS,
  markFromQuote,
  mergeShadowBooks,
  parseShadowBook,
  shadowFromAlert,
  shadowsToCsv,
  shadowsToQuote,
  summarizeShadows,
  type ShadowTrade,
} from "@/app/lib/shadow";
import { loadShadowPage, runShadowPass, shadowCsv } from "@/app/lib/shadowStore";
import { addTrade, buildTrade, emptyTradeLog } from "@/app/lib/trades";

const OPEN = new Date("2026-10-01T15:00:00Z");
const THREE_DAYS = new Date("2026-10-06T15:00:00Z");

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "SCHWAB_CLIENT_ID",
  "SCHWAB_CLIENT_SECRET",
  "SCHWAB_REDIRECT_URI",
  "NODE_ENV",
] as const;

const saved: Record<string, string | undefined> = {};

function alert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "1727790000000-SPY|2026-10-16|670|call",
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: OPEN.getTime(),
    tradingDay: "2026-10-01",
    ticker: "SPY",
    putCall: "call",
    strike: 670,
    expiration: "2026-10-16",
    bid: 1.9,
    ask: 2,
    mid: 1.95,
    underlyingPrice: 670,
    volume: 800,
    openInterest: 500,
    flowScore: 10,
    liquidityPasses: true,
    side: "estimated at ask",
    verdict: "TAKE",
    verdictLabel: "TAKE",
    grade: "A",
    reasons: ["Flow"],
    note: "",
    levels: null,
    levelsNote: null,
    eventLine: null,
    maxContracts: 4,
    checkpoints: {
      m15: emptyCheckpoint(),
      h1: emptyCheckpoint(),
      close: emptyCheckpoint(),
    },
    outcome: "pending",
    ...over,
  };
}

function openShadow(over: Partial<ShadowTrade> = {}): ShadowTrade {
  const row = shadowFromAlert(alert());
  if (!row) throw new Error("expected a shadow");
  return { ...row, ...over };
}

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
});

describe("shadow exits", () => {
  it("buys one contract at the ask and ignores a C", () => {
    const row = shadowFromAlert(alert());
    expect(row?.contracts).toBe(1);
    expect(row?.entryPrice).toBe(2);
    expect(row?.entryPriceSource).toBe("ask");
    expect(shadowFromAlert(alert({ grade: "C" }))).toBeNull();
    const added = addMissingShadows(emptyShadowBook(), [alert(), alert(), alert({ grade: "B", id: "1727790000000-QQQ|2026-10-16|500|put", ticker: "QQQ", putCall: "put" })]);
    expect(added.opened).toBe(2);
    expect(addMissingShadows(added.book, [alert()]).opened).toBe(0);
  });

  it("prefers the midpoint and falls back to the bid", () => {
    expect(markFromQuote({ mid: 2.1, bid: 2 })?.source).toBe("mid");
    expect(markFromQuote({ mid: null, bid: 1.8 })?.source).toBe("bid");
    expect(markFromQuote({ mid: 0, bid: 0 })).toBeNull();
  });

  it("closes the whole contract at the profit target", () => {
    const plan = planExits({ premium: 2, contracts: 1, structure: "single" });
    expect(plan?.takeContracts).toBe(1);
    expect(plan?.profitPrice).toBeCloseTo(2 * (1 + TRADE_RULES.profitTargetFraction), 6);
    const closed = applyShadowQuote(openShadow(), { mid: plan?.profitPrice ?? 0, bid: 2.7 }, OPEN);
    expect(closed.status).toBe("closed");
    expect(closed.exitReason).toBe("profit");
    expect(closed.exitQuote).toBe("mid");
    expect(closed.pnlDollars).toBeCloseTo((closed.exitPrice! - 2) * 100, 6);
    expect(closed.pnlFraction).toBeCloseTo(TRADE_RULES.profitTargetFraction, 6);
    expect(closed.pnlDollars).toBeCloseTo(80, 6);
  });

  it("stops at 25 percent, and tightens the stop when that loss would pass $875", () => {
    const small = planExits({ premium: 2, contracts: 1, structure: "single" });
    expect(small?.stopTightened).toBe(false);
    const stopped = applyShadowQuote(openShadow(), { mid: small?.stopPrice ?? 0, bid: 1.4 }, OPEN);
    expect(stopped.exitReason).toBe("stop");
    expect(stopped.pnlDollars).toBeCloseTo(-50, 6);

    const wide = planExits({ premium: 40, contracts: 1, structure: "single" });
    expect(wide?.stopTightened).toBe(true);
    expect(wide?.stopDollars).toBe(MAX_LOSS_DOLLARS);
    const held = applyShadowQuote(openShadow({ entryPrice: 40 }), { mid: (wide?.stopPrice ?? 0) + 0.05, bid: 31 }, OPEN);
    expect(held.status).toBe("open");
    const capped = applyShadowQuote(openShadow({ entryPrice: 40 }), { mid: wide?.stopPrice ?? 0, bid: 30 }, OPEN);
    expect(capped.exitReason).toBe("stop");
    expect(capped.pnlDollars).toBeCloseTo(-MAX_LOSS_DOLLARS, 4);
  });

  it("exits a flat shadow after 3 trading days and before the last week", () => {
    const flat = applyShadowQuote(openShadow(), { mid: 2, bid: 1.95 }, THREE_DAYS);
    expect(flat.exitReason).toBe("flat");
    expect(flat.tradingDaysHeld).toBe(3);
    expect(flat.pnlDollars).toBe(0);

    const early = applyShadowQuote(openShadow(), { mid: 2, bid: 1.95 }, new Date("2026-10-02T15:00:00Z"));
    expect(early.status).toBe("open");

    const lastWeek = applyShadowQuote(
      openShadow({ expiration: "2026-10-08" }),
      { mid: 2.2, bid: 2.1 },
      OPEN,
    );
    expect(LAST_WEEK_CALENDAR_DAYS).toBe(7);
    expect(lastWeek.exitReason).toBe("expiration");

    const stillRoom = applyShadowQuote(
      openShadow({ expiration: "2026-10-09" }),
      { mid: 2.2, bid: 2.1 },
      OPEN,
    );
    expect(stillRoom.status).toBe("open");

    const stale = applyShadowQuote(
      openShadow({ expiration: "2026-09-20", lastMark: 1.2, lastMarkSource: "bid" }),
      null,
      OPEN,
    );
    expect(stale.exitReason).toBe("expiration");
    expect(stale.exitStale).toBe(true);
    expect(stale.exitPrice).toBe(1.2);
    expect(stale.exitQuote).toBe("bid");
  });
});

describe("shadow scorecard", () => {
  it("splits A and B, ticker, and call or put, and leaves out paper trades", () => {
    const win = applyShadowQuote(openShadow(), { mid: 2.8, bid: 2.7 }, OPEN);
    const loss = applyShadowQuote(openShadow({
      id: "1727790000001-QQQ|2026-10-16|500|put",
      alertId: "1727790000001-QQQ|2026-10-16|500|put",
      ticker: "QQQ",
      putCall: "put",
      grade: "B",
    }), { mid: 1.5, bid: 1.4 }, OPEN);
    const paper = applyShadowQuote(openShadow({
      id: "1727790000002-IWM|2026-10-16|240|call",
      alertId: "1727790000002-IWM|2026-10-16|240|call",
      ticker: "IWM",
    }), { mid: 2.8, bid: 2.7 }, OPEN);
    const card = summarizeShadows([win, loss, paper], new Set([paper.alertId]), OPEN);
    expect(card.resolved).toBe(2);
    expect(card.excludedPaper).toBe(1);
    expect(card.tooFew).toBe(true);
    expect(card.sampleNote).toContain("Fewer than 30");
    expect(card.wins).toBe(1);
    expect(card.losses).toBe(1);
    expect(card.winRate).toBe(0.5);
    expect(card.averageWin).toBeCloseTo(80, 6);
    expect(card.averageLoss).toBeCloseTo(50, 6);
    expect(card.totalPnl).toBeCloseTo(30, 6);
    expect(card.byGrade.find((bucket) => bucket.key === "A")?.pnlDollars).toBeCloseTo(80, 6);
    expect(card.byGrade.find((bucket) => bucket.key === "B")?.pnlDollars).toBeCloseTo(-50, 6);
    expect(card.byRight.find((bucket) => bucket.key === "call")?.closed).toBe(1);
    expect(card.byRight.find((bucket) => bucket.key === "put")?.closed).toBe(1);
    expect(card.byTicker.map((bucket) => bucket.key)).toEqual(["QQQ", "SPY"]);
    expect(card.estimateNote).toMatch(/not fills/);
    expect(card.estimateNote).not.toContain("\u2014");
    const csv = shadowsToCsv([win, paper], new Set([paper.alertId]));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("pnlPercent");
    expect(lines.find((line) => line.startsWith(win.id))?.endsWith(",yes")).toBe(true);
    expect(lines.find((line) => line.startsWith(paper.id))?.endsWith(",no")).toBe(true);
  });

  it("quotes a capped set of open contracts and does not reopen a closed shadow", () => {
    const rows: ShadowTrade[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(openShadow({
        id: `1727790000000-T${i}|2026-10-16|100|call`,
        alertId: `1727790000000-T${i}|2026-10-16|100|call`,
        ticker: `T${i}`,
      }));
    }
    expect(shadowsToQuote(rows).length).toBe(SHADOW_QUOTES_PER_RUN);
    const closed = applyShadowQuote(rows[0], { mid: 2.8, bid: 2.7 }, OPEN);
    const merged = mergeShadowBooks(
      { version: 1, records: [closed] },
      { version: 1, records: [{ ...rows[0] }] },
    );
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].status).toBe("closed");
    expect(parseShadowBook(JSON.stringify(merged)).records[0].exitReason).toBe("profit");
  });
});

describe("shadow store", () => {
  it("saves an A from the alert book and leaves a paper trade out of the totals", async () => {
    const saved = alert();
    expect(await updateAlertBook(() => JSON.stringify({ version: 1, records: [saved], dailyLoss: null }))).toBe(true);
    const first = await runShadowPass(OPEN);
    expect(first.opened).toBe(1);
    expect(first.saved).toBe(true);
    const second = await runShadowPass(OPEN);
    expect(second.opened).toBe(0);
    const page = await loadShadowPage(OPEN);
    expect(page.stored).toBe(true);
    expect(page.open).toBe(1);
    expect(page.resolved).toBe(0);

    const built = buildTrade({
      ticker: "SPY",
      putCall: "call",
      strike: 670,
      expiration: "2026-10-16",
      contracts: 1,
      entryPrice: 2,
      alertId: saved.id,
      alertGrade: "A",
      alertVerdict: "TAKE",
    }, "t_shadowpaper12345", OPEN);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(await updateTradeLog(() => JSON.stringify(addTrade(emptyTradeLog(), built.trade)))).toBe(true);
    const excluded = await loadShadowPage(OPEN);
    expect(excluded.excludedPaper).toBe(1);
    expect(excluded.open).toBe(0);
    const csv = await shadowCsv();
    expect(csv).toContain(saved.ticker);
    expect(csv).toContain(",no");
  });

  it("does not replace an unreadable scorecard", async () => {
    expect(await updateShadowBook(() => JSON.stringify(emptyShadowBook()))).toBe(true);
    expect(await updateShadowBook(() => "{")).toBe(true);
    const kept = await updateShadowBook(() => JSON.stringify(emptyShadowBook()));
    expect(kept).toBe(false);
    expect(await readShadowBookText()).toBe("{");
  });
});
