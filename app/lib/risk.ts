/**
 * Account risk for this scanner.
 *
 * The old Kelly Lab assumed a $5,000 account and a 55% win rate.
 * Those assumptions are retired. Sizing is this cap, enforced by the gate.
 */

/** Personal account size. */
export const ACCOUNT_SIZE_DOLLARS = 3_000;

/**
 * Hard loss cap for one trade. The code uses $875.
 * The Gate, the checklist, alert sizing, and the paper trade log all read
 * MAX_LOSS_DOLLARS, so this is the only place to change the cap.
 * Set MAX_LOSS_DOLLARS in the environment to override it. An empty or
 * invalid value keeps $875.
 */
export const DEFAULT_MAX_LOSS_DOLLARS = 875;

export function readMaxLossDollars(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_MAX_LOSS_DOLLARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000) return DEFAULT_MAX_LOSS_DOLLARS;
  return parsed;
}

export const MAX_LOSS_DOLLARS = readMaxLossDollars(process.env.MAX_LOSS_DOLLARS);

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
