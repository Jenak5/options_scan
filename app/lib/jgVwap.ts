import { JG_VWAP_BUDGET_DOLLARS, JG_VWAP_TEST } from "@/app/lib/alertConfig";
import type { CandleBar } from "@/app/lib/candleTypes";
import type { OptionContract, PutCall } from "@/app/lib/contract";
import { newYorkDate } from "@/app/lib/flow";
import { nyMinutes } from "@/app/lib/featureBackfill";
import { isChicagoMarketHours, isMarketDay } from "@/app/lib/marketHours";
import { DEFAULT_ACCOUNT_SIZE_DOLLARS } from "@/app/lib/risk";
import { completedSessionMinutes } from "@/app/lib/vwapPut";

/**
 * Paper-only J.G. Banks 0DTE entry with a session-VWAP filter.
 * The repo has no separate Banks signal. Direction is the side of session VWAP:
 * a call when price is on the call side of the band, a put when it is on the put side.
 * Inside the band both inequalities pass, so there is no entry.
 * Nothing here grades an alert, sends the A/B Telegram path, or places an order.
 *
 * Session VWAP matches the other paper rule: completed regular-hours minutes,
 * typical price (H+L+C)/3, volume floored at 1, anchored at 9:30 ET.
 * The day's implied move is spot × annualized IV × sqrt(1/365).
 */

export const JG_VWAP_TICKERS = ["QQQ", "SPX"] as const;
export type JgTicker = (typeof JG_VWAP_TICKERS)[number];
export type JgChainRoot = "QQQ" | "SPX" | "SPXW";

/** NYSE early closes already listed in marketHours.ts. Cash session ends at 1:00 PM ET. */
const EARLY_CLOSE_ET = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const FLAT_EXIT_ET = 15 * 60 + 45;
const EARLY_FLAT_EXIT_ET = 13 * 60;
const IMPLIED_MOVE_YEAR_DAYS = 365;
const ROW_CAP = 1_500;

export function jgChainRoots(ticker: JgTicker): readonly string[] {
  return ticker === "SPX" ? ["SPX", "SPXW"] : ["QQQ"];
}

/** Price-history symbol. SPX options may be SPXW; the index candles stay on SPX. */
export function jgHistorySymbol(ticker: JgTicker): string {
  return ticker;
}

export function jgVwapSessionOpen(now: Date): boolean {
  return isMarketDay(now) && isChicagoMarketHours(now);
}

export function jgFlatExitMinute(day: string): number {
  return EARLY_CLOSE_ET.has(day) ? EARLY_FLAT_EXIT_ET : FLAT_EXIT_ET;
}

/**
 * Call when price is on the call side of VWAP and not also on the put side.
 * Put when price is on the put side and not also on the call side.
 * Null inside the band, or when price or VWAP is missing.
 */
export function jgVwapSide(price: number, vwap: number): PutCall | null {
  if (!(price > 0) || !(vwap > 0) || !Number.isFinite(price) || !Number.isFinite(vwap)) return null;
  const band = JG_VWAP_TEST.vwapBand;
  const callSide = price >= vwap * (1 - band);
  const putSide = price <= vwap * (1 + band);
  if (callSide && !putSide) return "call";
  if (putSide && !callSide) return "put";
  return null;
}

/** floor(budget / (ask × 100)). Above the budget, log 1 contract and flag it. */
export function jgVwapSize(ask: number): { contracts: number; overBudget: boolean } | null {
  if (!(ask > 0) || !Number.isFinite(ask)) return null;
  const cost = ask * 100;
  if (!(cost > 0) || !Number.isFinite(cost)) return null;
  const fit = Math.floor(JG_VWAP_BUDGET_DOLLARS / cost);
  if (fit >= 1) return { contracts: fit, overBudget: false };
  return { contracts: 1, overBudget: true };
}

