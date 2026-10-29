import type { OptionContract, PutCall } from "@/app/lib/contract";
import { calendarDaysBetween, flowChainRequest, newYorkDate } from "@/app/lib/flow";
import { getOptionChain, getQuotes } from "@/app/lib/marketData";
import { parseTradeAggressor, type TapeSide, type TradePrint, type UnusualInterval } from "@/app/lib/unusualFlow";

/**
 * The only market-data reads for unusual flow.
 *
 * These are not Tastytrade-first. They call the chain and quote helpers this
 * app uses today. An upcoming pull request adds a shared provider layer with
 * Tastytrade as the primary source and Schwab as the fallback. These two
 * functions will move onto that layer when it lands. The screener itself does
 * not choose a source, and this file does not build that switch.
 *
 * The cron does not call them. It scores the chain the scan already fetched,
 * after the AVWAP check and the other paper checks, so this pass does not add
 * a request and does not run ahead of those checks.
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
  return {
    symbol: symbol.trim().toUpperCase(),
    underlyingPrice: chain.underlyingPrice,
    delayed: chain.delayed,
    contracts: chain.contracts.map(contractFromChain),
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

function contractFromChain(contract: OptionContract): UnusualChainContract {
  const extra = contract as OptionContract & { aggressor?: unknown; tradeSide?: unknown; trades?: unknown };
  return {
    expiration: contract.expiration,
    strike: contract.strike,
    putCall: contract.putCall,
    bid: contract.bid,
    ask: contract.ask,
    last: contract.last,
    volume: contract.volume,
    openInterest: contract.openInterest,
    tradeAggressor: parseTradeAggressor(extra.aggressor ?? extra.tradeSide),
    trades: parseChainTrades(extra.trades),
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
      aggressor: parseTradeAggressor(trade.aggressor),
      price: typeof trade.price === "number" ? trade.price : null,
      bid: typeof trade.bid === "number" ? trade.bid : null,
      ask: typeof trade.ask === "number" ? trade.ask : null,
    });
  }
  return trades.length > 0 ? trades : undefined;
}
