import { EVENT_RULES } from "@/app/lib/alertConfig";
import {
  NO_EARNINGS_LISTED,
  UNKNOWN_EARNINGS,
  type EarningsFact,
  type EarningsTiming,
} from "@/app/lib/eventRisk";
import { isFlowTicker, newYorkDate } from "@/app/lib/flow";

/**
 * Next earnings date for one ticker.
 *
 * Schwab's market-data fundamental projection (ratios, dividends, margins)
 * does not include a next earnings date, so this does not call Schwab and
 * does not widen the market-data allowlist.
 *
 * The date comes from Yahoo's public quote summary (calendarEvents).
 * Before/after the open comes from Nasdaq's public earnings calendar when
 * that date is listed. Neither source uses an API key.
 * A failed read is "unknown" and is not cached as "no earnings".
 */

const UA = "Mozilla/5.0 (compatible; options-scan/1.0; +https://github.com/Jenak5/options_scan)";

interface CacheEntry {
  at: number;
  fact: EarningsFact;
}

interface Crumb {
  at: number;
  cookie: string;
  crumb: string;
}

type EarningsFetcher = (ticker: string, now: number) => Promise<EarningsFact>;

const cache = new Map<string, CacheEntry>();
const calendarCache = new Map<string, { at: number; body: unknown }>();
let crumbCache: Crumb | null = null;
let fetcher: EarningsFetcher | null = null;

export function clearEarningsCacheForTests(): void {
  cache.clear();
  calendarCache.clear();
  crumbCache = null;
}

export function setEarningsFetcherForTests(next: EarningsFetcher | null): void {
  fetcher = next;
  clearEarningsCacheForTests();
}

export async function earningsForTicker(ticker: string, now: number = Date.now()): Promise<EarningsFact> {
  const symbol = ticker.trim().toUpperCase();
  if (!isFlowTicker(symbol)) return UNKNOWN_EARNINGS;
  const hit = cache.get(symbol);
  if (hit && now >= hit.at && now - hit.at < cacheTtl(hit.fact)) return hit.fact;

  try {
    const fact = fetcher ? await fetcher(symbol, now) : await lookupEarnings(symbol, now);
    const stored = isEarningsFact(fact) ? fact : UNKNOWN_EARNINGS;
    cache.set(symbol, { at: now, fact: stored });
    return stored;
  } catch {
    cache.set(symbol, { at: now, fact: UNKNOWN_EARNINGS });
    return UNKNOWN_EARNINGS;
  }
}

function cacheTtl(fact: EarningsFact): number {
  if (fact.status === "unknown") return EVENT_RULES.unknownCacheMinutes * 60 * 1000;
  return EVENT_RULES.cacheHours * 60 * 60 * 1000;
}

async function lookupEarnings(symbol: string, now: number): Promise<EarningsFact> {
  const today = newYorkDate(new Date(now));
  const yahoo = await fetchYahooCalendar(symbol);
  const fact = parseYahooEarnings(yahoo, today);
  if (fact.status !== "known" || !fact.date) return fact;
  const timing = await nasdaqTiming(symbol, fact.date, now);
  if (!timing || timing === "unspecified") return fact;
  return { ...fact, timing };
}

export function parseYahooEarnings(body: unknown, today: string): EarningsFact {
  const summary = record(record(body)?.quoteSummary);
  const error = record(summary?.error);
  if (error) {
    const code = typeof error.code === "string" ? error.code : "";
    const description = typeof error.description === "string" ? error.description : "";
    if (code === "Not Found" || description.includes("No fundamentals")) return NO_EARNINGS_LISTED;
    return UNKNOWN_EARNINGS;
  }
  const result = summary?.result;
  if (!Array.isArray(result) || result.length === 0) return UNKNOWN_EARNINGS;
  const events = record(record(result[0])?.calendarEvents);
  const earnings = record(events?.earnings);
  if (!earnings) return NO_EARNINGS_LISTED;
  const dates = earningsDates(earnings.earningsDate).filter((date) => date >= today);
  dates.sort();
  if (dates.length === 0) {
    return earningsDates(earnings.earningsDate).length === 0 ? NO_EARNINGS_LISTED : UNKNOWN_EARNINGS;
  }
  return {
    status: "known",
    date: dates[0],
    timing: null,
    estimated: earnings.isEarningsDateEstimate === true,
  };
}

