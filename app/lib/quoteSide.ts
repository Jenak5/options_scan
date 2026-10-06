import { estimateSide, type EstimatedSideLabel } from "@/app/lib/flow";

/**
 * Quote display and the likely-side estimate.
 * Every number comes from the chain already in hand. A missing quote stays blank.
 * Likely side compares the last price with the bid and ask. It is not a trade print.
 */

export type LikelySide = "buyers" | "sellers" | "unclear" | "unknown";

export const LIKELY_SIDE_NOTE =
  "Estimate from the last price versus the bid and ask. Not a trade print and not a sweep.";

/**
 * Open interest has to rise by at least this share of the volume saved with the alert.
 * Half is the line for "a large share." A smaller rise did not stick as new positions.
 */
export const OPENING_VOLUME_SHARE = 0.5;

export type OpeningStatus = "pending" | "opening" | "closing" | "missing";

export interface OpeningCheck {
  status: OpeningStatus;
  /** Open interest on the chain when the alert was saved. Null when that number was missing. */
  priorOpenInterest: number | null;
  /** Volume on the chain when the alert was saved. The share is measured against this. */
  volume: number | null;
  /** Open interest on the next trading day's chain. Null until that chain is read. */
  nextOpenInterest: number | null;
  /** Chicago date the chain was read, or the date the check was closed without one. */
  checkedOn: string | null;
}

export const OPENING_NOTE =
  "Compared with the open interest and volume saved when the alert was sent. A rise of at least half that volume is Opening confirmed. Flat, down, or a smaller rise is Likely closing. This uses the next trading day's chain, already fetched for the scan. It is not a trade print, and it does not change the grade.";

export interface QuoteFacts {
  bid: number | null;
  ask: number | null;
  last: number | null;
  mid: number | null;
  spread: number | null;
  spreadFraction: number | null;
  likelySide: LikelySide;
  likelySideLabel: string;
  note: string;
}

export function likelySideFromEstimate(label: EstimatedSideLabel | null | undefined): LikelySide | null {
  if (label === "estimated at ask") return "buyers";
  if (label === "estimated at bid") return "sellers";
  if (label === "estimated mid") return "unclear";
  if (label === "estimated unknown") return "unknown";
  return null;
}

export function likelySideText(side: LikelySide | null | undefined): string {
  if (side === "buyers") return "Buyers paying up";
  if (side === "sellers") return "Sellers";
  if (side === "unclear") return "Unclear";
  if (side === "unknown") return "Unknown";
  return "Unknown";
}

export function quoteFacts(input: {
  bid: number | null | undefined;
  ask: number | null | undefined;
  last: number | null | undefined;
}): QuoteFacts {
  const bid = finitePrice(input.bid);
  const ask = finitePrice(input.ask);
  const last = finitePrice(input.last);
  const spread = bid != null && ask != null && ask >= bid ? ask - bid : null;
  const mid = bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : null;
  const spreadFraction = spread != null && mid != null && mid > 0 ? spread / mid : null;
  const estimated = bid != null && ask != null && last != null
    ? estimateSide(bid, ask, last)
    : null;
  const likelySide = estimated ? likelySideFromEstimate(estimated.label) ?? "unknown" : "unknown";
  return {
    bid,
    ask,
    last,
    mid,
    spread,
    spreadFraction,
    likelySide,
    likelySideLabel: likelySideText(likelySide),
    note: LIKELY_SIDE_NOTE,
  };
}

export function openingLabel(status: OpeningStatus | null | undefined): string {
  if (status === "opening") return "Opening confirmed";
  if (status === "closing") return "Likely closing";
  if (status === "missing") return "Not in the next day's chain";
  return "Pending (checks tomorrow)";
}

export function classifyOpening(input: {
  priorOpenInterest: number | null;
  volume: number | null;
  nextOpenInterest: number;
}): "opening" | "closing" | null {
  if (!usableCount(input.priorOpenInterest) || !usableCount(input.nextOpenInterest)) return null;
  const change = (input.nextOpenInterest as number) - (input.priorOpenInterest as number);
  if (change <= 0) return "closing";
  if (!usableCount(input.volume) || !(input.volume as number > 0)) return null;
  if (change + 1e-9 >= (input.volume as number) * OPENING_VOLUME_SHARE) return "opening";
  return "closing";
}

export function pendingOpeningCheck(input: { openInterest: number; volume: number }): OpeningCheck {
  return {
    status: "pending",
    priorOpenInterest: usableCount(input.openInterest) ? input.openInterest : null,
    volume: usableCount(input.volume) ? input.volume : null,
    nextOpenInterest: null,
    checkedOn: null,
  };
}

export function parseOpeningCheck(value: unknown): OpeningCheck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<OpeningCheck>;
  if (row.status !== "pending" && row.status !== "opening" && row.status !== "closing" && row.status !== "missing") {
    return null;
  }
  const prior = countOrNull(row.priorOpenInterest);
  const volume = countOrNull(row.volume);
  const next = countOrNull(row.nextOpenInterest);
  const checkedOn = typeof row.checkedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.checkedOn)
    ? row.checkedOn
    : null;
  if ((row.status === "opening" || row.status === "closing") && next == null) return null;
  if (row.status === "pending") {
    return { status: "pending", priorOpenInterest: prior, volume, nextOpenInterest: null, checkedOn: null };
  }
  return { status: row.status, priorOpenInterest: prior, volume, nextOpenInterest: next, checkedOn };
}

export function parseOpeningStatus(value: unknown): OpeningStatus | null {
  if (value === "pending" || value === "opening" || value === "closing" || value === "missing") return value;
  return null;
}

export function formatOptionPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  return `$${value.toFixed(2)}`;
}

export function formatSpread(spread: number | null | undefined, fraction: number | null | undefined): string {
  if (spread == null || !Number.isFinite(spread) || spread < 0) return "—";
  const dollars = `$${spread.toFixed(2)}`;
  if (fraction == null || !Number.isFinite(fraction) || fraction < 0) return dollars;
  return `${dollars} · ${(fraction * 100).toFixed(1)}% of mid`;
}

export function buyerCapSentence(side: EstimatedSideLabel): string {
  if (side === "estimated at bid") {
    return "The last price is at or near the bid, so the estimate is sellers, not buyers paying up. An A needs buyers. This is an estimate from the last price, not a trade print.";
  }
  if (side === "estimated mid") {
    return "The last price is between the bid and the ask, so the side is unclear. An A needs buyers paying up. This is an estimate from the last price, not a trade print.";
  }
  return "The last price cannot be compared with the bid and ask, so buyers paying up is unknown. An A needs that estimate. Missing data is not a pass.";
}

function finitePrice(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return value;
}

function usableCount(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
}

function countOrNull(value: unknown): number | null {
  if (!usableCount(value as number)) return null;
  return value as number;
}
