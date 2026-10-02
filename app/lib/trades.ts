import { formatContractCost, longContractCost, TRADE_RULES, type LetterGrade } from "@/app/lib/alertConfig";
import { chicagoClock, chicagoDate, chicagoTradingDaysElapsed } from "@/app/lib/marketHours";
import { ACCOUNT_SIZE_DOLLARS, DAILY_STOP_CONSECUTIVE_LOSSES, MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import type { VerdictName } from "@/app/lib/verdict";

/**
 * Paper trade log. A paper entry copies an A or B alert and prices the
 * contract at the ask. A hand-typed row is still allowed. There is no broker fill.
 * A loss streak is counted from closes on the Chicago trading day.
 * Once two losses land in a row, the daily stop stays on until the next
 * Chicago day. A later win does not clear it. A flat close breaks the streak
 * before the stop latches. There is no weekly loss limit.
 */

/** Shown next to a paper entry so the fill price is not confused with the midpoint. */
export const PAPER_ENTRY_NOTE = "Entry price is the ask. One contract costs ask × 100. Flow premium is volume × mid × 100 and is not the fill.";

export const DAILY_STOP_PAPER_MESSAGE = "Stop for the day. Two losing closes in a row. A new paper trade waits until the next Chicago day.";

export type TradeStructure = "single" | "debit-spread";
export type TradeResult = "win" | "loss" | "flat";
/** Ask is the scanner's contract price. Typed is a price entered by hand. */
export type EntryPriceSource = "ask" | "typed";

const VERDICTS: VerdictName[] = ["TAKE", "WATCH", "SKIP", "STOP"];
const GRADES: LetterGrade[] = ["A", "B", "C", "D"];
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface StoredTrade {
  id: string;
  openedAt: number;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  contracts: number;
  entryPrice: number;
  /** Ask when the paper trade copied an alert. Typed when the price was entered by hand. */
  entryPriceSource: EntryPriceSource | null;
  /** Estimated flow premium at the alert: volume × mid × 100. Not the fill. */
  flowPremium: number | null;
  structure: TradeStructure;
  alertId: string | null;
  alertVerdict: VerdictName | null;
  alertGrade: LetterGrade | null;
  closedAt: number | null;
  exitPrice: number | null;
  exitNote: string | null;
}

export interface TradeLog {
  version: 1;
  trades: StoredTrade[];
}

export interface TradeMetrics {
  pnlDollars: number | null;
  pnlFraction: number | null;
  riskDollars: number;
  riskBreachesCap: boolean;
  result: TradeResult | null;
  holdMinutes: number | null;
  matchedAlert: boolean;
}

export interface DailyStopState {
  tradingDay: string;
  consecutiveLosses: number;
  dailyStop: boolean;
}

export interface WeeklySummary {
  weekStart: string;
  weekEnd: string;
  pnlDollars: number;
  closed: number;
  threshold: number;
  flagged: boolean;
}

export interface BucketPnl {
  key: string;
  closed: number;
  wins: number;
  losses: number;
  flats: number;
  /** Wins divided by wins plus losses. Flats are left out. Null when none decided. */
  winRate: number | null;
  averageWin: number | null;
  /** Mean dollar loss, as a positive number. */
  averageLoss: number | null;
  pnlDollars: number;
}

export interface TradeStats {
  closed: number;
  open: number;
  wins: number;
  losses: number;
  flats: number;
  /** Wins divided by wins plus losses. Flats are left out. Null when none decided. */
  winRate: number | null;
  /** Mean dollar P&L of winning closes. */
  averageWin: number | null;
  /** Mean dollar loss of losing closes, as a positive number. */
  averageLoss: number | null;
  /** winRate × average win − loss rate × average loss. Null when nothing decided. */
  expectancy: number | null;
  totalPnl: number;
  byGrade: BucketPnl[];
  byVerdict: BucketPnl[];
  week: WeeklySummary;
  sampleNote: string;
}

export interface OpenTradeInput {
  ticker: string;
  putCall: string;
  strike: number;
  expiration: string;
  contracts: number;
  entryPrice: number;
  structure?: string;
  openedAt?: number;
  alertId?: string | null;
  alertVerdict?: string | null;
  alertGrade?: string | null;
  entryPriceSource?: EntryPriceSource | null;
  flowPremium?: number | null;
}

export function emptyTradeLog(): TradeLog {
  return { version: 1, trades: [] };
}

export function riskDollars(entryPrice: number, contracts: number): number {
  return entryPrice * contracts * 100;
}

export function tradeMetrics(trade: StoredTrade): TradeMetrics {
  const risk = riskDollars(trade.entryPrice, trade.contracts);
  const closed = trade.closedAt != null && trade.exitPrice != null && trade.exitPrice > 0;
  const pnlDollars = closed ? (trade.exitPrice as number - trade.entryPrice) * trade.contracts * 100 : null;
  const pnlFraction = closed && trade.entryPrice > 0
    ? ((trade.exitPrice as number) - trade.entryPrice) / trade.entryPrice
    : null;
  return {
    pnlDollars,
    pnlFraction,
    riskDollars: risk,
    riskBreachesCap: risk > MAX_LOSS_DOLLARS + 1e-6,
    result: pnlDollars == null ? null : resultOf(pnlDollars),
    holdMinutes: closed ? Math.max(0, Math.round(((trade.closedAt as number) - trade.openedAt) / 60_000)) : null,
    matchedAlert: trade.alertVerdict != null,
  };
}

export function dailyStopState(trades: readonly StoredTrade[], now: Date): DailyStopState {
  const tradingDay = chicagoDate(now);
  const closed = trades.filter((trade) => {
    if (trade.closedAt == null) return false;
    return chicagoDate(new Date(trade.closedAt)) === tradingDay;
  });
  closed.sort(byClose);
  let streak = 0;
  let maxStreak = 0;
  for (let i = 0; i < closed.length; i++) {
    const result = tradeMetrics(closed[i]).result;
    if (result === "loss") {
      streak += 1;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      streak = 0;
    }
  }
  const dailyStop = maxStreak >= DAILY_STOP_CONSECUTIVE_LOSSES;
  return {
    tradingDay,
    consecutiveLosses: dailyStop ? Math.max(maxStreak, DAILY_STOP_CONSECUTIVE_LOSSES) : streak,
    dailyStop,
  };
}

export function weeklyDrawdownThreshold(): number {
  return ACCOUNT_SIZE_DOLLARS * TRADE_RULES.weeklyDrawdownFraction;
}

export function weeklySummary(trades: readonly StoredTrade[], now: Date): WeeklySummary {
  const threshold = weeklyDrawdownThreshold();
  const clock = chicagoClock(now);
  if (!clock) {
    return { weekStart: "", weekEnd: "", pnlDollars: 0, closed: 0, threshold, flagged: false };
  }
  const weekStart = shiftYmd(clock.date, -daysSinceMonday(clock.weekday));
  const weekEnd = shiftYmd(weekStart, 6);
  let pnlDollars = 0;
  let closed = 0;
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.closedAt == null) continue;
    const day = chicagoDate(new Date(trade.closedAt));
    if (day < weekStart || day > weekEnd) continue;
    const pnl = tradeMetrics(trade).pnlDollars;
    if (pnl == null) continue;
    pnlDollars += pnl;
    closed += 1;
  }
  return {
    weekStart,
    weekEnd,
    pnlDollars,
    closed,
    threshold,
    flagged: pnlDollars <= -threshold + 1e-6,
  };
}

