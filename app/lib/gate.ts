import type { OptionContract, PutCall } from "@/app/lib/contract";
import {
  DAILY_STOP_CONSECUTIVE_LOSSES,
  MAX_BID_ASK_SPREAD_OF_MID,
  MAX_LOSS_DOLLARS,
  MIN_CONTRACT_VOLUME,
  MIN_OPEN_INTEREST,
} from "@/app/lib/risk";

export const DEBIT_SPREAD_SUGGESTION =
  "One contract at the ask is above the $450 loss cap. Consider a debit spread so the most you can lose stays inside the cap.";

export type CheckStatus = "PASS" | "FAIL";
export type GateOverall = "PASS" | "NO";

export interface GateCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface GateResult {
  overall: GateOverall;
  checks: GateCheck[];
  singleContractExceedsCap: boolean;
  suggestion: string | null;
  maxLoss: number | null;
  contract: OptionContract | null;
}

export interface GateInput {
  contract: OptionContract | null;
  contracts: number;
  plannedEntry: number;
  /** Strike distance in points. Null means a single long call or put. */
  debitSpreadWidth: number | null;
  underlyingStop: string;
  timeStop: string;
  profitRule: string;
  consecutiveLosses: number;
  delayed: boolean;
}

const MAX_CONTRACTS = 100;

export function findContract(chain: OptionContract[], query: {
  expiration: string;
  strike: number;
  putCall: PutCall;
}): OptionContract | null {
  const expiration = query.expiration.slice(0, 10);
  for (let i = 0; i < chain.length; i++) {
    const contract = chain[i];
    if (contract.putCall !== query.putCall) continue;
    if (contract.expiration.slice(0, 10) !== expiration) continue;
    if (Math.abs(contract.strike - query.strike) >= 0.001) continue;
    return contract;
  }
  return null;
}

export function openInterestPasses(openInterest: number, minimum: number = MIN_OPEN_INTEREST): boolean {
  return Number.isFinite(openInterest) && openInterest >= minimum;
}

export function volumePasses(volume: number, minimum: number = MIN_CONTRACT_VOLUME): boolean {
  return Number.isFinite(volume) && volume >= minimum;
}

export interface SpreadCheck {
  pass: boolean;
  spread: number | null;
  mid: number | null;
  fraction: number | null;
  detail: string;
}

export function checkBidAskSpread(
  bid: number,
  ask: number,
  maxFraction: number = MAX_BID_ASK_SPREAD_OF_MID,
): SpreadCheck {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return { pass: false, spread: null, mid: null, fraction: null, detail: "Bid or ask is missing." };
  }
  if (bid < 0 || ask < 0) {
    return { pass: false, spread: null, mid: null, fraction: null, detail: "Bid or ask is negative." };
  }
  if (ask < bid) {
    return { pass: false, spread: ask - bid, mid: null, fraction: null, detail: "The market is crossed (ask below bid)." };
  }
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  if (!(mid > 0)) {
    return { pass: false, spread, mid, fraction: null, detail: "Midpoint is zero, so the spread cannot be priced." };
  }
  const fraction = spread / mid;
  const pct = (fraction * 100).toFixed(1);
  const capPct = (maxFraction * 100).toFixed(0);
  if (fraction <= maxFraction) {
    return { pass: true, spread, mid, fraction, detail: `Spread is ${pct}% of mid. Maximum is ${capPct}%.` };
  }
  return { pass: false, spread, mid, fraction, detail: `Spread is ${pct}% of mid. Maximum is ${capPct}%.` };
}

/** Long option: contracts × ask × 100. Returns null when the inputs cannot be priced. */
export function longOptionMaxLoss(contracts: number, ask: number): number | null {
  if (!validContractCount(contracts)) return null;
  if (!Number.isFinite(ask) || ask <= 0) return null;
  return contracts * ask * 100;
}

/**
 * Debit-spread ceiling: contracts × strike width × 100.
 * A vertical cannot be worth more than its width, so this is the most that can be lost.
 */
export function debitSpreadMaxLoss(contracts: number, spreadWidth: number): number | null {
  if (!validContractCount(contracts)) return null;
  if (!Number.isFinite(spreadWidth) || spreadWidth <= 0) return null;
  return contracts * spreadWidth * 100;
}

export function singleContractExceedsCap(ask: number, cap: number = MAX_LOSS_DOLLARS): boolean {
  if (!Number.isFinite(ask) || ask <= 0) return false;
  return ask * 100 > cap;
}

