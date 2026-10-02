import { TRADE_RULES } from "@/app/lib/alertConfig";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";

/**
 * Exit prices for a suggested long option or debit spread.
 * Percents are of the debit paid. The stop dollar loss is never above the
 * account cap. This does not place an order.
 */

export type ExitStructure = "single" | "debit-spread";

export interface ExitPlan {
  premium: number;
  contracts: number;
  structure: ExitStructure;
  profitPrice: number;
  takeContracts: number;
  stopPrice: number;
  stopDollars: number;
  stopTightened: boolean;
  riskDollars: number;
  riskBreachesCap: boolean;
  lines: string[];
  note: string;
}

export function planExits(input: {
  premium: number;
  contracts: number;
  structure?: ExitStructure;
}): ExitPlan | null {
  const premium = input.premium;
  const contracts = input.contracts;
  if (!Number.isFinite(premium) || premium <= 0) return null;
  if (!Number.isInteger(contracts) || contracts < 1 || contracts > TRADE_RULES.maxContracts) return null;

  const structure: ExitStructure = input.structure === "debit-spread" ? "debit-spread" : "single";
  const riskDollars = premium * contracts * 100;
  const rawStopDollars = TRADE_RULES.stopLossFraction * riskDollars;
  const stopTightened = rawStopDollars > MAX_LOSS_DOLLARS + 1e-6;
  const stopDollars = stopTightened ? MAX_LOSS_DOLLARS : rawStopDollars;
  const stopFraction = riskDollars > 0 ? stopDollars / riskDollars : TRADE_RULES.stopLossFraction;
  const stopPrice = premium * (1 - stopFraction);
  const profitPrice = premium * (1 + TRADE_RULES.profitTargetFraction);
  const half = Math.floor(contracts * TRADE_RULES.scaleOutFraction);
  const takeContracts = half >= 1 ? half : contracts;
  const riskBreachesCap = riskDollars > MAX_LOSS_DOLLARS + 1e-6;

  const lines: string[] = [
    profitLine(premium, profitPrice, contracts, takeContracts),
    stopLine(premium, stopPrice, stopDollars, rawStopDollars, stopTightened),
  ];
  if (riskBreachesCap) {
    lines.push(`Risk used is ${money(riskDollars)}, over the ${money(MAX_LOSS_DOLLARS)} cap.`);
  }
  lines.push(defaultTimeStop());
  if (structure === "debit-spread") {
    lines.push("Debit spread: these exits are on the net debit, in the same percents as a single option.");
  }

  return {
    premium,
    contracts,
    structure,
    profitPrice,
    takeContracts,
    stopPrice,
    stopDollars,
    stopTightened,
    riskDollars,
    riskBreachesCap,
    lines,
    note: TRADE_RULES.note,
  };
}

/** Suggested size on an alert: the contracts that fit under the cap, or one. */
export function planExitsForAsk(ask: number, maxContracts: number | null | undefined): ExitPlan | null {
  const contracts = maxContracts != null && maxContracts > 0 ? maxContracts : 1;
  return planExits({ premium: ask, contracts, structure: "single" });
}

export function defaultProfitRule(): string {
  const pct = percent(TRADE_RULES.profitTargetFraction);
  return `Take half off at +${pct} of the debit.`;
}

export function defaultTimeStop(): string {
  return `Time stop: get out if the trade is still flat after ${flatAfterLabel()}. ${TRADE_RULES.lastWeekExitReminder}`;
}

/** Shown on an open paper trade once the multi-day flat rule is due. */
export function openFlatTimeStopText(): string {
  return `Time stop: this trade is still flat after ${flatAfterLabel()}.`;
}

function flatAfterLabel(): string {
  const days = TRADE_RULES.flatAfterTradingDays;
  const word = days === 1 ? "trading day" : "trading days";
  return `${days} ${word}`;
}

export function exitDefaultsSummary(): string {
  const profit = percent(TRADE_RULES.profitTargetFraction);
  const stop = percent(TRADE_RULES.stopLossFraction);
  return `Starting defaults, not a broker order. Take half off at +${profit} of the debit. Stop at -${stop} of the debit, and never more than ${money(MAX_LOSS_DOLLARS)}. ${defaultTimeStop()} A debit spread uses those same percents on the net debit. ${TRADE_RULES.note}`;
}

function profitLine(premium: number, profitPrice: number, contracts: number, takeContracts: number): string {
  const target = `+${percent(TRADE_RULES.profitTargetFraction)} of the ${money(premium)} debit`;
  if (takeContracts >= contracts) {
    return `Take the position off at ${money(profitPrice)} (${target}). One contract is the whole trade, so half off is a full exit.`;
  }
  const word = takeContracts === 1 ? "contract" : "contracts";
  return `Take half off at ${money(profitPrice)} (${target}). That is ${takeContracts} ${word} of ${contracts}.`;
}

function stopLine(
  premium: number,
  stopPrice: number,
  stopDollars: number,
  rawStopDollars: number,
  tightened: boolean,
): string {
  if (tightened) {
    return `A -${percent(TRADE_RULES.stopLossFraction)} stop would lose about ${money(rawStopDollars)}, which is over the ${money(MAX_LOSS_DOLLARS)} cap, so the stop is ${money(stopPrice)} (about ${money(stopDollars)}).`;
  }
  return `Stop at ${money(stopPrice)} (-${percent(TRADE_RULES.stopLossFraction)} of the ${money(premium)} debit), about ${money(stopDollars)}. That loss is inside the ${money(MAX_LOSS_DOLLARS)} cap.`;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