export function weeklyFlagSentence(week: WeeklySummary): string | null {
  if (!week.flagged) return null;
  const pct = Math.round(TRADE_RULES.weeklyDrawdownFraction * 100);
  return `This week is down $${Math.abs(week.pnlDollars).toFixed(2)} (about ${pct}% of the account, $${week.threshold.toFixed(0)}). Information only. It does not change the checklist and it is not a weekly stop.`;
}

export function summarizeTrades(trades: readonly StoredTrade[], now: Date): TradeStats {
  const grades = ["A", "B", "C", "D", "unmatched"];
  const verdicts = ["TAKE", "WATCH", "SKIP", "STOP", "unmatched"];
  const byGrade = grades.map(emptyBucket);
  const byVerdict = verdicts.map(emptyBucket);
  let open = 0;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let winDollars = 0;
  let lossDollars = 0;
  let totalPnl = 0;

  for (let i = 0; i < trades.length; i++) {
    const metrics = tradeMetrics(trades[i]);
    if (metrics.pnlDollars == null || metrics.result == null) {
      open += 1;
      continue;
    }
    totalPnl += metrics.pnlDollars;
    if (metrics.result === "win") {
      wins += 1;
      winDollars += metrics.pnlDollars;
    } else if (metrics.result === "loss") {
      losses += 1;
      lossDollars += Math.abs(metrics.pnlDollars);
    } else {
      flats += 1;
    }
    const gradeKey = trades[i].alertGrade ?? "unmatched";
    const verdictKey = trades[i].alertVerdict ?? "unmatched";
    addBucket(byGrade, gradeKey, metrics.pnlDollars, metrics.result);
    addBucket(byVerdict, verdictKey, metrics.pnlDollars, metrics.result);
  }

  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : null;
  const averageWin = wins > 0 ? winDollars / wins : null;
  const averageLoss = losses > 0 ? lossDollars / losses : null;
  const expectancy = winRate != null && averageWin != null && averageLoss != null
    ? winRate * averageWin - (1 - winRate) * averageLoss
    : winRate != null && averageWin != null && losses === 0
      ? averageWin
      : winRate != null && averageLoss != null && wins === 0
        ? -averageLoss
        : null;

  return {
    closed: wins + losses + flats,
    open,
    wins,
    losses,
    flats,
    winRate,
    averageWin,
    averageLoss,
    expectancy,
    totalPnl,
    byGrade: byGrade.map(publishBucket),
    byVerdict: byVerdict.map(publishBucket),
    week: weeklySummary(trades, now),
    sampleNote: TRADE_RULES.sampleNote,
  };
}

