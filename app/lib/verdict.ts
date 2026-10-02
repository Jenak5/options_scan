import type { OptionContract, PutCall } from "@/app/lib/contract";
import { ALERT_RULES, LEVEL_RULES, type LetterGrade } from "@/app/lib/alertConfig";
import { assessEventRisk, type EarningsFact } from "@/app/lib/eventRisk";
import {
  formatLevelDistance,
  formatPrice,
  toStoredLevels,
  type KeyLevels,
  type LevelPoint,
  type StoredPriceLevels,
} from "@/app/lib/levels";
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
 * Those failures stay at D. They are never an A or a B.
 * Two losing closes in a row today turn TAKE into STOP for today.
 * A TAKE with exceptional flow, a close strike, room to the next level,
 * a known earnings date after expiration, and no macro release in the
 * contract is an A. An ordinary TAKE is a B.
 * A and B require about 2 to 6 weeks to expiration. Shorter or longer stays at C or below.
 * Missing price history keeps the grade at B.
 * An unknown earnings date also keeps the grade at B.
 * Earnings on or before expiration, and a macro release in that window, each lower the grade.
 */

export type VerdictName = "TAKE" | "WATCH" | "SKIP" | "STOP";

export interface AlertVerdict {
  verdict: VerdictName;
  verdictLabel: string;
  grade: LetterGrade;
  /** Grade before the missing-levels cap and the unknown-earnings cap. Level and event penalties are already applied. */
  uncappedGrade: LetterGrade;
  reasons: string[];
  note: string;
  levels: StoredPriceLevels | null;
  levelsNote: string | null;
  /** Earnings date, session when known, and any macro release inside the contract. */
  eventLine: string;
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
  levels: KeyLevels | null;
  printSummary?: string | null;
  /** Null when the lookup has not run. That is treated as unknown, not as safe. */
  earnings: EarningsFact | null;
  /** True only for a defined-risk spread. A single long option is not one. */
  definedRiskSpread: boolean;
  now: Date;
}

const GRADE_RANK: LetterGrade[] = ["A", "B", "C", "D"];

export function gradeFlowRow(row: FlowRow, consecutiveLosses: number | null, now: Date = new Date()): AlertVerdict {
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
    levels: row.levels,
    printSummary: row.prints?.summary ?? null,
    earnings: row.earnings ?? null,
    definedRiskSpread: false,
    now,
  });
}

