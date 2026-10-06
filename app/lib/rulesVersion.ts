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
 * The $875 cap, premium-only risk, unknown-is-not-a-pass, and the two-loss daily stop are unchanged.
 */
export const RULES_VERSION = 2;

export function parseRulesVersion(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 99) return null;
  return value;
}
