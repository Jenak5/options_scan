import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStoredAlert } from "@/app/lib/alertBook";
import type { AlertVerdict } from "@/app/lib/verdict";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { SPY_TREND_NOTE } from "@/app/lib/marketContext";
import {
  RESEARCH_MARK_CAP,
  addResearchTracks,
  trimResearchTracks,
  type ResearchTrack,
} from "@/app/lib/researchTrack";
import { SHADOW_MARK_CAP, parseShadowBook, shadowFromAlert, summarizeShadows } from "@/app/lib/shadow";
import { loadShadowPage, markShadowsFromRows, runShadowPass } from "@/app/lib/shadowStore";
import { parseLearnGrades } from "@/app/lib/learnStore";
import { clearMemoryStoreForTests, readShadowBookText, readTokens, updateShadowBook } from "@/app/lib/schwabStore";
import * as schwab from "@/app/lib/schwab";
import * as tradeQuotes from "@/app/lib/tradeQuotes";
import type { FlowRow } from "@/app/lib/flow";

const OPEN = new Date("2026-10-01T15:00:00Z");
const EVENING = new Date("2026-10-01T22:00:00Z");

function verdict(grade: "A" | "B" | "C" | "D"): AlertVerdict {
  return {
    verdict: grade === "A" || grade === "B" ? "TAKE" : "WATCH",
    verdictLabel: grade === "A" || grade === "B" ? "TAKE" : "WATCH",
    grade,
    uncappedGrade: grade,
    reasons: ["Flow"],
    note: "",
    levels: null,
    levelsNote: null,
    eventLine: "",
    maxContracts: 1,
    singleContractExceedsCap: false,
    suggestion: null,
    liquidityPasses: true,
    dailyStop: false,
  };
}

function row(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: "IWM|2026-12-18|240|put",
    ticker: "IWM",
    putCall: "put",
    strike: 240,
    expiration: "2026-12-18",
    bid: 1.1,
    ask: 1.2,
    last: 1.15,
    volume: 200,
    openInterest: 800,
    iv: 0.2,
    delta: -0.3,
    mid: 1.15,
    notionalPremium: 23_000,
    volOiRatio: 0.25,
    volumeOiJump: null,
    volumeExceedsOi: false,
    previousVolume: null,
    volumeJump: null,
    otmPoints: 2,
    otmFraction: 0.01,
    otm: true,
    dte: 50,
    spreadFraction: 0.04,
    spreadQuality: "acceptable",
    side: "estimated at bid",
    sideNote: "Estimated.",
    askFraction: 0,
    liquidityPasses: true,
    delayed: false,
    underlyingPrice: 238,
    levels: null,
    prints: EMPTY_PRINTS,
    score: 4,
    context: {
      minutesSinceOpen: 90,
      priceVsVwap: "below",
      priceVsSma20: "unknown",
      trendAlignment: "with",
      spyDirection: "down",
      qqqDirection: "unknown",
      marketAlignment: "unknown",
      ivVsRecent: null,
      aggressor: "sell",
      repeatFlow: "unknown",
      pairedFlow: "unknown",
    },
    ...over,
  };
}

function track(index: number, openedAt: number): ResearchTrack {
  const strike = 100 + index;
  return {
    id: `1727790000000-T${index}|2026-12-18|${strike}|call`,
    contractKey: `T${index}|2026-12-18|${strike}|call`,
    alertId: null,
    openedAt,
    ticker: index < 10 ? `T${index}` : `T${index}`,
    putCall: "call",
    strike,
    expiration: "2026-12-18",
    grade: "D",
    entryPrice: 1,
    entryUnderlying: 100,
    spyTrend: "unknown",
    marks: [],
  };
}

beforeEach(() => {
  clearMemoryStoreForTests();
});

afterEach(() => {
  clearMemoryStoreForTests();
  vi.restoreAllMocks();
  delete process.env.SCHWAB_CLIENT_ID;
  delete process.env.SCHWAB_CLIENT_SECRET;
  delete process.env.SCHWAB_REDIRECT_URI;
});