export function buildTrade(input: OpenTradeInput, id: string, now: Date): { ok: true; trade: StoredTrade } | { ok: false; error: string } {
  const ticker = input.ticker.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) return { ok: false, error: "Enter a ticker" };
  const putCall = input.putCall.trim().toLowerCase();
  if (putCall !== "call" && putCall !== "put") return { ok: false, error: "Choose call or put" };
  if (!Number.isFinite(input.strike) || input.strike <= 0 || input.strike > 1_000_000) {
    return { ok: false, error: "Enter a strike" };
  }
  const expiration = /^(\d{4}-\d{2}-\d{2})/.exec(input.expiration.trim())?.[1] ?? "";
  if (!DATE_PATTERN.test(expiration)) return { ok: false, error: "Enter an expiration as YYYY-MM-DD" };
  if (!Number.isInteger(input.contracts) || input.contracts < 1 || input.contracts > TRADE_RULES.maxContracts) {
    return { ok: false, error: `Enter a whole number of contracts from 1 to ${TRADE_RULES.maxContracts}` };
  }
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0 || input.entryPrice > 100_000) {
    return { ok: false, error: "Enter an entry price" };
  }
  const structure: TradeStructure = input.structure === "debit-spread" ? "debit-spread" : "single";
  const openedAt = input.openedAt == null ? now.getTime() : input.openedAt;
  if (!Number.isFinite(openedAt) || openedAt < 1_500_000_000_000 || openedAt > now.getTime() + 86_400_000) {
    return { ok: false, error: "Enter an entry time" };
  }
  const alertId = cleanId(input.alertId);
  const alertVerdict = parseVerdict(input.alertVerdict);
  const alertGrade = parseGrade(input.alertGrade);
  return {
    ok: true,
    trade: {
      id,
      openedAt,
      ticker,
      putCall,
      strike: input.strike,
      expiration,
      contracts: input.contracts,
      entryPrice: input.entryPrice,
      entryPriceSource: input.entryPriceSource === "ask" ? "ask" : "typed",
      flowPremium: cleanPremium(input.flowPremium),
      structure,
      alertId,
      alertVerdict,
      alertGrade,
      closedAt: null,
      exitPrice: null,
      exitNote: null,
    },
  };
}

/**
 * Refuse a paper entry that breaks the ceiling.
 * One contract is ask × 100, and that has to be at or under $875.
 * contracts × ask × 100 has to be at or under the same $875 loss cap.
 * A contract between the old $450 figure and $875 is allowed.
 */