/** True when the bid/ask is wider than 10% of the mid. A spread equal to 10% is kept. */
export function jgSpreadTooWide(bid: number, ask: number): boolean {
  if (!(ask > 0) || !(bid >= 0) || !Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return true;
  const mid = (ask + bid) / 2;
  if (!(mid > 0)) return true;
  return (ask - bid) / mid > JG_VWAP_TEST.maxSpreadOfMid + 1e-12;
}

export function jgImpliedMove(spot: number, iv: number): number | null {
  if (!(spot > 0) || !(iv > 0) || !Number.isFinite(spot) || !Number.isFinite(iv)) return null;
  const move = spot * iv * Math.sqrt(1 / IMPLIED_MOVE_YEAR_DAYS);
  return move > 0 && Number.isFinite(move) ? move : null;
}

export function jgStopUnderlying(putCall: PutCall, entry: number, move: number): number | null {
  if (!(entry > 0) || !(move > 0)) return null;
  const distance = JG_VWAP_TEST.stopFractionOfImpliedMove * move;
  const stop = putCall === "call" ? entry - distance : entry + distance;
  if (!Number.isFinite(stop) || stop <= 0) return null;
  return stop;
}

export function jgVwapPnl(ask: number, bid: number, contracts: number): number {
  const gross = (bid - ask) * 100 * contracts;
  const fees = JG_VWAP_TEST.feePerSide * 2 * contracts;
  return roundCents(gross - fees);
}

export function jgSessionVwap(bars: readonly CandleBar[], nowMs: number): { vwap: number; close: number } | null {
  if (!Number.isFinite(nowMs)) return null;
  const today = newYorkDate(new Date(nowMs));
  const session = completedSessionMinutes(bars, nowMs).filter((bar) => newYorkDate(new Date(bar.t)) === today);
  if (session.length === 0) return null;
  let weighted = 0;
  let volume = 0;
  for (let i = 0; i < session.length; i++) {
    const bar = session[i];
    const typical = (bar.h + bar.l + bar.c) / 3;
    if (!Number.isFinite(typical) || !(typical > 0)) continue;
    const weight = bar.v != null && Number.isFinite(bar.v) && bar.v >= 1 ? bar.v : 1;
    weighted += typical * weight;
    volume += weight;
  }
  if (!(volume > 0)) return null;
  const close = session[session.length - 1].c;
  if (!(close > 0)) return null;
  return { vwap: weighted / volume, close };
}

export interface JgVwapTrade {
  id: string;
  ticker: JgTicker;
  root: string;
  putCall: PutCall;
  strike: number;
  expiration: string;
  openedAt: number;
  contracts: number;
  overBudget: boolean;
  entryAsk: number;
  entryBid: number;
  entryUnderlying: number;
  vwap: number;
  iv: number;
  impliedMove: number;
  stopUnderlying: number;
  status: "open" | "closed";
  closedAt: number | null;
  exitBid: number | null;
  exitReason: "stop" | "flat" | null;
  pnlDollars: number | null;
}

export interface JgVwapBook {
  version: 1;
  trades: JgVwapTrade[];
  /** Last chain root that returned SPX contracts. Null until one does. */
  spxRoot: "SPX" | "SPXW" | null;
  /** Latest run found neither an SPX nor an SPXW chain. */
  spxUnavailable: boolean;
  /** Latest run had no SPX session VWAP from 1-minute candles. */
  spxVwapMiss: boolean;
}

export interface JgSnapshot {
  ticker: JgTicker;
  root: string | null;
  spot: number | null;
  vwap: number | null;
  contracts: readonly OptionContract[];
}

export interface JgRunMeta {
  /** Chain root that worked on this run. Null when both SPX and SPXW missed. */
  spxRoot: "SPX" | "SPXW" | null;
  spxChainMiss: boolean;
  spxVwapMiss: boolean;
}

export function emptyJgVwapBook(): JgVwapBook {
  return { version: 1, trades: [], spxRoot: null, spxUnavailable: false, spxVwapMiss: false };
}

export function serializeJgVwapBook(book: JgVwapBook): string {
  return JSON.stringify({
    version: 1,
    trades: book.trades,
    spxRoot: book.spxRoot,
    spxUnavailable: book.spxUnavailable,
    spxVwapMiss: book.spxVwapMiss,
  });
}

export function parseJgVwapBook(text: string | null | undefined): JgVwapBook {
  if (!text) return emptyJgVwapBook();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyJgVwapBook();
  }
  const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  if (!row || !Array.isArray(row.trades)) return emptyJgVwapBook();
  const trades: JgVwapTrade[] = [];
  for (let i = 0; i < row.trades.length; i++) {
    const trade = parseTrade(row.trades[i]);
    if (trade) trades.push(trade);
  }
  const spxRoot = row.spxRoot === "SPX" || row.spxRoot === "SPXW" ? row.spxRoot : null;
  return {
    version: 1,
    trades: trimTrades(trades),
    spxRoot,
    spxUnavailable: row.spxUnavailable === true,
    spxVwapMiss: row.spxVwapMiss === true,
  };
}