/**
 * How many long contracts fit under the loss cap at this ask.
 * Zero when one contract is already over the cap. Null when the ask cannot be priced.
 */
export function maxLongContractsWithinCap(ask: number, cap: number = MAX_LOSS_DOLLARS): number | null {
  const one = longOptionMaxLoss(1, ask);
  if (one == null) return null;
  const count = Math.floor(cap / one);
  if (!Number.isFinite(count) || count < 1) return 0;
  return Math.min(count, MAX_CONTRACTS);
}

export interface QuoteChecks {
  checks: GateCheck[];
  /** Open interest, volume, and spread. Delayed quotes are reported separately. */
  liquidityPasses: boolean;
  maxContracts: number | null;
  exceedsCap: boolean;
  suggestion: string | null;
}

/**
 * Liquidity, quote timing, and the single-contract cap.
 * Exit text and the trade-log loss count stay in evaluateGate.
 */
export function evaluateQuoteChecks(contract: OptionContract | null, delayed: boolean): QuoteChecks {
  const checks: GateCheck[] = [
    delayedCheck(delayed),
    openInterestCheck(contract),
    volumeCheck(contract),
    spreadCheck(contract),
  ];
  const liquidity = checks.filter((check) => check.id !== "delayed");
  const exceedsCap = contract != null && singleContractExceedsCap(contract.ask);
  return {
    checks,
    liquidityPasses: liquidity.every((check) => check.status === "PASS"),
    maxContracts: contract == null ? null : maxLongContractsWithinCap(contract.ask),
    exceedsCap,
    suggestion: exceedsCap ? DEBIT_SPREAD_SUGGESTION : null,
  };
}

export function dailyStopPasses(
  consecutiveLosses: number,
  limit: number = DAILY_STOP_CONSECUTIVE_LOSSES,
): boolean {
  if (!Number.isInteger(consecutiveLosses) || consecutiveLosses < 0) return false;
  return consecutiveLosses < limit;
}