describe("research tracks", () => {
  it("does not open a new C or D, and leaves a stored track in place", () => {
    expect(SPY_TREND_NOTE).toMatch(/session VWAP/);
    expect(SPY_TREND_NOTE).toMatch(/not a 20-day or 50-day/);
    expect(RESEARCH_MARK_CAP).toBe(SHADOW_MARK_CAP);
    const stored = track(1, OPEN.getTime());
    stored.marks = [{ at: OPEN.getTime(), price: 1.1 }];
    const opened = addResearchTracks(
      [stored],
      [
        { row: row(), grade: "C" },
        { row: row({ id: "QQQ|2026-12-18|500|put", ticker: "QQQ", putCall: "put", strike: 500 }), grade: "D" },
        { row: row({ id: "SPY|2026-12-18|670|call", ticker: "SPY", putCall: "call", strike: 670 }), grade: "A" },
      ],
      [buildStoredAlert(row(), verdict("C"), OPEN)],
      OPEN,
    );
    expect(opened.opened).toBe(0);
    expect(opened.tracks).toEqual([stored]);
    const scorecard = shadowFromAlert(buildStoredAlert(row({ id: "SPY|2026-12-18|670|call", ticker: "SPY", putCall: "call", strike: 670, ask: 2 }), verdict("A"), OPEN));
    expect(scorecard?.quoteTrack).toBe(true);
    expect(scorecard?.entryUnderlying).toBe(238);
    expect(scorecard?.spyTrend).toBe("down");
    expect(shadowFromAlert(buildStoredAlert(row(), verdict("C"), OPEN))).toBeNull();
  });

  it("keeps C and D off the scorecard and out of the default what-if", async () => {
    const stored = track(1, OPEN.getTime());
    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: [], research: [stored] }))).toBe(true);
    const book = parseShadowBook(await readShadowBookText());
    expect(book.records).toHaveLength(0);
    expect(book.research).toHaveLength(1);
    const card = summarizeShadows(book.records, new Set(), OPEN);
    expect(card.resolved).toBe(0);
    expect(card.open).toBe(0);
    const page = await loadShadowPage(OPEN);
    expect(page.open).toBe(0);
    expect(page.resolved).toBe(0);
    expect(parseLearnGrades(null)).toBeUndefined();
    expect(parseLearnGrades("c, D, no")).toEqual(["C", "D"]);
  });

  it("does not quote a stored C or D, and still marks an open A", async () => {
    const stored = track(1, OPEN.getTime());
    stored.marks = [{ at: OPEN.getTime() - 60_000, price: 1.05 }];
    const scorecard = shadowFromAlert(buildStoredAlert(
      row({ id: "SPY|2026-12-18|670|call", ticker: "SPY", putCall: "call", strike: 670, ask: 2 }),
      verdict("A"),
      OPEN,
    ));
    expect(scorecard).not.toBeNull();
    expect(await updateShadowBook(() => JSON.stringify({
      version: 1,
      records: [scorecard],
      research: [stored],
    }))).toBe(true);
    const quotes = vi.spyOn(schwab, "getQuoteEntries").mockResolvedValue({ entries: [], problem: null });
    vi.spyOn(tradeQuotes, "quoteContractMarks").mockImplementation(async (trades) => {
      const marks: Record<string, { mid: number | null; bid: number | null }> = {};
      for (let i = 0; i < trades.length; i++) marks[trades[i].id] = { mid: 2.1, bid: 2 };
      return marks;
    });
    const first = await runShadowPass(OPEN, [{ row: row(), grade: "C" }, { row: row({ id: "QQQ|2026-12-18|500|put", ticker: "QQQ", putCall: "put", strike: 500 }), grade: "D" }]);
    expect(first.researchOpened).toBe(0);
    expect(first.researchQuoted).toBe(0);
    expect(first.researchSkipped).toBe(0);
    expect(quotes).not.toHaveBeenCalled();
    const saved = parseShadowBook(await readShadowBookText());
    expect(saved.research).toHaveLength(1);
    expect(saved.research?.[0].marks).toEqual(stored.marks);
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0].lastMark).toBeCloseTo(2.1);
    const page = await loadShadowPage(OPEN);
    expect(page.open).toBe(1);

    const chain = row({ id: stored.contractKey, ticker: stored.ticker, putCall: stored.putCall, strike: stored.strike, mid: 1.4, bid: 1.3, ask: 1.5 });
    const fromPage = await markShadowsFromRows([chain], new Date(OPEN.getTime() + 20 * 60_000), [{ row: chain, grade: "D" }]);
    expect(fromPage.marked).toBe(0);
    const afterPage = parseShadowBook(await readShadowBookText());
    expect(afterPage.research).toEqual(saved.research);
    expect(afterPage.research).toHaveLength(1);

    const evening = await runShadowPass(EVENING, [{ row: row(), grade: "C" }]);
    expect(evening.researchOpened).toBe(0);
    expect(evening.researchQuoted).toBe(0);
    const afterEvening = parseShadowBook(await readShadowBookText());
    expect(afterEvening.research).toHaveLength(1);
    expect(afterEvening.research?.[0].marks).toEqual(stored.marks);
  });

  it("keeps every active track when the book is past the old 400-row cap", () => {
    const now = new Date("2026-10-13T18:00:00Z");
    const active = Array.from({ length: 401 }, (_, index) => track(index, Date.parse("2026-10-12T15:00:00Z")));
    const kept = addResearchTracks(active, [], [], now);
    expect(kept.tracks).toHaveLength(401);
    expect(kept.opened).toBe(0);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const older = track(500, Date.parse("2026-08-03T15:00:00Z"));
    const finished = track(501, Date.parse("2026-09-01T15:00:00Z"));
    const stillOpen = [track(502, Date.parse("2026-10-12T15:00:00Z")), track(503, Date.parse("2026-10-13T14:00:00Z"))];
    const trimmed = trimResearchTracks([older, finished, ...stillOpen], now, 3);
    expect(trimmed.map((row) => row.id).sort()).toEqual([finished, ...stillOpen].map((row) => row.id).sort());
    expect(trimmed.some((row) => row.id === older.id)).toBe(false);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/finished rows outside the 7-day window/);
    expect(String(info.mock.calls)).not.toMatch(/oldest rows/);
    const onlyActive = trimResearchTracks(stillOpen, now, 1);
    expect(onlyActive).toHaveLength(2);
  });
});
