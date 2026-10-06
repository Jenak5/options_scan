/**
 * Checklist version stored on new alerts, shadows, and paper trades.
 *
 * Version 1 was the checklist before this round. Those rows were not stamped.
 * Learning mode shows them as "Not stamped" so they can be compared with later versions.
 *
 * Version 2 changes who can be an A or a B:
 * - no A or B in the first 15 minutes after the Chicago open
 * - a cheap contract also has to pass a dollar spread cap
 * - a likely spread or hedge cannot be an A
 * - a trade that fights both the ticker trend and SPY and QQQ cannot be an A
 *
 * Version 3: an A also requires the likely side to be buyers. That means the last
 * price is at or near the ask. It is an estimate from the last price, not a trade print.
 * The next-day open-interest check is saved on the alert after the fact. It does not
 * change the grade, because the chain that can answer it does not exist yet.
 *
 * The $875 cap, premium-only risk, unknown-is-not-a-pass, and the two-loss daily stop are unchanged.
 */
export const RULES_VERSION = 3;

export function parseRulesVersion(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 99) return null;
  return value;
}
