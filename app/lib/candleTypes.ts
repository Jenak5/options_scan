/**
 * One traded minute of an option. Minutes with no trade are omitted.
 * Nothing in here invents a bar for a gap.
 */

export interface CandleBar {
  /** Epoch milliseconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Traded volume. Present on underlying bars used by the feature backfill. */
  v?: number;
}