export function advanceJgVwap(
  book: JgVwapBook,
  snapshots: readonly JgSnapshot[],
  now: Date,
  meta?: JgRunMeta,
): { book: JgVwapBook; opened: JgVwapTrade[]; closed: JgVwapTrade[] } {
  if (!jgVwapSessionOpen(now)) return { book, opened: [], closed: [] };
  const day = newYorkDate(now);
  const exitMinute = jgFlatExitMinute(day);
  const minutes = nyMinutes(now.getTime());
  const byTicker = new Map<JgTicker, JgSnapshot>();
  for (let i = 0; i < snapshots.length; i++) byTicker.set(snapshots[i].ticker, snapshots[i]);
  const closed: JgVwapTrade[] = [];
  const opened: JgVwapTrade[] = [];
  let trades = book.trades.map((trade) => ({ ...trade }));

  for (let i = 0; i < JG_VWAP_TICKERS.length; i++) {
    const ticker = JG_VWAP_TICKERS[i];
    const snap = byTicker.get(ticker) ?? null;
    trades = trades.map((trade) => {
      if (trade.ticker !== ticker || trade.status !== "open") return trade;
      const next = markOpen(trade, snap, now, day, minutes, exitMinute);
      if (next.status === "closed" && trade.status === "open") closed.push(next);
      return next;
    });
    if (minutes >= exitMinute) continue;
    if (trades.some((trade) => trade.ticker === ticker && (trade.status === "open" || trade.expiration === day))) continue;
    const trade = openTrade(ticker, snap, now, day);
    if (!trade) continue;
    trades.push(trade);
    opened.push(trade);
  }

  return {
    book: {
      version: 1,
      trades: trimTrades(trades),
      spxRoot: meta ? (meta.spxRoot ?? book.spxRoot) : book.spxRoot,
      spxUnavailable: meta ? meta.spxChainMiss : book.spxUnavailable,
      spxVwapMiss: meta ? meta.spxVwapMiss : book.spxVwapMiss,
    },
    opened,
    closed,
  };
}

export interface JgVwapBucket {
  key: "QQQ" | "SPX" | "SPX-over-budget";
  label: string;
  trades: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  pnlWithoutTop3: number | null;
  maxDrawdownDollars: number;
  maxDrawdownVsAccount: number;
}

export interface JgVwapSection {
  label: string;
  note: string;
  trustNote: string;
  tooFew: boolean;
  targetSample: number;
  budgetDollars: number;
  accountDollars: number;
  spxRoot: "SPX" | "SPXW" | null;
  spxUnavailable: boolean;
  spxVwapMiss: boolean;
  buckets: JgVwapBucket[];
  rows: JgVwapTrade[];
}

export function jgVwapSection(book: JgVwapBook): JgVwapSection {
  const qqq = bucketOf(book.trades, "QQQ", "QQQ", (trade) => trade.ticker === "QQQ" && !trade.overBudget);
  const spx = bucketOf(book.trades, "SPX", "SPX", (trade) => trade.ticker === "SPX" && !trade.overBudget);
  const over = bucketOf(
    book.trades,
    "SPX-over-budget",
    "SPX over budget",
    (trade) => trade.ticker === "SPX" && trade.overBudget,
  );
  const closedAll = book.trades.filter((trade) => trade.status === "closed" && trade.pnlDollars != null).length;
  return {
    label: JG_VWAP_TEST.label,
    note: sectionNote(book),
    trustNote: trustNote(closedAll),
    tooFew: closedAll < JG_VWAP_TEST.minTrust,
    targetSample: JG_VWAP_TEST.minTrust,
    budgetDollars: JG_VWAP_BUDGET_DOLLARS,
    accountDollars: DEFAULT_ACCOUNT_SIZE_DOLLARS,
    spxRoot: book.spxRoot,
    spxUnavailable: book.spxUnavailable,
    spxVwapMiss: book.spxVwapMiss,
    buckets: [qqq, spx, over],
    rows: book.trades.slice().sort((a, b) => b.openedAt - a.openedAt).slice(0, 24),
  };
}

