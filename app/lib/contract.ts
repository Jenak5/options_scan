export type PutCall = "put" | "call";

/**
 * One option contract, independent of which broker returned it.
 * `iv` is a decimal: 0.25 means 25%.
 */
export interface OptionContract {
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  delta: number | null;
  iv: number | null;
  strike: number;
  /** Calendar date, YYYY-MM-DD. */
  expiration: string;
  putCall: PutCall;
  /** Contracts in the most recent trade, when the chain included lastSize. */
  lastSize?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  /** Milliseconds since epoch. The chain's trade time, not a time-and-sales print. */
  tradeTime?: number | null;
  quoteTime?: number | null;
}
