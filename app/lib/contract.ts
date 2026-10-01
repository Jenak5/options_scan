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
}