export function formatJgVwapAlert(trade: JgVwapTrade): string {
  const right = trade.putCall.toUpperCase();
  const budget = JG_VWAP_BUDGET_DOLLARS.toFixed(0);
  const stopWord = trade.putCall === "call" ? "at or below" : "at or above";
  const over = trade.overBudget
    ? `\n<b>Over budget.</b> One contract costs more than $${budget}. Logged as 1 contract${trade.ticker === "SPX" ? ", in the SPX over-budget scorecard bucket" : ", and left out of the QQQ totals"}.`
    : "";
  const root = trade.root !== trade.ticker ? `\nContract root <b>${escapeHtml(trade.root)}</b>.` : "";
  return `<b>PAPER TEST - JG-VWAP</b>
${escapeHtml(trade.ticker)} <b>${right}</b> · $${trimPrice(trade.strike)} exp ${escapeHtml(trade.expiration)}
Paper only. This is not an A or a B, and it is outside the daily A/B alert cap. No order is placed.${over}

Buy <b>${trade.contracts}</b> at the ask $${trimPrice(trade.entryAsk)} (bid $${trimPrice(trade.entryBid)}). Budget $${budget}.
Underlying $${trimPrice(trade.entryUnderlying)} vs session VWAP $${trimPrice(trade.vwap)}.
Stop if the underlying trades ${stopWord} $${trimPrice(trade.stopUnderlying)} (0.75× the day's implied move).
If it is still open, sell at the bid by the flat exit (3:45 PM ET, or 1:00 PM ET on an early close).${root}`;
}

function openTrade(ticker: JgTicker, snap: JgSnapshot | null, now: Date, day: string): JgVwapTrade | null {
  if (!snap || snap.root == null || snap.spot == null || snap.vwap == null) return null;
  if (!(snap.spot > 0) || !(snap.vwap > 0)) return null;
  const side = jgVwapSide(snap.spot, snap.vwap);
  if (!side) return null;
  const contract = pickSameDay(snap.contracts, side, day, snap.spot);
  if (!contract) return null;
  const iv = contractIv(snap.contracts, contract);
  if (iv == null) return null;
  const move = jgImpliedMove(snap.spot, iv);
  if (move == null) return null;
  const stop = jgStopUnderlying(side, snap.spot, move);
  if (stop == null) return null;
  const size = jgVwapSize(contract.ask);
  if (!size) return null;
  return {
    id: `jgvwap-${ticker}-${day}`,
    ticker,
    root: snap.root,
    putCall: side,
    strike: contract.strike,
    expiration: day,
    openedAt: now.getTime(),
    contracts: size.contracts,
    overBudget: size.overBudget,
    entryAsk: contract.ask,
    entryBid: contract.bid,
    entryUnderlying: snap.spot,
    vwap: snap.vwap,
    iv,
    impliedMove: move,
    stopUnderlying: stop,
    status: "open",
    closedAt: null,
    exitBid: null,
    exitReason: null,
    pnlDollars: null,
  };
}

function markOpen(
  trade: JgVwapTrade,
  snap: JgSnapshot | null,
  now: Date,
  day: string,
  minutes: number,
  exitMinute: number,
): JgVwapTrade {
  const expired = trade.expiration < day;
  const quote = snap ? findQuote(snap.contracts, trade) : null;
  const spot = snap?.spot != null && snap.spot > 0 ? snap.spot : null;
  const stopped = spot != null && hitStop(trade, spot);
  const timed = minutes >= exitMinute;
  if (!expired && !stopped && !timed) return trade;
  if (!expired && !quote) return trade;
  const bid = quote && quote.bid >= 0 ? quote.bid : 0;
  const reason = stopped ? "stop" : "flat";
  return {
    ...trade,
    status: "closed",
    closedAt: now.getTime(),
    exitBid: bid,
    exitReason: reason,
    pnlDollars: jgVwapPnl(trade.entryAsk, bid, trade.contracts),
  };
}

function hitStop(trade: JgVwapTrade, spot: number): boolean {
  return trade.putCall === "call" ? spot <= trade.stopUnderlying : spot >= trade.stopUnderlying;
}

function pickSameDay(
  contracts: readonly OptionContract[],
  side: PutCall,
  day: string,
  spot: number,
): OptionContract | null {
  const same = contracts.filter((contract) => (
    contract.putCall === side
    && contract.expiration === day
    && contract.strike > 0
    && contract.ask > 0
    && contract.bid >= 0
    && !jgSpreadTooWide(contract.bid, contract.ask)
  ));
  if (same.length === 0) return null;
  same.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  return same[0];
}

