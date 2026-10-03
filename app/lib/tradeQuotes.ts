import type { StoredTrade } from "@/app/lib/trades";
import { FLOW_BATCH_SIZE } from "@/app/lib/flow";
import { findContract, checkBidAskSpread } from "@/app/lib/gate";
import { getOptionChain, schwabConfigured, SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";

/**
 * Marks for open paper trades and shadow alerts, from the same Schwab chain the scanner uses.
 * The midpoint is the mark. The bid is kept for a shadow exit when the midpoint is missing.
 * A missing quote leaves that contract unmarked. Nothing here places an order.
 */

export interface ContractMark {
  mid: number | null;
  bid: number | null;
}

type Quotable = Pick<StoredTrade, "id" | "ticker" | "putCall" | "strike" | "expiration" | "closedAt">;

export async function quoteTradeMarks(trades: readonly Quotable[]): Promise<Record<string, number>> {
  const marks = await quoteContractMarks(trades);
  const mids: Record<string, number> = {};
  const ids = Object.keys(marks);
  for (let i = 0; i < ids.length; i++) {
    const mid = marks[ids[i]].mid;
    if (mid != null && mid > 0) mids[ids[i]] = mid;
  }
  return mids;
}

export async function quoteContractMarks(trades: readonly Quotable[]): Promise<Record<string, ContractMark>> {
  const marks: Record<string, ContractMark> = {};
  if (!schwabConfigured()) return marks;
  const open = trades.filter((trade) => trade.closedAt == null);
  const unique: Quotable[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < open.length; i++) {
    const trade = open[i];
    const key = contractKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trade);
  }

  for (let i = 0; i < unique.length; i += FLOW_BATCH_SIZE) {
    const batch = unique.slice(i, i + FLOW_BATCH_SIZE);
    let batchMarks: Array<{ trade: Quotable; mark: ContractMark | null }> = [];
    try {
      batchMarks = await Promise.all(batch.map(async (trade) => ({
        trade,
        mark: await readMark(trade),
      })));
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) return marks;
      batchMarks = [];
    }
    for (let j = 0; j < batchMarks.length; j++) {
      const item = batchMarks[j];
      if (!item.mark) continue;
      assignMark(marks, open, item.trade, item.mark);
    }
  }
  return marks;
}

async function readMark(trade: Quotable): Promise<ContractMark | null> {
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
    if (!contract) return null;
    const spread = checkBidAskSpread(contract.bid, contract.ask);
    const mid = spread.mid != null && spread.mid > 0 ? spread.mid : null;
    const bid = Number.isFinite(contract.bid) && contract.bid > 0 ? contract.bid : null;
    if (mid == null && bid == null) return null;
    return { mid, bid };
  } catch (err) {
    if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
    return null;
  }
}

function assignMark(
  marks: Record<string, ContractMark>,
  open: readonly Quotable[],
  trade: Quotable,
  mark: ContractMark,
): void {
  for (let i = 0; i < open.length; i++) {
    const other = open[i];
    if (other.ticker !== trade.ticker || other.putCall !== trade.putCall) continue;
    if (other.expiration !== trade.expiration) continue;
    if (Math.abs(other.strike - trade.strike) >= 0.001) continue;
    marks[other.id] = mark;
  }
}

function contractKey(trade: Quotable): string {
  return `${trade.ticker}|${trade.expiration}|${trade.strike}|${trade.putCall}`;
}
