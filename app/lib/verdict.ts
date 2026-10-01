import type { OptionContract, PutCall } from "@/app/lib/contract";
import { ALERT_RULES, type LetterGrade } from "@/app/lib/alertConfig";
import {
  calendarDaysBetween,
  estimateSide,
  newYorkDate,
  notionalPremium,
  otmDistance,
  volumeOiRatio,
  type EstimatedSideLabel,
  type FlowRow,
} from "@/app/lib/flow";
import {
  DEBIT_SPREAD_SUGGESTION,
  checkBidAskSpread,
  dailyStopPasses,
  evaluateQuoteChecks,
  longOptionMaxLoss,
  type QuoteChecks,
} from "@/app/lib/gate";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";

/**
 * Alert-time checklist. TAKE, WATCH, or SKIP, plus a letter grade.
 * Liquidity failures and a single contract over the loss cap are SKIP.
 * Two losses in a row, when that count is known, turns TAKE into STOP for today.
 * Grades stop at B until support and resistance exist.
 */

export type VerdictName = "TAKE" | "WATCH" | "SKIP" | "STOP";

export interface AlertVerdict {
  verdict: VerdictName;
  verdictLabel: string;
  grade: LetterGrade;
  /** Grade before the levels cap. A is withheld while levels are unchecked. */
  uncappedGrade: LetterGrade;
  reasons: string[];
  note: string;
  levelsNote: string | null;
  maxContracts: number | null;
  singleContractExceedsCap: boolean;
  suggestion: string | null;
  liquidityPasses: boolean;
  dailyStop: boolean;
}

export interface SetupInput {
  bid: number;
  ask: number;
  volume: number;
  openInterest: number;
  mid: number | null;
  notionalPremium: number | null;
  volOiRatio: number | null;
  volumeJump: number | null;
  side: EstimatedSideLabel;
  otmFraction: number | null;
  otm: boolean | null;
  dte: number | null;
  delayed: boolean;
  strike: number;
  expiration: string;
  putCall: PutCall;
  underlyingPrice: number | null;
  consecutiveLosses: number | null;
}

const GRADE_RANK: LetterGrade[] = ["A", "B", "C", "D"];

export function gradeFlowRow(row: FlowRow, consecutiveLosses: number | null): AlertVerdict {
  return gradeSetup({
    bid: row.bid,
    ask: row.ask,
    volume: row.volume,
    openInterest: row.openInterest,
    mid: row.mid,
    notionalPremium: row.notionalPremium,
    volOiRatio: row.volOiRatio,
    volumeJump: row.volumeJump,
    side: row.side,
    otmFraction: row.otmFraction,
    otm: row.otm,
    dte: row.dte,
    delayed: row.delayed,
    strike: row.strike,
    expiration: row.expiration,
    putCall: row.putCall,
    underlyingPrice: row.underlyingPrice,
    consecutiveLosses: knownLosses(consecutiveLosses),
  });
}

export function gradeContract(input: {
  contract: OptionContract;
  underlyingPrice: number | null;
  delayed: boolean;
  now: Date;
  consecutiveLosses: number | null;
  volumeJump?: number | null;
}): AlertVerdict {
  const contract = input.contract;
  const spread = checkBidAskSpread(contract.bid, contract.ask);
  const side = estimateSide(contract.bid, contract.ask, contract.last);
  const distance = otmDistance(contract.putCall, contract.strike, input.underlyingPrice);
  const today = newYorkDate(input.now);
  return gradeSetup({
    bid: contract.bid,
    ask: contract.ask,
    volume: contract.volume,
    openInterest: contract.openInterest,
    mid: spread.mid,
    notionalPremium: notionalPremium(contract.volume, spread.mid),
    volOiRatio: volumeOiRatio(contract.volume, contract.openInterest),
    volumeJump: input.volumeJump ?? null,
    side: side.label,
    otmFraction: distance.fraction,
    otm: distance.otm,
    dte: calendarDaysBetween(today, contract.expiration),
    delayed: input.delayed,
    strike: contract.strike,
    expiration: contract.expiration,
    putCall: contract.putCall,
    underlyingPrice: input.underlyingPrice,
    consecutiveLosses: knownLosses(input.consecutiveLosses),
  });
}

