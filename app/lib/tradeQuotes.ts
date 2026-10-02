import type { StoredTrade } from "@/app/lib/trades";
import { findContract, checkBidAskSpread } from "@/app/lib/gate";
import { getOptionChain, schwabConfigured, SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";

/**
 * Midpoint marks for open paper trades, from the same Schwab chain the scanner uses.
 * A missing quote leaves that trade unmarked. Nothing here places an order.
 */
export async function quoteTradeMarks(trades: readonly Pick<StoredTrade, "id" | "ticker" | "putCall" | "strike" | "expiration" | "closedAt">[]): Promise<Record<string, number>> {
  const marks: Record<string, number> = {};
  if (!schwabConfigured()) return marks;
  const open = trades.filter((trade) => trade.closedAt == null);
  const seen = new Set<string>();
  for (let i = 0; i < open.length; i++) {
    const trade = open[i];
    const key = `${trade.ticker}|${trade.expiration}|${trade.strike}|${trade.putCall}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let mid: number | null = null;
    try {
      const chain = await getOptionChain({
        symbol: trade.ticker,
        contractType: trade.putCall === "call" ? "CALL" : "PUT",
        strike: trade.strike,
        fromDate: trade.expiration,
        toDate: trade.expiration,
      });
      const contract = findContract(chain.contracts, {
        expiration: trade.expiration,
        strike: trade.strike,
        putCall: trade.putCall,
      });
      if (contract) mid = checkBidAskSpread(contract.bid, contract.ask).mid;
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) return marks;
      mid = null;
    }
    if (mid == null || !(mid > 0)) continue;
    for (let j = 0; j < open.length; j++) {
      const other = open[j];
      if (other.ticker !== trade.ticker || other.putCall !== trade.putCall) continue;
      if (other.expiration !== trade.expiration) continue;
      if (Math.abs(other.strike - trade.strike) >= 0.001) continue;
      marks[other.id] = mid;
    }
  }
  return marks;
}
