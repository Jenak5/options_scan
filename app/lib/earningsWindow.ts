import { ALERT_RULES, EARNINGS_WINDOW } from "@/app/lib/alertConfig";
import { snapshotFromFlow } from "@/app/lib/alertFeatures";
import type { StoredAlert } from "@/app/lib/alertBook";
import { parseExpectedEarnings } from "@/app/lib/featureBackfill";
import { addCalendarDays, calendarDaysBetween, isFlowTicker, newYorkDate, type FlowRow } from "@/app/lib/flow";
import { chicagoDate } from "@/app/lib/marketHours";
import { RULES_VERSION } from "@/app/lib/rulesVersion";
import type { ShadowTrade } from "@/app/lib/shadow";
import { openCandleAccess, tastytradeGetJson } from "@/app/lib/tastytradeCandles";
import type { EarningsFact } from "@/app/lib/eventRisk";
import { gradeFlowRow } from "@/app/lib/verdict";

/**
 * Paper scorecard group. Nothing here sends a Telegram alert or places an order.
 * The grade, the earnings downgrade, and the alert rules stay where they are.
 * Tastytrade's expected report date is used first. Yahoo, already on the row, is the backup.
 * 43–60 and 1–13 stay their own cohorts.
 */

/** Same last-week check as LAST_WEEK_CALENDAR_DAYS on the scorecard. A test locks the two together. */
const HOLD_LAST_WEEK_DAYS = 7;

const ID_PATTERN = /^[A-Za-z0-9_.:|-]{8,180}$/;

export interface EarningsWindowPick {
  row: FlowRow;
  /** Letter the other rules would assign if earnings did not downgrade the grade. Not a grade. */
  probe: "A" | "B";
  earningsDate: string;
}

export const EARNINGS_SECTION_NOTE =
  `${EARNINGS_WINDOW.label}. A saved A or B whose earnings fall 1 to 14 calendar days ahead, and before the last-week exit, is tracked here and left out of the totals above. A contract the earnings downgrade kept out of A and B is tracked here on paper and is not sent. One contract at the ask. Exits match A and B: plus 40%, the current stop, flat after 3 trading days, and out before the last week. Weekends and full-day market holidays do not count as one of those 3 days. The date comes from Tastytrade first, then Yahoo. Grading, the earnings downgrade, and Telegram alerts are unchanged. ${EARNINGS_WINDOW.minTrust} resolved results are the minimum before describing this group. Estimates from quotes, not fills.`;

export function earningsWindowTrustNote(resolved: number): string {
  if (resolved < EARNINGS_WINDOW.minTrust) {
    return `${resolved} resolved in this group. Fewer than ${EARNINGS_WINDOW.minTrust} is too few to reconsider the earnings downgrade.`;
  }
  return `${resolved} resolved in this group. That is enough to describe. It is not a reason by itself to change the earnings downgrade.`;
}

/**
 * True when the earnings date is 1 to 14 calendar days after today
 * and still before the last-week exit.
 * The flat exit at trading day 3 can close a shadow sooner, and only when the quote is flat,
 * so it does not shorten this window. The last date still inside the hold is 8 calendar days
 * before expiration, because the shadow closes once 7 calendar days remain.
 */
export function earningsInsideHoldWindow(input: {
  today: string;
  earningsDate: string;
  expiration: string;
}): boolean {
  if (!isYmd(input.today) || !isYmd(input.earningsDate) || !isYmd(input.expiration)) return false;
  const days = calendarDaysBetween(input.today, input.earningsDate);
  if (days == null || days < EARNINGS_WINDOW.minCalendarDays || days > EARNINGS_WINDOW.maxCalendarDays) return false;
  const lastHeld = addCalendarDays(input.expiration, -(HOLD_LAST_WEEK_DAYS + 1));
  return input.earningsDate <= lastHeld;
}

/** A future YYYY-MM-DD, or null. Today counts as known so the 1-day floor can reject it later. */
export function chooseEarningsDate(
  tastytrade: string | null | undefined,
  yahoo: EarningsFact | null | undefined,
  today: string,
): string | null {
  const primary = futureDate(tastytrade, today);
  if (primary) return primary;
  if (yahoo && yahoo.status === "known") return futureDate(yahoo.date, today);
  return null;
}

