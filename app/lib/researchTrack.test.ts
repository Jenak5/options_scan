import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStoredAlert, type StoredAlert } from "@/app/lib/alertBook";
import type { AlertVerdict } from "@/app/lib/verdict";
import { EMPTY_PRINTS } from "@/app/lib/prints";
import { SPY_TREND_NOTE } from "@/app/lib/marketContext";
import {
  RESEARCH_MARK_CAP,
  RESEARCH_QUOTES_PER_RUN,
  addResearchTracks,
  researchFromRow,
  researchSessionOpen,
  selectResearchMarks,
  type ResearchTrack,
} from "@/app/lib/researchTrack";
import { SHADOW_MARK_CAP, parseShadowBook, shadowFromAlert, summarizeShadows } from "@/app/lib/shadow";
import { loadShadowPage, runShadowPass } from "@/app/lib/shadowStore";
import { parseLearnGrades } from "@/app/lib/learnStore";
import { clearMemoryStoreForTests, readShadowBookText, readTokens, updateShadowBook } from "@/app/lib/schwabStore";
import * as schwab from "@/app/lib/schwab";
import * as tradeQuotes from "@/app/lib/tradeQuotes";
import type { FlowRow } from "@/app/lib/flow";
import { RESEARCH_QUOTE_CHUNK } from "@/app/lib/flow";

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
    eventLine: null,
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
  it("records a new C with the entry split and leaves an older alert alone", () => {
    expect(SPY_TREND_NOTE).toMatch(/session VWAP/);
    expect(SPY_TREND_NOTE).toMatch(/not a 20-day or 50-day/);
    expect(RESEARCH_MARK_CAP).toBe(SHADOW_MARK_CAP);
    const opened = addResearchTracks([], [{ row: row(), grade: "C" }, { row: row({ id: "SPY|2026-12-18|670|call", ticker: "SPY", putCall: "call", strike: 670 }), grade: "A" }], [], OPEN);
    expect(opened.opened).toBe(1);
    expect(opened.tracks[0]).toMatchObject({
      putCall: "put",
      grade: "C",
      entryPrice: 1.2,
      entryUnderlying: 238,
      spyTrend: "down",
      marks: [],
    });
    const again = addResearchTracks(opened.tracks, [{ row: row(), grade: "C" }], [], OPEN);
    expect(again.opened).toBe(0);
    const saved = buildStoredAlert(row(), verdict("C"), OPEN);
    expect(saved.trackQuotes).toBe(true);
    const fromAlert = addResearchTracks([], [], [saved], OPEN);
    expect(fromAlert.opened).toBe(1);
    expect(fromAlert.tracks[0].alertId).toBe(saved.id);
    const old: StoredAlert = { ...saved, id: "olderalert00000001", trackQuotes: undefined };
    expect(addResearchTracks([], [], [old], OPEN).opened).toBe(0);
    const scorecard = shadowFromAlert(buildStoredAlert(row({ id: "SPY|2026-12-18|670|call", ticker: "SPY", putCall: "call", strike: 670, ask: 2 }), verdict("A"), OPEN));
    expect(scorecard?.quoteTrack).toBe(true);
    expect(scorecard?.entryUnderlying).toBe(238);
    expect(scorecard?.spyTrend).toBe("down");
    expect(shadowFromAlert({ ...saved, grade: "A", trackQuotes: undefined })?.quoteTrack).toBeUndefined();
  });

  it("keeps C and D off the scorecard and out of the default what-if", async () => {
    const added = addResearchTracks([], [{ row: row(), grade: "D" }], [], OPEN);
    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: [], research: added.tracks }))).toBe(true);
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

  it("quotes the oldest research tracks in chunks and skips the rest without a token read", async () => {
    process.env.SCHWAB_CLIENT_ID = "id";
    process.env.SCHWAB_CLIENT_SECRET = "secret";
    process.env.SCHWAB_REDIRECT_URI = "https://example.com/callback";
    const tracks: ResearchTrack[] = [];
    for (let i = 0; i < RESEARCH_QUOTES_PER_RUN + 1; i++) {
      const rowTrack = track(i, OPEN.getTime() + i * 1000);
      rowTrack.ticker = "SPY";
      tracks.push(rowTrack);
    }
    expect(await updateShadowBook(() => JSON.stringify({ version: 1, records: [], research: tracks }))).toBe(true);
    const quoted = vi.spyOn(schwab, "getQuoteEntries").mockImplementation(async (symbols) => ({
      entries: symbols.map((symbol) => ({
        symbol,
        contract: {
          bid: 1.2,
          ask: 1.4,
          last: 1.3,
          volume: 10,
          openInterest: 10,
          delta: null,
          iv: null,
          strike: 100,
          expiration: "2026-12-18",
          putCall: "call" as const,
        },
      })),
      problem: null,
    }));
    vi.spyOn(tradeQuotes, "quoteContractMarks").mockResolvedValue({});
    const tokens = vi.spyOn(await import("@/app/lib/schwabStore"), "readTokens");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const writes = vi.spyOn(await import("@/app/lib/schwabStore"), "updateShadowBook");
    const first = await runShadowPass(OPEN, []);
    expect(first.researchSkipped).toBe(1);
    expect(first.researchQuoted).toBe(RESEARCH_QUOTES_PER_RUN);
    expect(quoted).toHaveBeenCalledTimes(RESEARCH_QUOTES_PER_RUN / RESEARCH_QUOTE_CHUNK);
    for (let i = 0; i < quoted.mock.calls.length; i++) {
      expect(quoted.mock.calls[i][0].length).toBeLessThanOrEqual(RESEARCH_QUOTE_CHUNK);
    }
    expect(tokens).not.toHaveBeenCalled();
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/skipped 1/);
    expect(writes).toHaveBeenCalledTimes(1);
    const saved = parseShadowBook(await readShadowBookText());
    const marked = (saved.research ?? []).filter((item) => item.marks.length > 0);
    expect(marked).toHaveLength(RESEARCH_QUOTES_PER_RUN);
    expect(marked[0].marks[0].price).toBeCloseTo(1.3, 6);
    const newest = (saved.research ?? []).find((item) => item.contractKey.endsWith(`|${100 + RESEARCH_QUOTES_PER_RUN}|call`));
    expect(newest?.marks).toEqual([]);
    const page = await loadShadowPage(OPEN);
    expect(page.open).toBe(0);
    expect(page.resolved).toBe(0);

    writes.mockClear();
    const soon = await runShadowPass(new Date(OPEN.getTime() + 5 * 60_000), []);
    expect(soon.researchQuoted).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(researchSessionOpen(EVENING)).toBe(false);
    expect(researchSessionOpen(new Date("2026-11-26T15:00:00Z"))).toBe(false);
    const evening = await runShadowPass(EVENING, [{ row: row(), grade: "C" }]);
    expect(evening.researchOpened).toBe(0);
    expect(selectResearchMarks(tracks, OPEN).due).toHaveLength(RESEARCH_QUOTES_PER_RUN);
    expect(selectResearchMarks(tracks, OPEN).skipped).toBe(1);
  });
});