export function gradeSetup(input: SetupInput): AlertVerdict {
  const market = evaluateQuoteChecks(toContract(input), input.delayed);
  const expired = input.dte != null && input.dte < 0;
  const hardSkip = expired
    || input.delayed
    || !market.liquidityPasses
    || market.exceedsCap
    || market.maxContracts == null
    || market.maxContracts < 1;

  const signals = flowSignals(input);
  const distanceOk = distanceFits(input);
  const dteFit = dteClass(input.dte);
  const dailyStop = input.consecutiveLosses != null && !dailyStopPasses(input.consecutiveLosses);

  let checklist: "TAKE" | "WATCH" | "SKIP" = "WATCH";
  let uncapped: LetterGrade = "C";
  if (hardSkip) {
    checklist = "SKIP";
    uncapped = "D";
  } else if (dteFit === "ideal" && distanceOk && signals.length >= ALERT_RULES.takeMinFlowSignals) {
    checklist = "TAKE";
    uncapped = "A";
  } else if (signals.length >= 1 || dteFit !== "poor" || distanceOk) {
    checklist = "WATCH";
    uncapped = "C";
  } else {
    checklist = "WATCH";
    uncapped = "D";
  }

  const grade = capGrade(uncapped);
  const verdict: VerdictName = dailyStop && checklist === "TAKE" ? "STOP" : checklist;
  const levelsNote = ALERT_RULES.levelsChecked
    ? null
    : `Support and resistance are not checked yet, so the grade stops at ${ALERT_RULES.maxGradeUntilLevels}.`;

  return {
    verdict,
    verdictLabel: verdict === "STOP" ? "STOP for today" : verdict,
    grade,
    uncappedGrade: uncapped,
    reasons: buildReasons(input, market, signals.length, verdict, expired),
    note: ALERT_RULES.note,
    levelsNote,
    maxContracts: market.maxContracts,
    singleContractExceedsCap: market.exceedsCap,
    suggestion: market.suggestion,
    liquidityPasses: market.liquidityPasses,
    dailyStop,
  };
}

