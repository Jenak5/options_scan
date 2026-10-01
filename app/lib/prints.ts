import { PRINT_RULES } from "@/app/lib/alertConfig";
import type { OptionContract } from "@/app/lib/contract";

/**
 * Prints inferred from Schwab option quotes.
 *
 * A chain quote has the latest trade (last, last size, trade time, bid, and ask)
 * and the day's total volume. It is not a time-and-sales tape, and the exchange
 * field is one quote source, not the exchanges a sweep paid. Nothing here is an
 * exchange-reported sweep.
 */

export const PRINT_SOURCE = "detected from Schwab quotes";

export const NOT_EXCHANGE_SWEEP = "Not an exchange-reported sweep.";

export interface FlowQuotePoint {
  at: number;
  volume: number;
  last: number | null;
  lastSize: number | null;
  bid: number | null;
  ask: number | null;
  tradeTime: number | null;
}

export type PrintSide = "at ask" | "at bid" | "between" | "unknown";

interface SeenPrint {
  tradeTime: number | null;
  at: number;
  lastSize: number | null;
  volumeDelta: number;
  side: PrintSide;
  price: number | null;
  cluster: boolean;
}

export interface PrintRead {
  source: typeof PRINT_SOURCE;
  summary: string | null;
  block: boolean;
  sweepLike: boolean;
  printCount: number;
  lastSize: number | null;
  side: PrintSide | null;
}

export const EMPTY_PRINTS: PrintRead = {
  source: PRINT_SOURCE,
  summary: null,
  block: false,
  sweepLike: false,
  printCount: 0,
  lastSize: null,
  side: null,
};

export function quotePointFromContract(contract: OptionContract, at: number): FlowQuotePoint {
  return {
    at,
    volume: finiteNonNegative(contract.volume) ?? 0,
    last: finiteNonNegative(contract.last),
    lastSize: positive(contract.lastSize),
    bid: finiteNonNegative(contract.bid),
    ask: finiteNonNegative(contract.ask),
    tradeTime: positive(contract.tradeTime),
  };
}

export function detectPrints(input: {
  points: FlowQuotePoint[];
  delayed?: boolean;
}): PrintRead {
  const points = input.points
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.volume) && point.volume >= 0)
    .slice()
    .sort((a, b) => a.at - b.at || (a.tradeTime ?? 0) - (b.tradeTime ?? 0));
  const seen: SeenPrint[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    if (point.volume < prev.volume) continue;
    const volumeDelta = point.volume - prev.volume;
    const tradeAdvanced = point.tradeTime != null && (prev.tradeTime == null || point.tradeTime > prev.tradeTime);
    if (volumeDelta <= 0 && !tradeAdvanced) continue;
    if (point.tradeTime != null && seen.some((row) => row.tradeTime === point.tradeTime)) continue;
    const lastSize = point.lastSize;
    seen.push({
      tradeTime: point.tradeTime,
      at: point.at,
      lastSize,
      volumeDelta,
      side: sideAtPrint(point.last, point.bid, point.ask),
      price: printPrice(point),
      cluster: lastSize != null && volumeDelta > lastSize,
    });
  }
  if (seen.length === 0) return EMPTY_PRINTS;

  const block = seen.some((row) => isBlock(row));
  const sweep = input.delayed === true ? null : sweepBurst(seen);
  const latest = seen[seen.length - 1];
  return {
    source: PRINT_SOURCE,
    summary: summarize(seen, block, sweep, input.delayed === true),
    block,
    sweepLike: sweep != null,
    printCount: seen.length,
    lastSize: latest.lastSize,
    side: latest.side,
  };
}

function sideAtPrint(last: number | null, bid: number | null, ask: number | null): PrintSide {
  if (last == null || bid == null || ask == null) return "unknown";
  if (!(ask >= bid)) return "unknown";
  if (last >= ask) return "at ask";
  if (last <= bid) return "at bid";
  return "between";
}

function printPrice(point: FlowQuotePoint): number | null {
  if (point.last != null && point.last > 0) return point.last;
  if (point.bid != null && point.ask != null && point.ask >= point.bid) {
    const mid = (point.bid + point.ask) / 2;
    return mid > 0 ? mid : null;
  }
  return null;
}

function isBlock(row: SeenPrint): boolean {
  if (row.lastSize == null) return false;
  if (row.lastSize >= PRINT_RULES.blockMinContracts) return true;
  if (row.price == null) return false;
  return row.lastSize * row.price * 100 >= PRINT_RULES.blockMinNotional;
}

function sweepBurst(rows: SeenPrint[]): { side: PrintSide; count: number; spanMs: number } | null {
  const sides: PrintSide[] = ["at ask", "at bid"];
  let best: { side: PrintSide; count: number; spanMs: number } | null = null;
  for (let s = 0; s < sides.length; s++) {
    const side = sides[s];
    const times: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].side === side && rows[i].tradeTime != null) times.push(rows[i].tradeTime as number);
    }
    times.sort((a, b) => a - b);
    let left = 0;
    for (let right = 0; right < times.length; right++) {
      while (times[right] - times[left] > PRINT_RULES.sweepWindowMs) left += 1;
      const count = right - left + 1;
      if (count < PRINT_RULES.sweepMinPrints) continue;
      const spanMs = times[right] - times[left];
      if (!best || count > best.count) best = { side, count, spanMs };
    }
  }
  return best;
}

function summarize(
  rows: SeenPrint[],
  block: boolean,
  sweep: { side: PrintSide; count: number; spanMs: number } | null,
  delayed: boolean,
): string {
  const latest = rows[rows.length - 1];
  const bits: string[] = [`${PRINT_SOURCE}:`];
  if (sweep) {
    const seconds = Math.max(1, Math.round(sweep.spanMs / 1000));
    bits.push(`sweep-like burst, ${sweep.count} prints ${sidePhrase(sweep.side)} within ${seconds} seconds.`);
  }
  if (block) {
    const sized = lastBlock(rows);
    bits.push(`block print, ${sizePhrase(sized)}.`);
  }
  if (!sweep && !block) {
    bits.push(`last print ${sizePhrase(latest)}.`);
    if (latest.cluster && latest.volumeDelta > 0) {
      bits.push(`Volume rose by ${Math.round(latest.volumeDelta)} contracts since the prior quote; only the last size is one print.`);
    }
  }
  bits.push(NOT_EXCHANGE_SWEEP);
  if (delayed) bits.push("Quotes were delayed.");
  return bits.join(" ");
}

function lastBlock(rows: SeenPrint[]): SeenPrint {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isBlock(rows[i])) return rows[i];
  }
  return rows[rows.length - 1];
}

function sizePhrase(row: SeenPrint): string {
  const size = row.lastSize == null ? "size not on the quote" : `${Math.round(row.lastSize)} contracts`;
  const dollars = row.lastSize != null && row.price != null
    ? ` (about ${compactDollars(row.lastSize * row.price * 100)})`
    : "";
  return `${size} ${sidePhrase(row.side)}${dollars}`;
}

function sidePhrase(side: PrintSide): string {
  if (side === "at ask") return "at the ask";
  if (side === "at bid") return "at the bid";
  if (side === "between") return "between the bid and ask";
  return "with no bid/ask side";
}

function compactDollars(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function positive(value: number | null | undefined): number | null {
  const parsed = finiteNonNegative(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed;
}
