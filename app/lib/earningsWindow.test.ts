import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAlertBook, emptyCheckpoint, type StoredAlert } from "@/app/lib/alertBook";
import { ALERT_RULES, EARNINGS_WINDOW, EVENT_RULES, TRADE_RULES } from "@/app/lib/alertConfig";
import { chooseAlerts } from "@/app/lib/alertPolicy";
import { rememberSentAlert } from "@/app/lib/alertStore";
import { IV_CRUSH_SENTENCE } from "@/app/lib/eventRisk";
import { whatIfFromShadows } from "@/app/lib/exitWhatIf";
import { SHADOW_QUOTES_PER_RUN, addCalendarDays, type FlowRow } from "@/app/lib/flow";
import { countShadowTotals } from "@/app/lib/healthReport";
import { analyzeLearning } from "@/app/lib/learn";
import type { KeyLevels } from "@/app/lib/levels";
import { chicagoTradingDaysElapsed } from "@/app/lib/marketHours";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import { clearMemoryStoreForTests, readAlertBookText, readShadowBookText } from "@/app/lib/schwabStore";
import {
  LAST_WEEK_CALENDAR_DAYS,
  applyShadowQuote,
  excludedFromMainTotals,
  isExperimentShadow,
  parseShadowBook,
  serializeShadowBook,
  shadowFromAlert,
  shadowsToCsv,
  shadowsToQuote,
  summarizeShadows,
  type ShadowTrade,
} from "@/app/lib/shadow";
import { openMissingShadows, recordEarningsWindowShadows } from "@/app/lib/shadowStore";
import { gradeFlowRow } from "@/app/lib/verdict";
import {
  alertInEarningsWindow,
  chooseEarningsDate,
  chooseEarningsWindow,
  earningsDateMapForRows,
  earningsInsideHoldWindow,
  earningsWindowProbe,
  earningsWindowShadow,
  windowEarningsDateForContract,
} from "@/app/lib/earningsWindow";

/** After the last listed 2026 macro, and after the first 15 Chicago minutes. */
const NOW = new Date("2026-12-16T15:00:00Z");
const OPEN = new Date("2026-11-25T15:00:00Z");
const STILL_OPEN = new Date("2026-11-30T15:00:00Z");
const FLAT_DAY = new Date("2026-12-01T15:00:00Z");

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
  "SCHWAB_CLIENT_ID",
  "SCHWAB_CLIENT_SECRET",
  "SCHWAB_REDIRECT_URI",
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
  "TASTYTRADE_ENABLED",
  "NODE_ENV",
] as const;

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
  vi.unstubAllGlobals();
});