export function paperCostError(entryPrice: number, contracts: number): string | null {
  if (!Number.isInteger(contracts) || contracts < 1) {
    return "Enter a whole number of contracts, starting at 1.";
  }
  const one = longContractCost(entryPrice);
  if (one == null) return "The ask is not priced, so this paper trade was not saved.";
  if (one > MAX_LOSS_DOLLARS + 1e-6) {
    return `One contract at the ask costs ${formatContractCost(entryPrice)}, which is over the $${MAX_LOSS_DOLLARS} ceiling. This paper trade was not saved.`;
  }
  const risk = riskDollars(entryPrice, contracts);
  if (risk > MAX_LOSS_DOLLARS + 1e-6) {
    return `${contracts} contracts at the ask cost ${dollars(risk)}, which is over the $${MAX_LOSS_DOLLARS} loss cap. This paper trade was not saved.`;
  }
  return null;
}

/** Open paper trade already stored for this alert, if one is still open. */
export function findOpenTradeForAlert(trades: readonly StoredTrade[], alertId: string): StoredTrade | null {
  const id = cleanId(alertId);
  if (!id) return null;
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.closedAt == null && trade.alertId === id) return trade;
  }
  return null;
}

/**
 * Mark-to-market for an open trade. The mark is the option midpoint.
 * Closed trades keep their exit P/L and do not use the mark.
 */
/**
 * Open paper trade that is still inside the flat dollar band after the
 * multi-day time stop. A missing mark is not called flat. A closed trade is not flagged.
 */
export function flatTimeStopDue(
  trade: Pick<StoredTrade, "openedAt" | "closedAt">,
  unrealizedPnl: number | null,
  now: Date,
): boolean {
  if (trade.closedAt != null) return false;
  if (unrealizedPnl == null || !Number.isFinite(unrealizedPnl)) return false;
  if (Math.abs(unrealizedPnl) >= TRADE_RULES.flatAbsDollars) return false;
  return chicagoTradingDaysElapsed(new Date(trade.openedAt), now) >= TRADE_RULES.flatAfterTradingDays;
}

export function withQuoteMark<T extends StoredTrade>(trade: T, mark: number | null): T & {
  mark: number | null;
  markSource: "mid" | null;
  unrealizedPnl: number | null;
} {
  const usable = trade.closedAt == null && mark != null && Number.isFinite(mark) && mark > 0;
  return {
    ...trade,
    mark: usable ? mark : null,
    markSource: usable ? "mid" : null,
    unrealizedPnl: usable ? (mark as number - trade.entryPrice) * trade.contracts * 100 : null,
  };
}

export function addTrade(log: TradeLog, trade: StoredTrade): TradeLog {
  return { version: 1, trades: trimTrades(log.trades.concat(trade)) };
}

export function closeTrade(
  log: TradeLog,
  id: string,
  input: { exitPrice: number; closedAt?: number; exitNote?: string | null },
  now: Date,
): { ok: true; log: TradeLog } | { ok: false; error: string } {
  const index = findIndex(log.trades, id);
  if (index < 0) return { ok: false, error: "That trade is not in the log" };
  const trade = log.trades[index];
  if (trade.closedAt != null) return { ok: false, error: "That trade is already closed" };
  if (!Number.isFinite(input.exitPrice) || input.exitPrice <= 0 || input.exitPrice > 100_000) {
    return { ok: false, error: "Enter an exit price" };
  }
  const closedAt = input.closedAt == null ? now.getTime() : input.closedAt;
  if (!Number.isFinite(closedAt) || closedAt < trade.openedAt || closedAt > now.getTime() + 86_400_000) {
    return { ok: false, error: "Enter an exit time at or after the entry" };
  }
  const next = log.trades.slice();
  next[index] = {
    ...trade,
    closedAt,
    exitPrice: input.exitPrice,
    exitNote: cleanNote(input.exitNote),
  };
  return { ok: true, log: { version: 1, trades: next } };
}

export function removeTrade(log: TradeLog, id: string): { ok: true; log: TradeLog } | { ok: false; error: string } {
  const index = findIndex(log.trades, id);
  if (index < 0) return { ok: false, error: "That trade is not in the log" };
  const next = log.trades.slice();
  next.splice(index, 1);
  return { ok: true, log: { version: 1, trades: next } };
}