function contractIv(contracts: readonly OptionContract[], chosen: OptionContract): number | null {
  if (chosen.iv != null && chosen.iv > 0) return chosen.iv;
  const sameStrike = contracts.find((contract) => (
    contract.expiration === chosen.expiration
    && contract.strike === chosen.strike
    && contract.iv != null
    && contract.iv > 0
  ));
  if (sameStrike?.iv != null && sameStrike.iv > 0) return sameStrike.iv;
  let best: OptionContract | null = null;
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    if (contract.expiration !== chosen.expiration || contract.iv == null || !(contract.iv > 0)) continue;
    if (!best || Math.abs(contract.strike - chosen.strike) < Math.abs(best.strike - chosen.strike)) best = contract;
  }
  return best?.iv != null && best.iv > 0 ? best.iv : null;
}

function findQuote(contracts: readonly OptionContract[], trade: JgVwapTrade): OptionContract | null {
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    if (contract.putCall !== trade.putCall) continue;
    if (contract.expiration !== trade.expiration) continue;
    if (contract.strike !== trade.strike) continue;
    if (!(contract.bid >= 0) || !Number.isFinite(contract.bid)) continue;
    return contract;
  }
  return null;
}

function bucketOf(
  trades: readonly JgVwapTrade[],
  key: JgVwapBucket["key"],
  label: string,
  keep: (trade: JgVwapTrade) => boolean,
): JgVwapBucket {
  const rows = trades.filter(keep);
  const closed = rows.filter((trade) => trade.status === "closed" && trade.pnlDollars != null);
  const ordered = closed.slice().sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const pnls = ordered.map((trade) => trade.pnlDollars as number);
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  for (let i = 0; i < pnls.length; i++) {
    pnl += pnls[i];
    if (pnls[i] > 0) wins += 1;
    else if (pnls[i] < 0) losses += 1;
  }
  const decided = wins + losses;
  const drawdown = maxDrawdown(pnls, DEFAULT_ACCOUNT_SIZE_DOLLARS);
  return {
    key,
    label,
    trades: closed.length,
    open: rows.filter((trade) => trade.status === "open").length,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : null,
    pnl: roundCents(pnl),
    pnlWithoutTop3: pnlWithoutTop(pnls, 3),
    maxDrawdownDollars: drawdown.dollars,
    maxDrawdownVsAccount: drawdown.fraction,
  };
}

function maxDrawdown(pnls: readonly number[], account: number): { dollars: number; fraction: number } {
  let equity = account;
  let peak = account;
  let max = 0;
  for (let i = 0; i < pnls.length; i++) {
    equity += pnls[i];
    if (equity > peak) peak = equity;
    const drop = peak - equity;
    if (drop > max) max = drop;
  }
  return {
    dollars: roundCents(max),
    fraction: account > 0 ? max / account : 0,
  };
}

function pnlWithoutTop(pnls: readonly number[], drop: number): number | null {
  if (pnls.length <= drop) return null;
  const sorted = pnls.slice().sort((a, b) => b - a);
  let sum = 0;
  for (let i = drop; i < sorted.length; i++) sum += sorted[i];
  return roundCents(sum);
}

function trustNote(closed: number): string {
  if (closed < JG_VWAP_TEST.minTrust) {
    return `${closed} closed paper trades. Fewer than ${JG_VWAP_TEST.minTrust} is too few to read as a result.`;
  }
  return `${closed} closed paper trades. That is enough to describe. It does not change a live alert or an exit.`;
}

function sectionNote(book: JgVwapBook): string {
  const budget = JG_VWAP_BUDGET_DOLLARS;
  const spx = spxNote(book);
  return `${JG_VWAP_TEST.label}. These rows are left out of the A and B totals above. Each entry sends a Telegram message labeled PAPER TEST - JG-VWAP, and that message is outside the daily A/B cap. QQQ and SPX, same-day expiry, in the direction of session VWAP. A call needs price at or above VWAP × ${(1 - JG_VWAP_TEST.vwapBand).toFixed(3)}, and it is skipped when that price is also on the put side of the band. A put needs price at or below VWAP × ${(1 + JG_VWAP_TEST.vwapBand).toFixed(3)}, and it is skipped when that price is also on the call side. Session VWAP is the regular-hours typical price from 1-minute candles, volume floored at 1, from 9:30 ET. One paper entry per ticker per day. The logged strike is the nearest same-day strike in that direction whose spread is within ${JG_VWAP_TEST.maxSpreadOfMid * 100}% of the mid. Buy at the ask, sell at the bid, $${JG_VWAP_TEST.feePerSide.toFixed(2)} a contract each side. Contracts are floor(${budget} / (ask × 100)). A contract above $${budget} is logged as 1 and flagged over budget. Over-budget SPX stays in its own bucket. Over-budget QQQ is flagged on the row and left out of the QQQ totals. The stop is ${JG_VWAP_TEST.stopFractionOfImpliedMove}× the day's implied move (spot × IV × sqrt(1/365)) against the entry. Anything still open is sold at the bid at 3:45 PM ET, or at 1:00 PM ET on an NYSE early close. Full-day NYSE holidays are skipped. Market hours only. No order is placed. ${spx}`;
}