describe("earnings in window", () => {
  it("keeps the group label, the A/B window, and the one-step downgrade", () => {
    expect(EARNINGS_WINDOW).toMatchObject({
      minCalendarDays: 1,
      maxCalendarDays: 14,
      label: "Earnings in window",
      minTrust: 30,
      opensPerRun: 2,
      opensPerDay: 4,
    });
    expect(ALERT_RULES.alertDteMin).toBe(14);
    expect(ALERT_RULES.alertDteMax).toBe(42);
    expect(EVENT_RULES.earningsDowngradeSteps).toBe(1);
    expect(TRADE_RULES.profitTargetFraction).toBe(0.4);
    expect(TRADE_RULES.flatAfterTradingDays).toBe(3);
    expect(LAST_WEEK_CALENDAR_DAYS).toBe(7);
    expect(RULES_VERSION).toBe(3);
    expect(SHADOW_QUOTES_PER_RUN).toBe(16);
  });

  it("uses Tastytrade first and Yahoo only when that date is missing", async () => {
    const yahoo = { status: "known" as const, date: "2026-12-23", timing: "after-market" as const, estimated: false };
    expect(chooseEarningsDate("2026-12-18", yahoo, "2026-12-16")).toBe("2026-12-18");
    expect(chooseEarningsDate("2026-12-16", yahoo, "2026-12-16")).toBe("2026-12-16");
    expect(chooseEarningsDate(null, yahoo, "2026-12-16")).toBe("2026-12-23");
    expect(chooseEarningsDate("2026-12-01", yahoo, "2026-12-16")).toBe("2026-12-23");
    expect(chooseEarningsDate("not-a-date", { status: "unknown", date: null, timing: null, estimated: false }, "2026-12-16")).toBeNull();

    const row = heldRow();
    const preferred = await earningsDateMapForRows([row], NOW, {
      loadTastytrade: async () => new Map([["NVDA", "2026-12-18"]]),
    });
    expect(preferred.get("NVDA")).toBe("2026-12-18");

    const backup = await earningsDateMapForRows([row], NOW, {
      loadTastytrade: async () => null,
    });
    expect(backup.get("NVDA")).toBe("2026-12-23");

    const failed = await earningsDateMapForRows([row], NOW, {
      loadTastytrade: async () => {
        throw new Error("market metrics down");
      },
    });
    expect(failed.get("NVDA")).toBe("2026-12-23");
  });

  it("reads market metrics and does not call an account or order endpoint", async () => {
    process.env.TASTYTRADE_CLIENT_ID = "client";
    process.env.TASTYTRADE_CLIENT_SECRET = "secret";
    process.env.TASTYTRADE_REFRESH_TOKEN = "refresh";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/orders") || url.includes("/accounts") || url.includes("/positions")) {
        throw new Error(`account endpoint ${url}`);
      }
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 60 }), { status: 200 });
      }
      if (url.includes("/market-metrics")) {
        return new Response(JSON.stringify({
          data: { items: [{ symbol: "NVDA", earnings: { "expected-report-date": "2026-12-18" } }] },
        }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });

    const dates = await earningsDateMapForRows([heldRow()], NOW);
    expect(dates.get("NVDA")).toBe("2026-12-18");
    expect(urls.some((url) => url.includes("/oauth/token"))).toBe(true);
    expect(urls.some((url) => url.includes("/market-metrics"))).toBe(true);
    expect(urls.some((url) => url.includes("/orders") || url.includes("/accounts") || url.includes("/positions"))).toBe(false);
  });

  it("counts 1 to 14 days only while the contract is still inside the hold", () => {
    const today = "2026-12-16";
    const expiration = "2027-01-06";
    const lastHeld = addCalendarDays(expiration, -(LAST_WEEK_CALENDAR_DAYS + 1));
    expect(lastHeld).toBe("2026-12-29");
    expect(earningsInsideHoldWindow({ today, earningsDate: "2026-12-16", expiration })).toBe(false);
    expect(earningsInsideHoldWindow({ today, earningsDate: "2026-12-17", expiration })).toBe(true);
    expect(earningsInsideHoldWindow({ today, earningsDate: lastHeld, expiration })).toBe(true);
    expect(earningsInsideHoldWindow({ today, earningsDate: "2026-12-30", expiration })).toBe(false);
    expect(earningsInsideHoldWindow({ today, earningsDate: expiration, expiration })).toBe(false);

    const longExpiration = "2027-02-04";
    expect(earningsInsideHoldWindow({ today, earningsDate: "2026-12-30", expiration: longExpiration })).toBe(true);
    expect(earningsInsideHoldWindow({ today, earningsDate: "2026-12-31", expiration: longExpiration })).toBe(false);
  });

  it("leaves a real A or B on its letter and opens paper only when the downgrade keeps it out", () => {
    const saved = heldRow();
    const real = gradeFlowRow(saved, null, NOW);
    expect(real.verdict).toBe("TAKE");
    expect(real.grade).toBe("B");
    expect(real.eventLine).toContain(IV_CRUSH_SENTENCE);
    const clear = gradeFlowRow(heldRow({
      earnings: { status: "known", date: "2027-06-01", timing: "after-market", estimated: false },
    }), null, NOW);
    expect(clear.grade).toBe("A");
    expect(clear.verdict).toBe("TAKE");
    expect(earningsWindowProbe(saved, null, NOW)).toBeNull();

    const knocked = knockedRow();
    const down = gradeFlowRow(knocked, null, NOW);
    expect(down.grade).toBe("C");
    expect(down.verdict).toBe("TAKE");
    const lifted = gradeFlowRow(knockedRow({
      earnings: { status: "known", date: "2027-06-01", timing: "after-market", estimated: false },
    }), null, NOW);
    expect(lifted.grade).toBe("B");
    expect(lifted.verdict).toBe("TAKE");
    expect(earningsWindowProbe(knocked, null, NOW)).toBe("B");

    expect(chooseAlerts({
      candidates: [
        { row: saved, verdict: real },
        { row: knocked, verdict: down },
      ],
      alreadySentContractKeys: new Set(),
      alreadySentSetupKeys: new Set(),
      limit: 5,
    }).map((item) => item.row.id)).toEqual([saved.id]);

    expect(earningsWindowProbe(heldRow({ dte: 50, expiration: "2027-02-04" }), null, NOW)).toBeNull();
    expect(earningsWindowProbe(heldRow({ dte: 5, expiration: "2026-12-21" }), null, NOW)).toBeNull();
    expect(earningsWindowProbe(heldRow({
      earnings: { status: "unknown", date: null, timing: null, estimated: false },
    }), null, NOW)).toBeNull();
    expect(gradeFlowRow(heldRow({
      earnings: { status: "unknown", date: null, timing: null, estimated: false },
    }), null, NOW).grade).toBe("B");
  });

  it("caps paper opens per run and per day and does not copy a saved A or B", () => {
    const dates = new Map<string, string | null>([["NVDA", "2026-12-23"], ["AMD", "2026-12-23"]]);
    const rows = [140, 145, 150, 155, 160].map((strike, index) => knockedRow({
      strike,
      id: `AMD|2027-01-06|${strike}|call`,
      score: 10 * (index + 1),
    }));
    const first = chooseEarningsWindow({ rows, consecutiveLosses: null, now: NOW, existing: [], dates });
    expect(first).toHaveLength(EARNINGS_WINDOW.opensPerRun);
    expect(first.map((pick) => pick.row.strike)).toEqual([160, 155]);
    expect(first.every((pick) => pick.probe === "B" && pick.earningsDate === "2026-12-23")).toBe(true);

    const opened = first.map((pick) => earningsWindowShadow(pick.row, pick.probe, NOW)).filter((row): row is ShadowTrade => row != null);
    const again = chooseEarningsWindow({ rows, consecutiveLosses: null, now: NOW, existing: opened, dates });
    expect(again.map((pick) => pick.row.strike)).toEqual([150, 145]);
    const today = opened.concat(again.map((pick) => earningsWindowShadow(pick.row, pick.probe, NOW)).filter((row): row is ShadowTrade => row != null));
    expect(chooseEarningsWindow({ rows, consecutiveLosses: null, now: NOW, existing: today, dates })).toEqual([]);

    const savedAb = shadowFromAlert(sentAlert({
      ticker: "NVDA",
      contractKey: heldRow().id,
      id: `alert-${heldRow().id}`,
      strike: 104,
      expiration: heldRow().expiration,
      windowEarningsDate: "2026-12-23",
      sentAt: NOW.getTime(),
    }));
    if (!savedAb) throw new Error("expected a saved earnings shadow");
    expect(savedAb.cohort).toBe("experiment-earnings");
    expect(savedAb.grade).toBe("A");
    const withSaved = chooseEarningsWindow({
      rows: [heldRow(), ...rows],
      consecutiveLosses: null,
      now: NOW,
      existing: [savedAb],
      dates,
    });
    expect(withSaved.every((pick) => pick.row.ticker === "AMD")).toBe(true);
    expect(withSaved).toHaveLength(EARNINGS_WINDOW.opensPerRun);
  });

  it("keeps the group out of the main totals and uses the same exits, including a holiday", () => {
    const alert = sentAlert({
      sentAt: NOW.getTime(),
      expiration: "2027-01-06",
      windowEarningsDate: "2026-12-23",
    });
    const saved = shadowFromAlert(alert);
    if (!saved) throw new Error("expected a saved shadow");
    expect(alertInEarningsWindow(alert)).toBe(true);
    expect(excludedFromMainTotals(saved)).toBe(true);
    expect(isExperimentShadow(saved)).toBe(false);
    const profit = applyShadowQuote(saved, { mid: 2.9, bid: 2.8 }, NOW);
    expect(profit.exitReason).toBe("profit");
    expect(profit.cohort).toBe("experiment-earnings");
    expect(profit.grade).toBe("A");

    const paper = earningsWindowShadow(knockedRow(), "B", OPEN);
    if (!paper) throw new Error("expected a paper shadow");
    expect(paper.grade).toBe("test");
    expect(paper.cohort).toBe("experiment-earnings");
    expect(paper.experimentLabel).toBe("Earnings in window");
    expect(paper.rulesVersion).toBe(RULES_VERSION);
    expect(paper.id.startsWith("ewin")).toBe(true);
    const stopped = applyShadowQuote(paper, { mid: 1.5, bid: 1.45 }, OPEN);
    expect(stopped.exitReason).toBe("stop");

    const holding = earningsWindowShadow(knockedRow({ id: "AMD|2027-01-06|150|call", strike: 150 }), "B", OPEN);
    if (!holding) throw new Error("expected a holding shadow");
    const dayTwo = applyShadowQuote(holding, { mid: 2.05, bid: 2 }, STILL_OPEN);
    expect(dayTwo.status).toBe("open");
    expect(chicagoTradingDaysElapsed(OPEN, STILL_OPEN)).toBe(2);
    const flat = applyShadowQuote(dayTwo, { mid: 2.05, bid: 2 }, FLAT_DAY);
    expect(flat.exitReason).toBe("flat");
    expect(flat.tradingDaysHeld).toBe(3);
    expect(chicagoTradingDaysElapsed(OPEN, FLAT_DAY)).toBe(3);

    const plainOpen = shadowFromAlert(sentAlert());
    if (!plainOpen) throw new Error("expected an A/B shadow");
    const plain = applyShadowQuote(plainOpen, { mid: 2.9, bid: 2.8 }, OPEN);
    expect(plain.exitReason).toBe("profit");
    expect(plain.cohort).toBe("ab");
    const card = summarizeShadows([profit, stopped, plain], new Set(), NOW);
    expect(card.resolved).toBe(1);
    expect(card.wins).toBe(1);
    expect(card.rows.every((row) => row.cohort === "ab")).toBe(true);
    expect(card.experimental.resolved).toBe(0);
    expect(card.experimentalShort.resolved).toBe(0);
    expect(card.experimentalEarnings.label).toBe("Earnings in window");
    expect(card.experimentalEarnings.resolved).toBe(2);
    expect(card.experimentalEarnings.rows).toHaveLength(2);
    expect(card.experimentalEarnings.note).toMatch(/Telegram alerts are unchanged/);
    expect(card.experimentalEarnings.rows.some((row) => row.probeNote?.includes("Saved as A"))).toBe(true);
    expect(card.experimentalEarnings.rows.some((row) => row.probeNote?.includes("would say B"))).toBe(true);
    expect(countShadowTotals([profit, stopped, plain])).toEqual({ openShadows: 0, resolvedShadows: 1 });

    const csv = shadowsToCsv([profit, stopped, plain], new Set());
    expect(csv).toContain("experiment-earnings");
    expect(linesCounted(csv, "yes")).toBe(1);
    expect(linesCounted(csv, "no")).toBe(2);

    const replay = whatIfFromShadows([
      { ...plain, marks: [{ at: plain.openedAt, price: 2.1 }] },
      { ...profit, marks: [{ at: profit.openedAt, price: 2.4 }] },
    ]);
    expect(replay.included).toBe(1);
    expect(replay.skipped).toBe(0);
  });

  it("keeps a saved A or B in the regular quote slots and shares the test slots", () => {
    const saved = shadowFromAlert(sentAlert({
      id: "earnings-window-saved-ab",
      contractKey: "NVDA|2027-01-06|104|call",
      ticker: "NVDA",
      strike: 104,
      expiration: "2027-01-06",
      sentAt: NOW.getTime(),
      windowEarningsDate: "2026-12-23",
    }));
    if (!saved) throw new Error("expected a saved earnings shadow");
    const primary = Array.from({ length: 15 }, (_, index) => abShadow(index));
    const papers = [1, 2, 3].map((strike) => {
      const row = earningsWindowShadow(knockedRow({ strike, id: `AMD|2027-01-06|${strike}|call` }), "B", NOW);
      if (!row) throw new Error("expected a paper shadow");
      return row;
    });
    const quoted = shadowsToQuote(primary.concat(saved, papers));
    expect(quoted.filter((row) => row.cohort === "experiment-earnings" && row.grade === "A")).toHaveLength(1);
    expect(quoted.filter((row) => row.grade === "test")).toHaveLength(0);
    expect(quoted).toHaveLength(SHADOW_QUOTES_PER_RUN);

    const room = shadowsToQuote(primary.slice(0, 12).concat(papers));
    expect(room.filter((row) => row.grade === "test")).toHaveLength(EARNINGS_WINDOW.opensPerDay - 1);
    expect(room.filter((row) => isExperimentShadow(row))).toHaveLength(3);
  });

  it("round-trips the cohort and stores the date only when it is a calendar day", () => {
    const saved = shadowFromAlert(sentAlert({
      sentAt: NOW.getTime(),
      expiration: "2027-01-06",
      windowEarningsDate: "2026-12-23",
    }));
    const paper = earningsWindowShadow(knockedRow(), "B", NOW);
    const parsed = parseShadowBook(serializeShadowBook({ version: 1, records: [saved, paper].filter((row): row is ShadowTrade => row != null) }));
    expect(parsed.records.map((row) => `${row.cohort}:${row.grade}`).sort()).toEqual([
      "experiment-earnings:A",
      "experiment-earnings:test",
    ]);

    const raw = JSON.parse(JSON.stringify(paper)) as Record<string, unknown>;
    delete raw.cohort;
    delete raw.experimentLabel;
    delete raw.probeGrade;
    raw.grade = "test";
    const legacy = parseShadowBook(JSON.stringify({ version: 1, records: [raw] })).records[0];
    expect(legacy.cohort).toBe("experiment");
    expect(legacy.experimentLabel).toBe("Test: 43-60 DTE");

    raw.cohort = "experiment-earnings";
    raw.grade = "C";
    expect(parseShadowBook(JSON.stringify({ version: 1, records: [raw] })).records).toHaveLength(0);
  });

  it("stamps a saved alert, opens that shadow once, and records paper rows without a second copy", async () => {
    const dates = await earningsDateMapForRows([heldRow(), knockedRow()], NOW, {
      loadTastytrade: async () => new Map([["NVDA", "2026-12-23"], ["AMD", "2026-12-23"]]),
    });
    const heldDate = windowEarningsDateForContract({
      ticker: "NVDA",
      expiration: heldRow().expiration,
      now: NOW,
      dates,
    });
    expect(heldDate).toBe("2026-12-23");
    const saved = await rememberSentAlert(heldRow(), gradeFlowRow(heldRow(), null, NOW), NOW, heldDate);
    expect(saved).toBe(true);
    const book = parseAlertBook(await readAlertBookText());
    expect(book.records[0]?.windowEarningsDate).toBe("2026-12-23");
    expect(book.records[0]?.grade).toBe("B");

    const text = await readAlertBookText();
    const edited = JSON.parse(text ?? "{}") as { records: Array<Record<string, unknown>> };
    edited.records[0].windowEarningsDate = "soon";
    expect(parseAlertBook(JSON.stringify(edited)).records[0]?.windowEarningsDate).toBeUndefined();

    const opened = await openMissingShadows();
    expect(opened.opened).toBe(1);
    const shadows = parseShadowBook(await readShadowBookText());
    expect(shadows.records).toHaveLength(1);
    expect(shadows.records[0]?.cohort).toBe("experiment-earnings");
    expect(shadows.records[0]?.grade).toBe("B");

    const paper = await recordEarningsWindowShadows([heldRow(), knockedRow()], null, NOW, dates);
    expect(paper).toEqual({ opened: 1, saved: true });
    const again = await recordEarningsWindowShadows([heldRow(), knockedRow()], null, NOW, dates);
    expect(again).toEqual({ opened: 0, saved: true });
    const both = parseShadowBook(await readShadowBookText());
    expect(both.records).toHaveLength(2);
    expect(both.records.filter((row) => row.grade === "test" && row.cohort === "experiment-earnings")).toHaveLength(1);
    expect(both.records.filter((row) => row.grade === "B")).toHaveLength(1);
  });

  it("learns the group apart from the main results and from the 43-60 test", () => {
    const paper = earningsWindowShadow(knockedRow(), "B", NOW);
    if (!paper) throw new Error("expected a paper shadow");
    const closed = applyShadowQuote(paper, { mid: 1.5, bid: 1.45 }, NOW);
    const report = analyzeLearning({
      shadows: [closed],
      alerts: [],
      trades: [],
      checksByTradeId: new Map(),
      now: NOW,
    });
    expect(report.resolved).toBe(0);
    expect(report.testResolved).toBe(1);
    const dte = report.factors.find((factor) => factor.id === "dte");
    expect(dte?.buckets.find((bucket) => bucket.key === "Earnings in window")).toMatchObject({ count: 1, losses: 1 });
    expect(dte?.buckets.find((bucket) => bucket.key === "43–60 days (test)")).toBeUndefined();
    const text = report.summary.join(" ");
    expect(text).toContain("0 resolved test shadows (43–60 days)");
    expect(text).toContain("1 resolved in Earnings in window");
    expect(text).toMatch(/Test 43–60 DTE has 0 resolved results/);
    expect(text).toMatch(/earnings downgrade is unchanged/i);
    expect(report.trades.find((row) => row.id === closed.id)?.cohort).toBe("experiment-earnings");
  });
});