export function parseTradeLog(text: string | null | undefined): TradeLog {
  if (!text) return emptyTradeLog();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyTradeLog();
  }
  const row = parsed && typeof parsed === "object" ? parsed as { trades?: unknown } : null;
  if (!row || !Array.isArray(row.trades)) return emptyTradeLog();
  const trades: StoredTrade[] = [];
  for (let i = 0; i < row.trades.length; i++) {
    const trade = parseTrade(row.trades[i]);
    if (trade) trades.push(trade);
  }
  return { version: 1, trades: trimTrades(trades) };
}

export function tradesToCsv(trades: readonly StoredTrade[]): string {
  const header = [
    "id", "openedAt", "ticker", "putCall", "strike", "expiration", "contracts",
    "entryPrice", "entryPriceSource", "flowPremium", "structure", "alertId", "alertVerdict", "alertGrade",
    "closedAt", "exitPrice", "exitNote", "pnlDollars", "pnlPercent",
    "riskDollars", "riskBreach", "result", "holdMinutes",
  ];
  const lines = [header.join(",")];
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const metrics = tradeMetrics(trade);
    lines.push([
      trade.id,
      new Date(trade.openedAt).toISOString(),
      trade.ticker,
      trade.putCall,
      String(trade.strike),
      trade.expiration,
      String(trade.contracts),
      String(trade.entryPrice),
      trade.entryPriceSource ?? "",
      trade.flowPremium == null ? "" : String(trade.flowPremium),
      trade.structure,
      trade.alertId ?? "",
      trade.alertVerdict ?? "",
      trade.alertGrade ?? "",
      trade.closedAt == null ? "" : new Date(trade.closedAt).toISOString(),
      trade.exitPrice == null ? "" : String(trade.exitPrice),
      trade.exitNote ?? "",
      metrics.pnlDollars == null ? "" : metrics.pnlDollars.toFixed(2),
      metrics.pnlFraction == null ? "" : (metrics.pnlFraction * 100).toFixed(2),
      metrics.riskDollars.toFixed(2),
      metrics.riskBreachesCap ? "yes" : "no",
      metrics.result ?? "",
      metrics.holdMinutes == null ? "" : String(metrics.holdMinutes),
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

function resultOf(pnlDollars: number): TradeResult {
  if (Math.abs(pnlDollars) < TRADE_RULES.flatAbsDollars) return "flat";
  return pnlDollars > 0 ? "win" : "loss";
}

function byClose(a: StoredTrade, b: StoredTrade): number {
  const at = (a.closedAt ?? 0) - (b.closedAt ?? 0);
  if (at !== 0) return at;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function publishBucket(bucket: BucketPnl & { winDollars: number; lossDollars: number }): BucketPnl {
  return {
    key: bucket.key,
    closed: bucket.closed,
    wins: bucket.wins,
    losses: bucket.losses,
    flats: bucket.flats,
    winRate: bucket.winRate,
    averageWin: bucket.averageWin,
    averageLoss: bucket.averageLoss,
    pnlDollars: bucket.pnlDollars,
  };
}

function emptyBucket(key: string): BucketPnl & { winDollars: number; lossDollars: number } {
  return {
    key,
    closed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    winRate: null,
    averageWin: null,
    averageLoss: null,
    pnlDollars: 0,
    winDollars: 0,
    lossDollars: 0,
  };
}

function addBucket(
  buckets: Array<BucketPnl & { winDollars: number; lossDollars: number }>,
  key: string,
  pnl: number,
  result: TradeResult,
): void {
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].key !== key) continue;
    const bucket = buckets[i];
    bucket.closed += 1;
    bucket.pnlDollars += pnl;
    if (result === "win") {
      bucket.wins += 1;
      bucket.winDollars += pnl;
    } else if (result === "loss") {
      bucket.losses += 1;
      bucket.lossDollars += Math.abs(pnl);
    } else {
      bucket.flats += 1;
    }
    const decided = bucket.wins + bucket.losses;
    bucket.winRate = decided > 0 ? bucket.wins / decided : null;
    bucket.averageWin = bucket.wins > 0 ? bucket.winDollars / bucket.wins : null;
    bucket.averageLoss = bucket.losses > 0 ? bucket.lossDollars / bucket.losses : null;
    return;
  }
}

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function cleanPremium(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 1e12) return null;
  return value;
}

