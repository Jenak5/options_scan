/**
 * Account risk for this scanner.
 *
 * The old Kelly Lab assumed a $5,000 account and a 55% win rate.
 * Those assumptions are retired. Sizing is this cap, enforced by the gate.
 */

/** Personal account size. */
export const ACCOUNT_SIZE_DOLLARS = 3_000;

/**
 * Hard loss cap for one trade: $875.
 * The Gate, the checklist, alert sizing, and the paper trade log all read this.
 */
export const MAX_LOSS_DOLLARS = 875;

/** Minimum open interest at the chosen strike. */
export const MIN_OPEN_INTEREST = 500;

/** Minimum contracts traded today at the chosen strike. */
export const MIN_CONTRACT_VOLUME = 100;

/** Maximum bid/ask spread as a fraction of the midpoint. */
export const MAX_BID_ASK_SPREAD_OF_MID = 0.05;

/**
 * Daily stop. Two losing closes in a row on the Chicago trading day and the
 * gate is NO for the rest of that day. The count comes from the trade log.
 * It is not a broker fill, and there is no weekly loss limit.
 */
export const DAILY_STOP_CONSECUTIVE_LOSSES = 2;

/** Warn when the Schwab refresh token has under this many days left. */
export const REFRESH_TOKEN_WARNING_DAYS = 2;
