/**
 * Account risk for this scanner.
 *
 * The old Kelly Lab assumed a $5,000 account and a 55% win rate.
 * Those assumptions are retired. Sizing is this cap, enforced by the gate.
 */

/** Personal account size. */
export const ACCOUNT_SIZE_DOLLARS = 3_000;

/** Maximum fraction of the account risked on one trade. */
export const MAX_RISK_FRACTION = 0.15;

/** Hard loss cap. 15% of $3,000. */
export const MAX_LOSS_DOLLARS = ACCOUNT_SIZE_DOLLARS * MAX_RISK_FRACTION;

/** Minimum open interest at the chosen strike. */
export const MIN_OPEN_INTEREST = 500;

/** Minimum contracts traded today at the chosen strike. */
export const MIN_CONTRACT_VOLUME = 100;

/** Maximum bid/ask spread as a fraction of the midpoint. */
export const MAX_BID_ASK_SPREAD_OF_MID = 0.05;

/**
 * Daily stop. Two losses in a row and the gate is NO for the day.
 * The count is typed into the Gate and kept for that Chicago session.
 * It is not a broker fill log.
 */
export const DAILY_STOP_CONSECUTIVE_LOSSES = 2;

/** Warn when the Schwab refresh token has under this many days left. */
export const REFRESH_TOKEN_WARNING_DAYS = 2;