function findIndex(trades: readonly StoredTrade[], id: string): number {
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].id === id) return i;
  }
  return -1;
}

function trimTrades(trades: StoredTrade[]): StoredTrade[] {
  const max = TRADE_RULES.maxStoredTrades;
  if (trades.length <= max) return trades;
  const closed = trades.filter((trade) => trade.closedAt != null).slice().sort((a, b) => a.openedAt - b.openedAt);
  const drop = new Set<string>();
  let extra = trades.length - max;
  for (let i = 0; i < closed.length && extra > 0; i++) {
    drop.add(closed[i].id);
    extra -= 1;
  }
  if (extra > 0) {
    const open = trades.filter((trade) => trade.closedAt == null).slice().sort((a, b) => a.openedAt - b.openedAt);
    for (let i = 0; i < open.length && extra > 0; i++) {
      drop.add(open[i].id);
      extra -= 1;
    }
  }
  return trades.filter((trade) => !drop.has(trade.id));
}

function parseTrade(value: unknown): StoredTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  const openedAt = asTime(row.openedAt);
  if (openedAt == null) return null;
  const ticker = typeof row.ticker === "string" ? row.ticker.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) return null;
  const putCall = row.putCall === "put" ? "put" : row.putCall === "call" ? "call" : null;
  if (!putCall) return null;
  const strike = asPositive(row.strike);
  if (strike == null) return null;
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  if (!DATE_PATTERN.test(expiration)) return null;
  const contracts = row.contracts;
  if (!Number.isInteger(contracts) || (contracts as number) < 1 || (contracts as number) > TRADE_RULES.maxContracts) return null;
  const entryPrice = asPositive(row.entryPrice);
  if (entryPrice == null) return null;
  const closedAt = row.closedAt == null ? null : asTime(row.closedAt);
  if (row.closedAt != null && closedAt == null) return null;
  const exitPrice = row.exitPrice == null ? null : asPositive(row.exitPrice);
  if (closedAt == null && exitPrice != null) return null;
  if (closedAt != null && (exitPrice == null || closedAt < openedAt)) return null;
  return {
    id,
    openedAt,
    ticker,
    putCall,
    strike,
    expiration,
    contracts: contracts as number,
    entryPrice,
    entryPriceSource: row.entryPriceSource === "ask" || row.entryPriceSource === "typed" ? row.entryPriceSource : null,
    flowPremium: cleanPremium(typeof row.flowPremium === "number" ? row.flowPremium : null),
    structure: row.structure === "debit-spread" ? "debit-spread" : "single",
    alertId: cleanId(typeof row.alertId === "string" ? row.alertId : null),
    alertVerdict: parseVerdict(row.alertVerdict),
    alertGrade: parseGrade(row.alertGrade),
    closedAt,
    exitPrice,
    exitNote: cleanNote(typeof row.exitNote === "string" ? row.exitNote : null),
  };
}

function asTime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1_500_000_000_000) return null;
  return value;
}

function asPositive(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) return null;
  return value;
}

function parseVerdict(value: unknown): VerdictName | null {
  if (typeof value !== "string") return null;
  for (let i = 0; i < VERDICTS.length; i++) {
    if (VERDICTS[i] === value) return VERDICTS[i];
  }
  return null;
}

function parseGrade(value: unknown): LetterGrade | null {
  if (typeof value !== "string") return null;
  for (let i = 0; i < GRADES.length; i++) {
    if (GRADES[i] === value) return GRADES[i];
  }
  return null;
}

function cleanId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:|-]{4,120}$/.test(trimmed)) return null;
  return trimmed;
}

function cleanNote(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, TRADE_RULES.maxNoteLength);
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function daysSinceMonday(weekday: string): number {
  const index = WEEKDAYS.indexOf(weekday);
  if (index < 0) return 0;
  return index === 0 ? 6 : index - 1;
}

function shiftYmd(ymd: string, days: number): string {
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  const utc = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) + days * 86_400_000;
  const date = new Date(utc);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}
