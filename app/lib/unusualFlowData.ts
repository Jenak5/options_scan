import type { OptionContract, PutCall } from "@/app/lib/contract";
import { calendarDaysBetween, flowChainRequest, newYorkDate } from "@/app/lib/flow";
import { getOptionChain, getQuotes } from "@/app/lib/marketData";
import { getTradeSideDataAvailable } from "@/app/lib/marketDataHealth";
import { tapeFromAggressorSide, type TapeSide, type TradePrint, type UnusualInterval } from "@/app/lib/unusualFlow";

/**
 * The only market-data reads for unusual flow.
 *
 * Both functions go through the shared provider in app/lib/marketData.ts:
 * Tastytrade first, Schwab when that call fails. This file does not pick a
 * source and does not call either broker directly.
 *
 * DXLink TimeAndSale aggressor side is used only when that fetch reports
 * tradeSideDataAvailable yes. buy is the ask, sell is the bid. unknown, or
 * a no on that flag, falls back to the last-versus-bid/ask estimate.
 *
 * The cron does not call these. It scores the chain the scan already fetched,
 * after the AVWAP check and the other paper checks, so this pass does not add
 * a request and does not run ahead of those checks. That scan copies the
 * aggressor onto the row only when the same flag was yes for that chain.
 *
 * Chains and quotes only. No orders, accounts, or transactions.
 */

export interface UnusualChainContract {
  expiration: string;
  strike: number;
  putCall: PutCall;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  /** Null when this quote did not name an aggressor. */
  tradeAggressor: TapeSide | null;
  trades?: TradePrint[];
}

export interface UnusualChainSnapshot {
  symbol: string;
  underlyingPrice: number | null;
  delayed: boolean;
  contracts: UnusualChainContract[];
}

export async function fetchUnusualChain(symbol: string, now: Date): Promise<UnusualChainSnapshot> {
  const chain = await getOptionChain(flowChainRequest(symbol, now));
  const tape = getTradeSideDataAvailable() === "yes";
  return {
    symbol: symbol.trim().toUpperCase(),
    underlyingPrice: chain.underlyingPrice,
    delayed: chain.delayed,
    contracts: chain.contracts.map((contract) => contractFromChain(contract, tape)),
  };
}

export async function fetchUnusualQuotes(symbols: readonly string[]): Promise<OptionContract[]> {
  if (symbols.length === 0) return [];
  return getQuotes(symbols.slice());
}

/**
 * Turn one fetched chain into screener rows.
 * `previousVolume` is same-day volume by contract key (`expiration|strike|putCall`).
 * Pass null on the first scan of the session. This does not fetch.
 */
export function intervalsFromChain(
  chain: UnusualChainSnapshot,
  previousVolume: Readonly<Record<string, number>> | null,
  now: Date,
): UnusualInterval[] {
  const today = newYorkDate(now);
  const out: UnusualInterval[] = [];
  for (let i = 0; i < chain.contracts.length; i++) {
    const contract = chain.contracts[i];
    const dte = calendarDaysBetween(today, contract.expiration);
    if (dte == null || dte < 0) continue;
    const key = `${contract.expiration}|${contract.strike}|${contract.putCall}`;
    const prior = previousVolume ? previousVolume[key] : undefined;
    const previous = typeof prior === "number" && Number.isFinite(prior) ? prior : null;
    const mark = contract.ask >= contract.bid && contract.bid >= 0 ? (contract.bid + contract.ask) / 2 : null;
    out.push({
      symbol: chain.symbol,
      putCall: contract.putCall,
      strike: contract.strike,
      expiration: contract.expiration,
      volume: contract.volume,
      openInterest: contract.openInterest,
      previousVolume: previous,
      volumeJump: previous == null ? null : contract.volume - previous,
      bid: contract.bid,
      ask: contract.ask,
      last: contract.last,
      mark: mark != null && mark > 0 ? mark : null,
      dte,
      underlyingPrice: chain.underlyingPrice != null && chain.underlyingPrice > 0 ? chain.underlyingPrice : null,
      tradeAggressor: contract.tradeAggressor,
      trades: contract.trades,
    });
  }
  return out;
}

function contractFromChain(contract: OptionContract, tape: boolean): UnusualChainContract {
  const extra = contract as OptionContract & { trades?: unknown };
  return {
    expiration: contract.expiration,
    strike: contract.strike,
    putCall: contract.putCall,
    bid: contract.bid,
    ask: contract.ask,
    last: contract.last,
    volume: contract.volume,
    openInterest: contract.openInterest,
    tradeAggressor: tape ? tapeFromAggressorSide(contract.aggressorSide) : null,
    trades: tape ? parseChainTrades(extra.trades) : undefined,
  };
}

function parseChainTrades(value: unknown): TradePrint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const trades: TradePrint[] = [];
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    const trade = row as { size?: unknown; aggressor?: unknown; price?: unknown; bid?: unknown; ask?: unknown };
    if (typeof trade.size !== "number" || !(trade.size > 0)) continue;
    trades.push({
      size: trade.size,
      aggressor: tapeFromAggressorSide(trade.aggressor),
      price: typeof trade.price === "number" ? trade.price : null,
      bid: typeof trade.bid === "number" ? trade.bid : null,
      ask: typeof trade.ask === "number" ? trade.ask : null,
    });
  }
  return trades.length > 0 ? trades : undefined;
}