export function ruleFilled(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function validContractCount(contracts: number): boolean {
  return Number.isInteger(contracts) && contracts >= 1 && contracts <= MAX_CONTRACTS;
}

export function evaluateGate(input: GateInput): GateResult {
  const contract = input.contract;
  const usingSpread = input.debitSpreadWidth != null;
  const maxLoss = contract == null
    ? null
    : usingSpread
      ? debitSpreadMaxLoss(input.contracts, input.debitSpreadWidth as number)
      : longOptionMaxLoss(input.contracts, contract.ask);
  const exceeds = contract != null && singleContractExceedsCap(contract.ask);
  const checks: GateCheck[] = [
    contractCheck(contract),
    delayedCheck(input.delayed),
    openInterestCheck(contract),
    volumeCheck(contract),
    spreadCheck(contract),
    maxLossCheck(input, contract, maxLoss, usingSpread),
    plannedEntryCheck(input.plannedEntry),
    ruleCheck("underlyingStop", "Underlying stop", input.underlyingStop, "Enter the underlying price that kills the trade."),
    ruleCheck("timeStop", "Time stop", input.timeStop, "Enter when you will get out if it has not worked."),
    ruleCheck("profitRule", "Profit-taking rule", input.profitRule, "Enter where you will take the profit."),
    dailyStopCheck(input.consecutiveLosses),
  ];
  const overall: GateOverall = checks.every((check) => check.status === "PASS") ? "PASS" : "NO";
  return {
    overall,
    checks,
    singleContractExceedsCap: exceeds,
    suggestion: exceeds ? DEBIT_SPREAD_SUGGESTION : null,
    maxLoss,
    contract,
  };
}

function contractCheck(contract: OptionContract | null): GateCheck {
  if (!contract) {
    return { id: "contract", label: "Contract", status: "FAIL", detail: "That strike is not in the live chain." };
  }
  const right = contract.putCall === "call" ? "call" : "put";
  return {
    id: "contract",
    label: "Contract",
    status: "PASS",
    detail: `${contract.expiration} ${contract.strike} ${right}.`,
  };
}

function delayedCheck(delayed: boolean): GateCheck {
  if (delayed) {
    return {
      id: "delayed",
      label: "Real-time quotes",
      status: "FAIL",
      detail: "Schwab marked this chain delayed. Real-time data is required.",
    };
  }
  return { id: "delayed", label: "Real-time quotes", status: "PASS", detail: "Quotes are not marked delayed." };
}

function openInterestCheck(contract: OptionContract | null): GateCheck {
  if (!contract || !openInterestPasses(contract.openInterest)) {
    const seen = contract && Number.isFinite(contract.openInterest) ? String(contract.openInterest) : "missing";
    return {
      id: "openInterest",
      label: "Open interest",
      status: "FAIL",
      detail: `Open interest ${seen}. Minimum is ${MIN_OPEN_INTEREST}.`,
    };
  }
  return {
    id: "openInterest",
    label: "Open interest",
    status: "PASS",
    detail: `Open interest ${contract.openInterest}. Minimum is ${MIN_OPEN_INTEREST}.`,
  };
}

function volumeCheck(contract: OptionContract | null): GateCheck {
  if (!contract || !volumePasses(contract.volume)) {
    const seen = contract && Number.isFinite(contract.volume) ? String(contract.volume) : "missing";
    return {
      id: "volume",
      label: "Volume",
      status: "FAIL",
      detail: `Volume ${seen}. Minimum is ${MIN_CONTRACT_VOLUME} contracts today.`,
    };
  }
  return {
    id: "volume",
    label: "Volume",
    status: "PASS",
    detail: `Volume ${contract.volume}. Minimum is ${MIN_CONTRACT_VOLUME} contracts today.`,
  };
}

function spreadCheck(contract: OptionContract | null): GateCheck {
  if (!contract) {
    return { id: "spread", label: "Bid-ask spread", status: "FAIL", detail: "No quote to measure." };
  }
  const result = checkBidAskSpread(contract.bid, contract.ask);
  return {
    id: "spread",
    label: "Bid-ask spread",
    status: result.pass ? "PASS" : "FAIL",
    detail: result.detail,
  };
}

function maxLossCheck(
  input: GateInput,
  contract: OptionContract | null,
  maxLoss: number | null,
  usingSpread: boolean,
): GateCheck {
  if (!validContractCount(input.contracts)) {
    return {
      id: "maxLoss",
      label: "Max loss",
      status: "FAIL",
      detail: `Enter a whole number of contracts from 1 to ${MAX_CONTRACTS}.`,
    };
  }
  if (!contract) {
    return { id: "maxLoss", label: "Max loss", status: "FAIL", detail: "No contract to price." };
  }
  if (maxLoss == null) {
    const why = usingSpread
      ? "Enter a debit-spread width greater than zero."
      : "The ask is missing, so the long option cannot be priced.";
    return { id: "maxLoss", label: "Max loss", status: "FAIL", detail: why };
  }
  const how = usingSpread
    ? `${input.contracts} × ${input.debitSpreadWidth} point width × 100`
    : `${input.contracts} × ${contract.ask} ask × 100`;
  const detail = `Max loss ${money(maxLoss)} (${how}). Cap is ${money(MAX_LOSS_DOLLARS)}.`;
  if (maxLoss <= MAX_LOSS_DOLLARS) {
    return { id: "maxLoss", label: "Max loss", status: "PASS", detail };
  }
  return { id: "maxLoss", label: "Max loss", status: "FAIL", detail };
}

function plannedEntryCheck(plannedEntry: number): GateCheck {
  if (!Number.isFinite(plannedEntry) || plannedEntry <= 0) {
    return {
      id: "plannedEntry",
      label: "Planned entry",
      status: "FAIL",
      detail: "Enter the price you plan to pay.",
    };
  }
  return {
    id: "plannedEntry",
    label: "Planned entry",
    status: "PASS",
    detail: `Planned entry ${money(plannedEntry)}.`,
  };
}

function ruleCheck(id: string, label: string, value: string, missing: string): GateCheck {
  if (!ruleFilled(value)) {
    return { id, label, status: "FAIL", detail: missing };
  }
  return { id, label, status: "PASS", detail: value.trim() };
}

function dailyStopCheck(consecutiveLosses: number): GateCheck {
  if (!Number.isInteger(consecutiveLosses) || consecutiveLosses < 0) {
    return {
      id: "dailyStop",
      label: "Daily stop",
      status: "FAIL",
      detail: "The daily stop needs a whole-number loss count from the trade log.",
    };
  }
  if (!dailyStopPasses(consecutiveLosses)) {
    return {
      id: "dailyStop",
      label: "Daily stop",
      status: "FAIL",
      detail: `${consecutiveLosses} closed losses in a row today. The daily stop is ${DAILY_STOP_CONSECUTIVE_LOSSES}.`,
    };
  }
  return {
    id: "dailyStop",
    label: "Daily stop",
    status: "PASS",
    detail: `${consecutiveLosses} closed losses in a row today. The daily stop is ${DAILY_STOP_CONSECUTIVE_LOSSES}.`,
  };
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}