function linesCounted(csv: string, flag: "yes" | "no"): number {
  return csv.trim().split("\n").filter((line) => line.endsWith(`,${flag}`)).length;
}

function heldRow(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "NVDA|2027-01-06|104|call",
    ticker: "NVDA",
    putCall: "call",
    strike: 104,
    expiration: "2027-01-06",
    bid: 2,
    ask: 2.05,
    last: 2.05,
    volume: 3000,
    openInterest: 1000,
    iv: 0.25,
    delta: 0.4,
    mid: 2.025,
    notionalPremium: 607_500,
    volOiRatio: 3,
    volumeOiJump: 2000,
    volumeExceedsOi: true,
    previousVolume: 2600,
    volumeJump: 400,
    otmPoints: 4,
    otmFraction: 0.04,
    otm: true,
    dte: 21,
    spreadFraction: 0.025,
    spreadQuality: "acceptable",
    side: "estimated at ask",
    sideNote: "Estimated from the last price versus the bid and ask. Not a sweep print.",
    askFraction: 1,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 100,
    levels: levels(),
    prints: EMPTY_PRINTS,
    earnings: { status: "known", date: "2026-12-23", timing: "after-market", estimated: false },
    score: 80,
    ...over,
  };
}

function knockedRow(over: Partial<FlowRow> = {}): FlowRow {
  return heldRow({
    id: "AMD|2027-01-06|140|call",
    ticker: "AMD",
    strike: 140,
    notionalPremium: 60_000,
    volOiRatio: 1.6,
    volume: 1600,
    openInterest: 1000,
    volumeOiJump: 600,
    score: 40,
    ...over,
  });
}

function levels(): KeyLevels {
  return {
    checked: true,
    spot: 100,
    support: { price: 99, label: "prior day low", distance: 0.01 },
    resistance: { price: 102, label: "session high", distance: 0.02 },
    vwap: 100.4,
    sma20: null,
    priorClose: 99.5,
    callWall: 105,
    putWall: 95,
  };
}

function sentAlert(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "1727790000000-SPY|2026-10-16|670|call",
    contractKey: "SPY|2026-10-16|670|call",
    sentAt: OPEN.getTime(),
    tradingDay: "2026-11-25",
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

function abShadow(index: number): ShadowTrade {
  const row = shadowFromAlert(sentAlert({
    id: `1727790000000-T${index}|2026-10-16|100|call`,
    contractKey: `T${index}|2026-10-16|100|call`,
    ticker: `T${index}`,
  }));
  if (!row) throw new Error("expected an A shadow");
  return row;
}