export function parseNasdaqTiming(body: unknown, symbol: string): EarningsTiming | null {
  const rows = record(record(body)?.data)?.rows;
  if (!Array.isArray(rows)) return null;
  const want = symbol.trim().toUpperCase();
  for (let i = 0; i < rows.length; i++) {
    const row = record(rows[i]);
    if (!row || String(row.symbol ?? "").toUpperCase() !== want) continue;
    return mapNasdaqTime(typeof row.time === "string" ? row.time : "");
  }
  return null;
}

function mapNasdaqTime(time: string): EarningsTiming {
  if (time === "time-pre-market" || time.includes("pre")) return "before-market";
  if (time === "time-after-hours" || time.includes("after")) return "after-market";
  return "unspecified";
}

function earningsDates(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  const dates: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = record(rows[i]);
    const fmt = typeof row?.fmt === "string" ? row.fmt : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(fmt)) dates.push(fmt);
  }
  return dates;
}

async function nasdaqTiming(symbol: string, date: string, now: number): Promise<EarningsTiming | null> {
  try {
    const body = await nasdaqCalendar(date, now);
    return parseNasdaqTiming(body, symbol);
  } catch {
    return null;
  }
}

async function nasdaqCalendar(date: string, now: number): Promise<unknown> {
  const hit = calendarCache.get(date);
  const ttl = EVENT_RULES.cacheHours * 60 * 60 * 1000;
  if (hit && now >= hit.at && now - hit.at < ttl) return hit.body;
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(EVENT_RULES.requestTimeoutMs),
  });
  if (!res.ok) throw new Error("earnings calendar unavailable");
  const body: unknown = await res.json();
  calendarCache.set(date, { at: now, body });
  return body;
}

async function fetchYahooCalendar(symbol: string): Promise<unknown> {
  const session = await yahooSession();
  const yahooSymbol = encodeURIComponent(symbol.replace(/\./g, "-"));
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yahooSymbol}?modules=calendarEvents&crumb=${encodeURIComponent(session.crumb)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: session.cookie,
    },
    signal: AbortSignal.timeout(EVENT_RULES.requestTimeoutMs),
  });
  if (!res.ok) throw new Error("earnings source unavailable");
  return res.json();
}

async function yahooSession(): Promise<Crumb> {
  const now = Date.now();
  const ttl = EVENT_RULES.crumbCacheMinutes * 60 * 1000;
  if (crumbCache && now >= crumbCache.at && now - crumbCache.at < ttl) return crumbCache;
  const fc = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(EVENT_RULES.requestTimeoutMs),
  });
  const cookie = cookieHeader(fc);
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie },
    signal: AbortSignal.timeout(EVENT_RULES.requestTimeoutMs),
  });
  if (!crumbRes.ok) throw new Error("earnings source unavailable");
  const crumb = (await crumbRes.text()).trim();
  if (!/^[A-Za-z0-9]+$/.test(crumb)) throw new Error("earnings source unavailable");
  crumbCache = { at: now, cookie, crumb };
  return crumbCache;
}

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (list.length === 0) {
    const single = response.headers.get("set-cookie");
    if (single) list.push(single);
  }
  const pairs: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const pair = list[i].split(";")[0]?.trim();
    if (pair) pairs.push(pair);
  }
  return pairs.join("; ");
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isEarningsFact(value: EarningsFact): boolean {
  return value.status === "known" || value.status === "unknown" || value.status === "none";
}