export function gradeContract(input: {
  contract: OptionContract;
  underlyingPrice: number | null;
  delayed: boolean;
  now: Date;
  consecutiveLosses: number | null;
  volumeJump?: number | null;
  levels?: KeyLevels | null;
  earnings?: EarningsFact | null;
  definedRiskSpread?: boolean;
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
    levels: input.levels ?? null,
    earnings: input.earnings ?? null,
    definedRiskSpread: input.definedRiskSpread === true,
    now: input.now,
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
  const take = dteFit === "ideal" && distanceOk && signals.length >= ALERT_RULES.takeMinFlowSignals;
  if (hardSkip) {
    checklist = "SKIP";
    uncapped = "D";
  } else if (take && qualifiesForA(input, signals)) {
    checklist = "TAKE";
    uncapped = "A";
  } else if (take) {
    checklist = "TAKE";
    uncapped = "B";
  } else if (signals.length >= 1 || dteFit === "ideal" || dteFit === "short" || distanceOk) {
    checklist = "WATCH";
    uncapped = "C";
  } else {
    checklist = "WATCH";
    uncapped = "D";
  }

  const levelsRead = assessLevels(input);
  if (levelsRead.poor && !hardSkip) {
    if (checklist === "TAKE") {
      checklist = "WATCH";
      uncapped = "C";
    } else if (uncapped === "C") {
      uncapped = "D";
    }
  }

  const event = assessEventRisk({
    now: input.now,
    expiration: input.expiration,
    dte: input.dte,
    earnings: input.earnings,
    definedRiskSpread: input.definedRiskSpread,
  });
  if (event.skipForEarnings && !hardSkip) checklist = "SKIP";
  uncapped = dropGrade(uncapped, event.downgradeSteps);

  const caps: LetterGrade[] = [];
  if (!levelsRead.checked) caps.push(ALERT_RULES.maxGradeUntilLevels);
  if (event.capGrade) caps.push(event.capGrade);
  let grade = capGrade(uncapped, caps);
  if (dteFit !== "ideal") grade = noHigherThan(grade, "C");
  if (hardSkip) grade = noHigherThan(grade, "D");
  const verdict: VerdictName = dailyStop && checklist === "TAKE" ? "STOP" : checklist;
  const levelsNote = levelsRead.checked
    ? null
    : `Support and resistance were not available, so the grade stops at ${ALERT_RULES.maxGradeUntilLevels}.`;

  return {
    verdict,
    verdictLabel: verdict === "STOP" ? "STOP for today" : verdict,
    grade,
    uncappedGrade: uncapped,
    reasons: buildReasons(
      input,
      market,
      signals.length,
      verdict,
      expired,
      levelsRead.sentence,
      event.reason,
      input.printSummary ?? null,
    ),
    note: ALERT_RULES.note,
    levels: toStoredLevels(input.levels),
    levelsNote,
    eventLine: event.eventLine,
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

function qualifiesForA(input: SetupInput, signals: string[]): boolean {
  if (signals.length < ALERT_RULES.aMinFlowSignals) return false;
  if (input.volOiRatio == null || input.volOiRatio < ALERT_RULES.aGradeVolOiRatio) return false;
  if (input.notionalPremium == null || input.notionalPremium < ALERT_RULES.aGradeNotional) return false;
  return distanceIdeal(input);
}

function distanceIdeal(input: SetupInput): boolean {
  if (!distanceFits(input)) return false;
  if (input.otm) {
    return input.otmFraction != null && input.otmFraction <= ALERT_RULES.idealOtmFraction;
  }
  return true;
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

function dteClass(dte: number | null): "ideal" | "short" | "long" | "poor" {
  if (dte == null || dte < 0) return "poor";
  if (dte >= ALERT_RULES.alertDteMin && dte <= ALERT_RULES.alertDteMax) return "ideal";
  if (dte < ALERT_RULES.alertDteMin) return "short";
  return "long";
}

function dropGrade(grade: LetterGrade, steps: number): LetterGrade {
  if (steps <= 0) return grade;
  const next = GRADE_RANK.indexOf(grade) + steps;
  return GRADE_RANK[Math.min(GRADE_RANK.length - 1, next)];
}

function noHigherThan(grade: LetterGrade, ceiling: LetterGrade): LetterGrade {
  return GRADE_RANK.indexOf(grade) < GRADE_RANK.indexOf(ceiling) ? ceiling : grade;
}

function capGrade(grade: LetterGrade, caps: LetterGrade[]): LetterGrade {
  let result = grade;
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i];
    if (GRADE_RANK.indexOf(result) < GRADE_RANK.indexOf(cap)) result = cap;
  }
  return result;
}

function assessLevels(input: SetupInput): { checked: boolean; poor: boolean; sentence: string } {
  const unavailable = `Support and resistance were not available, so the grade stops at ${ALERT_RULES.maxGradeUntilLevels}.`;
  const levels = input.levels;
  if (!levels?.checked || !levels.support || !levels.resistance) {
    return { checked: false, poor: false, sentence: unavailable };
  }
  const call = input.putCall === "call";
  const reward = call ? levels.resistance : levels.support;
  const risk = call ? levels.support : levels.resistance;
  const rr = risk.distance > 0 ? reward.distance / risk.distance : Number.POSITIVE_INFINITY;
  const pinned = reward.distance <= LEVEL_RULES.pinnedFraction;
  const tight = reward.distance < LEVEL_RULES.minRoomFraction;
  const poor = pinned || tight || rr < LEVEL_RULES.minRewardToRisk;
  return {
    checked: true,
    poor,
    sentence: levelSentence(input.putCall, levels.support, levels.resistance, pinned, tight, poor),
  };
}

function levelSentence(
  putCall: PutCall,
  support: LevelPoint,
  resistance: LevelPoint,
  pinned: boolean,
  tight: boolean,
  poor: boolean,
): string {
  const side = putCall === "call" ? "call" : "put";
  const next = putCall === "call" ? resistance : support;
  const toward = putCall === "call" ? "under resistance" : "above support";
  if (poor && pinned) {
    return `Price is ${formatLevelDistance(next.distance)} ${toward} at ${formatPrice(next.price)} (${next.label}). That is tight for a ${side}, so the grade is lower.`;
  }
  if (poor && tight) {
    return `Price is only ${formatLevelDistance(next.distance)} from ${formatPrice(next.price)} (${next.label}). That is tight for a ${side}, so the grade is lower.`;
  }
  if (poor) {
    return `Resistance is ${formatLevelDistance(resistance.distance)} above and support is ${formatLevelDistance(support.distance)} below. The reward to the next level is poor for a ${side}, so the grade is lower.`;
  }
  return `Support ${formatPrice(support.price)} (${support.label}) is ${formatLevelDistance(support.distance)} below, and resistance ${formatPrice(resistance.price)} (${resistance.label}) is ${formatLevelDistance(resistance.distance)} above. There is room for a ${side}.`;
}

function buildReasons(
  input: SetupInput,
  market: QuoteChecks,
  signalCount: number,
  verdict: VerdictName,
  expired: boolean,
  levelSentenceText: string,
  eventReason: string | null,
  printSummary: string | null,
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
    tail.push(`${input.consecutiveLosses} closed losses in a row today. The daily stop is on, so this is STOP for today instead of TAKE.`);
  } else if (input.consecutiveLosses != null && !dailyStopPasses(input.consecutiveLosses) && verdict === "WATCH") {
    tail.push("The daily stop is on, so this is not a TAKE.");
  }
  tail.push(timeSentence(input));
  tail.push(flowSentence(input, signalCount));

  const unique: string[] = [];
  const merged = head.concat(tail);
  for (let i = 0; i < merged.length; i++) {
    const line = merged[i].trim();
    if (!line || unique.indexOf(line) !== -1) continue;
    unique.push(line);
  }
  const eventText = eventReason?.trim() ?? "";
  const printText = printSummary?.trim() ?? "";
  const rest = unique.filter((line) => line !== levelSentenceText && line !== eventText && line !== printText);
  const picked: string[] = [];
  if (rest.length > 0) picked.push(rest[0]);
  if (levelSentenceText.trim()) picked.push(levelSentenceText.trim());
  if (eventText) picked.push(eventText);
  if (printText) picked.push(printText);
  for (let i = 1; i < rest.length && picked.length < 4; i++) picked.push(rest[i]);
  if (picked.length < 2) picked.push(ALERT_RULES.note);
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
    return `${when}, and ${where}. That fits the ${ALERT_RULES.alertDteMin}–${ALERT_RULES.alertDteMax} day window.`;
  }
  if (input.dte === 0) {
    return `${when}, and ${where}. Same-day expiration is too short for an A or a B.`;
  }
  if (!distanceFits(input)) {
    return `${when}, and ${where}. That distance is outside the range for a TAKE.`;
  }
  if (dte === "short") {
    return `${when}, and ${where}. Under ${ALERT_RULES.alertDteMin} days is too short for an A or a B.`;
  }
  if (dte === "long") {
    return `${when}, and ${where}. Past ${ALERT_RULES.alertDteMax} days is outside the window for an A or a B.`;
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