/**
 * One date per ticker. Tastytrade is a read-only market-metrics GET.
 * A missing credential, a failed read, or a symbol with no date falls back to Yahoo on the row.
 * This map does not replace the earnings fact used to grade.
 */
export async function earningsDateMapForRows(
  rows: readonly { ticker: string; earnings?: EarningsFact | null }[],
  now: Date,
  deps?: {
    loadTastytrade?: (tickers: readonly string[]) => Promise<ReadonlyMap<string, string | null> | null>;
  },
): Promise<Map<string, string | null>> {
  const today = newYorkDate(now);
  const yahoo = new Map<string, EarningsFact | null>();
  const tickers: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const ticker = rows[i].ticker.trim().toUpperCase();
    if (!isFlowTicker(ticker) || yahoo.has(ticker)) continue;
    yahoo.set(ticker, rows[i].earnings ?? null);
    tickers.push(ticker);
  }
  const tastytrade = await readTastytradeDates(tickers, deps?.loadTastytrade);
  const out = new Map<string, string | null>();
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const fromTasty = tastytrade ? tastytrade.get(ticker) : null;
    out.set(ticker, chooseEarningsDate(fromTasty, yahoo.get(ticker), today));
  }
  return out;
}

/** Date to store on a saved alert, or null when this contract is outside the group. */
export function windowEarningsDateForContract(input: {
  ticker: string;
  expiration: string;
  now: Date;
  dates: ReadonlyMap<string, string | null>;
}): string | null {
  const date = input.dates.get(input.ticker.trim().toUpperCase()) ?? null;
  if (!date) return null;
  const today = newYorkDate(input.now);
  if (!earningsInsideHoldWindow({ today, earningsDate: date, expiration: input.expiration })) return null;
  return date;
}

/** True when a saved alert belongs in this scorecard group. Older alerts have no date and stay in A/B. */
export function alertInEarningsWindow(alert: Pick<StoredAlert, "windowEarningsDate" | "sentAt" | "expiration">): boolean {
  const date = alert.windowEarningsDate;
  if (!date) return false;
  return earningsInsideHoldWindow({
    today: newYorkDate(new Date(alert.sentAt)),
    earningsDate: date,
    expiration: alert.expiration,
  });
}

/**
 * Paper rows only. A contract that still grades A or B is saved as an alert and is not opened again here.
 * The probe moves a known earnings date to the day after expiration so the downgrade does not apply.
 * An unknown date is left unknown, so this does not lift that cap.
 */
export function chooseEarningsWindow(input: {
  rows: readonly FlowRow[];
  consecutiveLosses: number | null;
  now: Date;
  existing: readonly Pick<ShadowTrade, "ticker" | "expiration" | "strike" | "putCall" | "cohort" | "grade" | "openedAt">[];
  dates: ReadonlyMap<string, string | null>;
  limit?: number;
}): EarningsWindowPick[] {
  const today = newYorkDate(input.now);
  const day = chicagoDate(input.now);
  const keys = new Set<string>();
  let openedToday = 0;
  for (let i = 0; i < input.existing.length; i++) {
    const row = input.existing[i];
    keys.add(contractKey(row));
    if (row.cohort !== "experiment-earnings" || row.grade !== "test") continue;
    if (chicagoDate(new Date(row.openedAt)) !== day) continue;
    openedToday += 1;
  }
  const room = Math.max(0, EARNINGS_WINDOW.opensPerDay - openedToday);
  const cap = Math.min(input.limit ?? EARNINGS_WINDOW.opensPerRun, room);
  if (cap <= 0) return [];

  const ranked: EarningsWindowPick[] = [];
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    if (keys.has(contractKey(row))) continue;
    const earningsDate = input.dates.get(row.ticker.trim().toUpperCase()) ?? null;
    if (!earningsDate) continue;
    if (!earningsInsideHoldWindow({ today, earningsDate, expiration: row.expiration })) continue;
    const probe = earningsWindowProbe(row, input.consecutiveLosses, input.now);
    if (!probe) continue;
    ranked.push({ row, probe, earningsDate });
  }
  ranked.sort((a, b) => b.row.score - a.row.score || a.row.id.localeCompare(b.row.id));

  const picked: EarningsWindowPick[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ranked.length && picked.length < cap; i++) {
    const key = contractKey(ranked[i].row);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(ranked[i]);
  }
  return picked;
}