function spxNote(book: JgVwapBook): string {
  const root = book.spxRoot === "SPXW"
    ? "SPX option contracts are read on the SPXW root."
    : book.spxRoot === "SPX"
      ? "SPX option contracts are read on the SPX symbol."
      : "SPX has not returned a chain yet.";
  const chain = book.spxUnavailable
    ? " The latest run found no SPX chain and no SPXW chain, so a new SPX entry waits. QQQ still logs."
    : "";
  const vwap = book.spxVwapMiss
    ? " The latest run had no SPX 1-minute candles, so session VWAP for SPX was missing and a new SPX entry waits."
    : "";
  return `${root}${chain}${vwap}`;
}

function trimTrades(trades: JgVwapTrade[]): JgVwapTrade[] {
  if (trades.length <= ROW_CAP) return trades;
  const drop = new Set<string>();
  let extra = trades.length - ROW_CAP;
  const closed = trades.filter((trade) => trade.status === "closed").slice().sort((a, b) => a.openedAt - b.openedAt);
  for (let i = 0; i < closed.length && extra > 0; i++) {
    drop.add(closed[i].id);
    extra -= 1;
  }
  return trades.filter((trade) => !drop.has(trade.id));
}

function parseTrade(value: unknown): JgVwapTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const ticker = row.ticker === "QQQ" || row.ticker === "SPX" ? row.ticker : null;
  if (!ticker) return null;
  const putCall = row.putCall === "call" || row.putCall === "put" ? row.putCall : null;
  if (!putCall) return null;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!/^jgvwap-(QQQ|SPX)-\d{4}-\d{2}-\d{2}$/.test(id)) return null;
  const expiration = typeof row.expiration === "string" ? row.expiration : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  const strike = asPositive(row.strike);
  const openedAt = asTime(row.openedAt);
  const contracts = asWhole(row.contracts);
  const entryAsk = asPositive(row.entryAsk);
  const entryBid = asNonNegative(row.entryBid);
  const entryUnderlying = asPositive(row.entryUnderlying);
  const vwap = asPositive(row.vwap);
  const iv = asPositive(row.iv);
  const impliedMove = asPositive(row.impliedMove);
  const stopUnderlying = asPositive(row.stopUnderlying);
  if (
    strike == null || openedAt == null || contracts == null || entryAsk == null || entryBid == null
    || entryUnderlying == null || vwap == null || iv == null || impliedMove == null || stopUnderlying == null
  ) return null;
  const status = row.status === "closed" ? "closed" : row.status === "open" ? "open" : null;
  if (!status) return null;
  const closedAt = row.closedAt == null ? null : asTime(row.closedAt);
  const exitBid = row.exitBid == null ? null : asNonNegative(row.exitBid);
  const exitReason = row.exitReason === "stop" || row.exitReason === "flat" ? row.exitReason : null;
  const pnlDollars = row.pnlDollars == null ? null : asFinite(row.pnlDollars);
  if (status === "open" && (closedAt != null || exitBid != null || exitReason != null || pnlDollars != null)) return null;
  if (status === "closed" && (closedAt == null || exitBid == null || exitReason == null || pnlDollars == null)) return null;
  const root = typeof row.root === "string" && row.root.trim() ? row.root.trim().toUpperCase() : ticker;
  return {
    id,
    ticker,
    root,
    putCall,
    strike,
    expiration,
    openedAt,
    contracts,
    overBudget: row.overBudget === true,
    entryAsk,
    entryBid,
    entryUnderlying,
    vwap,
    iv,
    impliedMove,
    stopUnderlying,
    status,
    closedAt,
    exitBid,
    exitReason,
    pnlDollars,
  };
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function trimPrice(value: number): string {
  const rounded = roundCents(value);
  return Number.isInteger(rounded) ? rounded.toFixed(2) : String(rounded);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function asPositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asWhole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}
