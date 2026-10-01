import {
  contractsNeedingQuotes,
  loadAlertBook,
  saveFollowUps,
} from "@/app/lib/alertStore";
import type { QuoteObservation, StoredAlert } from "@/app/lib/alertBook";
import { checkBidAskSpread, findContract } from "@/app/lib/gate";
import { getOptionChain, SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";

/**
 * Re-quotes open alerts from the Schwab chains endpoint.
 * Midpoint only. No orders. A missing quote stays on the record as no quote.
 */

export async function quoteAlertWithSchwab(alert: StoredAlert): Promise<QuoteObservation> {
  const chain = await getOptionChain({
    symbol: alert.ticker,
    contractType: alert.putCall === "call" ? "CALL" : "PUT",
    strike: alert.strike,
    fromDate: alert.expiration,
    toDate: alert.expiration,
  });
  const contract = findContract(chain.contracts, {
    expiration: alert.expiration,
    strike: alert.strike,
    putCall: alert.putCall,
  });
  if (!contract) return { mid: null, underlying: chain.underlyingPrice };
  const spread = checkBidAskSpread(contract.bid, contract.ask);
  return { mid: spread.mid, underlying: chain.underlyingPrice };
}

export async function runAlertFollowUps(
  now: Date,
  quote: (alert: StoredAlert) => Promise<QuoteObservation> = quoteAlertWithSchwab,
): Promise<{ updated: number; quoted: number }> {
  const book = await loadAlertBook();
  const needed = contractsNeedingQuotes(book, now);
  const quotes = new Map<string, QuoteObservation | "error">();
  let quoted = 0;
  for (let i = 0; i < needed.length; i++) {
    const alert = needed[i];
    try {
      quotes.set(alert.contractKey, await quote(alert));
      quoted += 1;
    } catch (err) {
      if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) throw err;
      console.error("Alert follow-up quote failed");
      quotes.set(alert.contractKey, "error");
    }
  }
  const updated = await saveFollowUps(now, quotes);
  return { updated, quoted };
}