export function earningsWindowProbe(row: FlowRow, consecutiveLosses: number | null, now: Date): "A" | "B" | null {
  if (row.dte == null || row.dte < ALERT_RULES.alertDteMin || row.dte > ALERT_RULES.alertDteMax) return null;
  if (!row.liquidityPasses || row.delayed) return null;
  if (!(row.ask > 0) || !Number.isFinite(row.ask)) return null;
  const real = gradeFlowRow(row, consecutiveLosses, now);
  if (real.grade === "A" || real.grade === "B") return null;
  if (real.verdict === "SKIP") return null;
  const probed = gradeFlowRow(withoutEarningsDowngrade(row), consecutiveLosses, now);
  if (probed.verdict !== "TAKE") return null;
  if (probed.grade !== "A" && probed.grade !== "B") return null;
  return probed.grade;
}

export function earningsWindowShadow(row: FlowRow, probe: "A" | "B", now: Date): ShadowTrade | null {
  if (!(row.ask > 0) || !Number.isFinite(row.ask)) return null;
  const id = earningsWindowShadowId(row, now);
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    alertId: id,
    openedAt: now.getTime(),
    ticker: row.ticker,
    putCall: row.putCall,
    strike: row.strike,
    expiration: row.expiration,
    grade: "test",
    cohort: "experiment-earnings",
    experimentLabel: EARNINGS_WINDOW.label,
    probeGrade: probe,
    contracts: 1,
    entryPrice: row.ask,
    entryPriceSource: "ask",
    status: "open",
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    exitQuote: null,
    exitStale: false,
    pnlDollars: null,
    pnlFraction: null,
    tradingDaysHeld: null,
    lastMark: null,
    lastMarkSource: null,
    lastMarkedAt: null,
    features: snapshotFromFlow(row, now),
    rulesVersion: RULES_VERSION,
    marks: [],
    maxFavorablePrice: null,
    maxAdversePrice: null,
    marksSeen: 0,
  };
}

export function earningsWindowShadowId(row: Pick<FlowRow, "id">, now: Date): string {
  const day = chicagoDate(now).replace(/-/g, "");
  return `ewin${day}-${row.id}`.slice(0, 180);
}

async function readTastytradeDates(
  tickers: readonly string[],
  loadTastytrade: ((tickers: readonly string[]) => Promise<ReadonlyMap<string, string | null> | null>) | undefined,
): Promise<ReadonlyMap<string, string | null> | null> {
  if (tickers.length === 0) return new Map();
  try {
    if (loadTastytrade) return await loadTastytrade(tickers);
    return await tastytradeExpectedDates(tickers);
  } catch {
    return null;
  }
}

/** Read-only. No orders, positions, or account writes. Null when the read does not return dates. */
async function tastytradeExpectedDates(tickers: readonly string[]): Promise<Map<string, string | null> | null> {
  const opened = await openCandleAccess();
  if (!opened.access) return null;
  const payload = await tastytradeGetJson(
    opened.access,
    `/market-metrics?symbols=${encodeURIComponent(tickers.join(","))}`,
  );
  if (!payload) return null;
  const parsed = parseExpectedEarnings(payload);
  const out = new Map<string, string | null>();
  parsed.forEach((date, symbol) => {
    out.set(symbol.trim().toUpperCase(), date);
  });
  return out;
}

function withoutEarningsDowngrade(row: FlowRow): FlowRow {
  const fact = row.earnings;
  if (!fact || fact.status !== "known" || !fact.date) return row;
  return {
    ...row,
    earnings: {
      status: "known",
      date: addCalendarDays(row.expiration, 1),
      timing: fact.timing,
      estimated: fact.estimated,
    },
  };
}

function futureDate(value: string | null | undefined, today: string): string | null {
  if (!value || !isYmd(value) || !isYmd(today) || value < today) return null;
  return value;
}

function isYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function contractKey(row: { ticker: string; expiration: string; strike: number; putCall: string }): string {
  return `${row.ticker}|${row.expiration}|${row.strike}|${row.putCall}`;
}