export function knownLosses(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function toContract(input: SetupInput): OptionContract {
  return {
    bid: input.bid,
    ask: input.ask,
    last: input.mid ?? Number.NaN,
    volume: input.volume,
    openInterest: input.openInterest,
    delta: null,
    iv: null,
    strike: input.strike,
    expiration: input.expiration,
    putCall: input.putCall,
  };
}

function flowSignals(input: SetupInput): string[] {
  const hit: string[] = [];
  if (input.volOiRatio != null && input.volOiRatio >= ALERT_RULES.strongVolOiRatio) hit.push("volOi");
  if (input.notionalPremium != null && input.notionalPremium >= ALERT_RULES.strongNotional) hit.push("notional");
  if (input.side === "estimated at ask") hit.push("side");
  if (input.volumeJump != null && input.volumeJump >= ALERT_RULES.strongVolumeJump) hit.push("jump");
  return hit;
}

function distanceFits(input: SetupInput): boolean {
  if (input.otm == null) return false;
  if (input.otm) {
    return input.otmFraction != null && input.otmFraction <= ALERT_RULES.acceptableOtmFraction;
  }
  const itm = itmFraction(input);
  return itm != null && itm <= ALERT_RULES.maxItmFraction;
}

function itmFraction(input: SetupInput): number | null {
  if (input.otm == null || input.underlyingPrice == null || !(input.underlyingPrice > 0)) return null;
  if (input.otm) return 0;
  if (!Number.isFinite(input.strike)) return null;
  return Math.abs(input.strike - input.underlyingPrice) / input.underlyingPrice;
}

function dteClass(dte: number | null): "ideal" | "acceptable" | "poor" {
  if (dte == null || dte < 0) return "poor";
  if (dte >= ALERT_RULES.idealDteMin && dte <= ALERT_RULES.idealDteMax) return "ideal";
  if (dte <= ALERT_RULES.acceptableDteMax) return "acceptable";
  return "poor";
}

function capGrade(grade: LetterGrade): LetterGrade {
  if (ALERT_RULES.levelsChecked) return grade;
  const cap = ALERT_RULES.maxGradeUntilLevels;
  return GRADE_RANK.indexOf(grade) < GRADE_RANK.indexOf(cap) ? cap : grade;
}

function buildReasons(
  input: SetupInput,
  market: QuoteChecks,
  signalCount: number,
  verdict: VerdictName,
  expired: boolean,
): string[] {
  const head: string[] = [];
  if (expired) head.push("This expiration has already passed.");
  const failed = market.checks.filter((check) => check.status === "FAIL");
  if (!expired && failed.length === 0) {
    head.push("Open interest, volume, and the bid-ask spread pass the Gate.");
  } else {
    for (let i = 0; i < failed.length; i++) head.push(failed[i].detail);
  }

  const tail: string[] = [];
  if (market.exceedsCap) tail.push(capSentence(input.ask));
  else tail.push(sizingSentence(market.maxContracts, input.ask));
  if (verdict === "STOP" && input.consecutiveLosses != null) {
    tail.push(`${input.consecutiveLosses} losses in a row. The daily stop is on, so this is STOP for today instead of TAKE.`);
  } else if (input.consecutiveLosses != null && !dailyStopPasses(input.consecutiveLosses) && verdict === "WATCH") {
    tail.push("The daily stop is on, so this is not a TAKE.");
  }
  tail.push(flowSentence(input, signalCount));
  tail.push(timeSentence(input));

  const unique: string[] = [];
  const merged = head.concat(tail);
  for (let i = 0; i < merged.length; i++) {
    const line = merged[i].trim();
    if (!line || unique.indexOf(line) !== -1) continue;
    unique.push(line);
  }
  const picked = unique.slice(0, 4);
  if (picked.length >= 2) return picked;
  picked.push(ALERT_RULES.note);
  return picked.slice(0, 4);
}

function capSentence(ask: number): string {
  const one = longOptionMaxLoss(1, ask);
  const cost = one == null ? "" : ` One contract would cost about $${one.toFixed(0)}.`;
  return `${DEBIT_SPREAD_SUGGESTION}${cost}`;
}

function sizingSentence(maxContracts: number | null, ask: number): string {
  const one = longOptionMaxLoss(1, ask);
  if (maxContracts == null || one == null) {
    return `The ask is missing, so this cannot be sized under the $${MAX_LOSS_DOLLARS} cap.`;
  }
  const word = maxContracts === 1 ? "contract fits" : "contracts fit";
  return `At the ask, ${maxContracts} ${word} under the $${MAX_LOSS_DOLLARS} cap. One contract is about $${one.toFixed(0)}.`;
}

function flowSentence(input: SetupInput, signalCount: number): string {
  const ratio = input.volOiRatio != null
    ? `volume is ${input.volOiRatio.toFixed(2)}× open interest`
    : "volume versus open interest is unknown";
  const notional = input.notionalPremium != null
    ? `notional is about ${compactDollars(input.notionalPremium)}`
    : "notional cannot be priced";
  let sentence = `${capitalize(ratio)}, ${notional}, and the last price is ${input.side}.`;
  if (input.volumeJump != null && input.volumeJump >= ALERT_RULES.strongVolumeJump) {
    sentence += ` Volume is up ${Math.round(input.volumeJump).toLocaleString("en-US")} since the last scan.`;
  } else if (input.volumeJump == null) {
    sentence += " No same-day volume jump is on file yet.";
  } else {
    sentence += " Volume has not jumped since the last scan.";
  }
  if (signalCount < ALERT_RULES.takeMinFlowSignals) {
    sentence += ` That is ${signalCount} of ${ALERT_RULES.takeMinFlowSignals} flow signals for a TAKE.`;
  }
  return sentence;
}

function timeSentence(input: SetupInput): string {
  const dte = dteClass(input.dte);
  const when = input.dte == null
    ? "Days to expiration are unknown"
    : input.dte === 0
      ? "This expires today"
      : `${input.dte} days to expiration`;
  const where = distanceText(input);
  if (input.otm == null) {
    return `${when}, and distance from the money is unknown.`;
  }
  if (dte === "ideal" && distanceFits(input)) {
    return `${when}, and ${where}. That fits a short hold.`;
  }
  if (input.dte === 0) {
    return `${when}, and ${where}. Same-day expiration is too short to call it a TAKE.`;
  }
  if (!distanceFits(input)) {
    return `${when}, and ${where}. That distance is outside the range for a TAKE.`;
  }
  if (dte === "acceptable") {
    return `${when}, and ${where}. That is outside the ${ALERT_RULES.idealDteMin}–${ALERT_RULES.idealDteMax} day window for a TAKE.`;
  }
  if (dte === "poor" && input.dte != null && input.dte > ALERT_RULES.acceptableDteMax) {
    return `${when}, and ${where}. That is longer than a quick hold.`;
  }
  return `${when}, and ${where}.`;
}

function distanceText(input: SetupInput): string {
  if (input.otm == null || input.otmFraction == null) return "distance from the money is unknown";
  if (!input.otm) {
    const itm = itmFraction(input);
    if (itm == null) return "distance from the money is unknown";
    if (itm === 0) return "it is at the money";
    return `it is about ${percent(itm)} in the money`;
  }
  return `it is about ${percent(input.otmFraction)} out of the money`;
}

function percent(fraction: number): string {
  const value = fraction * 100;
  const text = Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
  return `${text}%`;
}

function compactDollars(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
