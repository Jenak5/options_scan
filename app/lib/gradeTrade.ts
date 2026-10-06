import { emptyFeatures, type AlertFeatureSnapshot } from "@/app/lib/alertFeatures";
import {
  ALERT_RULES,
  formatAskPrice,
  formatContractCost,
  formatFlowPremium,
  TRADE_RULES,
  type LetterGrade,
} from "@/app/lib/alertConfig";
import type { OptionContract, PutCall } from "@/app/lib/contract";
import { assessEventRisk, type EarningsFact } from "@/app/lib/eventRisk";
import {
  calendarDaysBetween,
  estimateSide,
  newYorkDate,
  notionalPremium,
  otmDistance,
  volumeOiRatio,
} from "@/app/lib/flow";
import {
  checkBidAskSpread,
  dailyStopPasses,
  DEBIT_SPREAD_SUGGESTION,
  openInterestPasses,
  volumePasses,
} from "@/app/lib/gate";
import type { KeyLevels } from "@/app/lib/levels";
import {
  aggressorFromSide,
  minutesSinceOpen,
  trendFromPrices,
  type IndexDirection,
  type PairedFlow,
  type RepeatFlow,
  type TrendAlignment,
} from "@/app/lib/marketContext";
import { chicagoClock, isChicagoMarketHours } from "@/app/lib/marketHours";
import { DAILY_STOP_CONSECUTIVE_LOSSES, MAX_LOSS_DOLLARS, MIN_CONTRACT_VOLUME, MIN_OPEN_INTEREST } from "@/app/lib/risk";
import { gradeContract, knownLosses, readSetupFacts, type SetupInput, type VerdictName } from "@/app/lib/verdict";
import { DAILY_STOP_PAPER_MESSAGE, paperCostError } from "@/app/lib/trades";

/**
 * Grade one contract with the alert checklist.
 * Missing, stale, or failed data is unknown. It is never filled in and never a pass.
 * An unknown on a required check cannot be an overall A.
 *
 * The alert grader has no minute-level stale cutoff. This form treats a quote as
 * stale when the market is closed, the quote time is missing, the quote is not
 * from the current Chicago session, or the quote is older than the 15-minute
 * scan cadence.
 */

export const QUOTE_MAX_AGE_MS = 15 * 60 * 1000;

export type GradeCheckStatus = "pass" | "fail" | "unknown";
export type OverallGrade = "A" | "B" | "Fail";

export interface GradeCheckRow {
  id: string;
  label: string;
  status: GradeCheckStatus;
  detail: string;
  required: boolean;
}

export interface GradeTradeResult {
  overall: OverallGrade;
  /** Letter from gradeContract before this form's unknown cap. Null when the contract was not graded. */
  scannerGrade: LetterGrade | null;
  verdict: VerdictName | null;
  checks: GradeCheckRow[];
  notes: string[];
  note: string;
  gradedAt: number;
  quotedAt: number | null;
  quoteNote: string;
  entryPrice: number | null;
  entryPriceSource: "ask" | "typed" | null;
  flowPremium: number | null;
  ask: number | null;
  thesis: string | null;
  canSave: boolean;
  saveBlock: string | null;
  /** Stored on the paper trade so Learning mode can read the same snapshot. */
  features: AlertFeatureSnapshot | null;
}

export interface GradeMyTradeInput {
  expiration: string;
  strike: number;
  putCall: PutCall;
  contract: OptionContract | null;
  underlyingPrice: number | null;
  delayed: boolean;
  now: Date;
  consecutiveLosses: number | null;
  levels: KeyLevels | null;
  earnings: EarningsFact | null;
  providerError: string | null;
  plannedEntry: number | null;
  thesis: string | null;
  pairedFlow?: PairedFlow | null;
  trendAlignment?: TrendAlignment | null;
  marketAlignment?: TrendAlignment | null;
  spyDirection?: IndexDirection | null;
  qqqDirection?: IndexDirection | null;
  repeatFlow?: RepeatFlow | null;
  ivVsRecent?: number | null;
}

export interface GradeRequest {
  ticker: string;
  expiration: string;
  strike: number;
  putCall: PutCall;
  plannedEntry: number | null;
  thesis: string | null;
}

const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const QUOTE_CHECK_IDS = new Set([
  "openInterest",
  "volume",
  "spread",
  "ask",
  "cost",
  "flow",
  "flowSignals",
  "moneyness",
  "levels",
]);

export function parseGradeRequest(body: unknown): { ok: true; value: GradeRequest } | { ok: false; error: string } {
  const row = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if (!row) return { ok: false, error: "Expected a JSON object" };

  const ticker = typeof row.ticker === "string" ? row.ticker.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) return { ok: false, error: "Enter a ticker, such as SPY." };

  const rawExpiration = typeof row.expiration === "string" ? row.expiration.trim() : "";
  const expiration = realYmd(rawExpiration);
  if (!expiration) return { ok: false, error: "Enter an expiration as YYYY-MM-DD." };

  const strike = asNumber(row.strike);
  if (strike == null || strike <= 0 || strike > 1_000_000) return { ok: false, error: "Enter a strike greater than zero." };

  const putCall = parseRight(row.putCall);
  if (!putCall) return { ok: false, error: "Choose call or put." };

  const plannedRaw = row.plannedEntry;
  let plannedEntry: number | null = null;
  if (plannedRaw !== null && plannedRaw !== undefined && plannedRaw !== "") {
    const planned = asNumber(plannedRaw);
    if (planned == null || planned <= 0 || planned > 100_000) {
      return { ok: false, error: "Planned entry has to be a price greater than zero, or leave it blank." };
    }
    plannedEntry = planned;
  }

  if (row.thesis != null && typeof row.thesis !== "string") {
    return { ok: false, error: "Thesis has to be short text, or leave it blank." };
  }

  return {
    ok: true,
    value: {
      ticker,
      expiration,
      strike,
      putCall,
      plannedEntry,
      thesis: clipThesis(typeof row.thesis === "string" ? row.thesis : null),
    },
  };
}

export function gradeMyTrade(input: GradeMyTradeInput): GradeTradeResult {
  const freshness = quoteFreshness(input);
  const expiration = input.contract?.expiration?.slice(0, 10) || input.expiration;
  const dte = calendarDaysBetween(newYorkDate(input.now), expiration);
  const setup = input.providerError || !input.contract ? null : setupFrom(input, expiration, dte);
  const verdict = setup ? gradeContract({
    contract: input.contract as OptionContract,
    underlyingPrice: input.underlyingPrice,
    delayed: input.delayed,
    now: input.now,
    consecutiveLosses: knownLosses(input.consecutiveLosses),
    levels: input.levels,
    earnings: input.earnings,
    definedRiskSpread: false,
    pairedFlow: input.pairedFlow ?? null,
    trendAlignment: input.trendAlignment ?? null,
    marketAlignment: input.marketAlignment ?? null,
  }) : null;
  const facts = setup ? readSetupFacts(setup) : null;

  let checks: GradeCheckRow[] = [
    quoteRow(freshness),
    contractRow(input, expiration),
    openInterestRow(input.contract),
    volumeRow(input.contract),
    spreadRow(input.contract),
    askRow(input.contract),
    costRow(input.contract),
    dteRow(dte),
    flowRow(setup?.notionalPremium ?? null),
    flowSignalRow(setup, facts),
    moneynessRow(setup, facts),
    levelRow(facts),
    earningsRow(input, expiration, dte),
    dailyStopRow(input.consecutiveLosses),
  ];
  checks = applyFreshness(checks, freshness);

  const scannerGrade = verdict?.grade ?? null;
  const requiredUnknown = checks.some((check) => check.required && check.status === "unknown");
  const requiredFail = checks.some((check) => check.required && check.status === "fail");
  const stopped = verdict?.verdict === "STOP" || checks.some((check) => check.id === "dailyStop" && check.status === "fail");
  let overall: OverallGrade = "Fail";
  if (!requiredFail && !stopped && scannerGrade === "A" && !requiredUnknown) overall = "A";
  else if (!requiredFail && !stopped && (scannerGrade === "A" || scannerGrade === "B")) overall = "B";

  const notes: string[] = [];
  if (scannerGrade === "A" && overall !== "A") {
    notes.push("A required check could not be verified, so this is not an A.");
  }
  if (verdict) {
    for (let i = 0; i < verdict.reasons.length; i++) notes.push(verdict.reasons[i]);
  }

  const ask = input.contract && Number.isFinite(input.contract.ask) && input.contract.ask > 0 ? input.contract.ask : null;
  const typed = input.plannedEntry != null && input.plannedEntry > 0 ? input.plannedEntry : null;
  const entryPrice = typed ?? (freshness.state === "live" ? ask : null);
  const entryPriceSource = typed != null ? "typed" : entryPrice != null ? "ask" : null;
  const flowPremium = setup?.notionalPremium != null && Number.isFinite(setup.notionalPremium) ? setup.notionalPremium : null;
  const saveBlock = saveBlockFor(entryPrice, checks);

  return {
    overall,
    scannerGrade,
    verdict: verdict?.verdict ?? null,
    checks,
    notes,
    note: ALERT_RULES.note,
    gradedAt: input.now.getTime(),
    quotedAt: freshness.quotedAt,
    quoteNote: freshness.detail,
    entryPrice,
    entryPriceSource,
    flowPremium,
    ask,
    thesis: input.thesis,
    canSave: saveBlock == null,
    saveBlock,
    features: setup ? featuresForGrade(input, setup) : null,
  };
}

function featuresForGrade(input: GradeMyTradeInput, setup: SetupInput): AlertFeatureSnapshot {
  const trend = trendFromPrices(
    setup.putCall,
    setup.underlyingPrice,
    input.levels?.vwap ?? null,
    input.levels?.sma20 ?? null,
  );
  return {
    ...emptyFeatures(),
    capturedAtAlert: true,
    flowPremium: finiteFeature(setup.notionalPremium),
    volOiRatio: finiteFeature(setup.volOiRatio),
    spreadFraction: finiteFeature(checkBidAskSpread(setup.bid, setup.ask).fraction),
    iv: input.contract && Number.isFinite(input.contract.iv) && (input.contract.iv as number) > 0 ? input.contract.iv : null,
    delta: input.contract && Number.isFinite(input.contract.delta) ? input.contract.delta : null,
    otmFraction: finiteFeature(setup.otmFraction),
    otm: setup.otm,
    dte: setup.dte != null && setup.dte >= 0 ? setup.dte : null,
    side: setup.side,
    minutesSinceOpen: minutesSinceOpen(input.now),
    priceVsVwap: trend.priceVsVwap,
    priceVsSma20: trend.priceVsSma20,
    trendAlignment: input.trendAlignment ?? trend.trendAlignment,
    spyDirection: input.spyDirection ?? null,
    qqqDirection: input.qqqDirection ?? null,
    marketAlignment: input.marketAlignment ?? null,
    ivVsRecent: finiteFeature(input.ivVsRecent),
    aggressor: aggressorFromSide(setup.side),
    repeatFlow: input.repeatFlow ?? null,
    pairedFlow: input.pairedFlow ?? null,
  };
}

function finiteFeature(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

interface Freshness {
  state: "live" | "delayed" | "closed" | "stale" | "untimed" | "missing" | "provider";
  quotedAt: number | null;
  detail: string;
}

function quoteFreshness(input: GradeMyTradeInput): Freshness {
  if (input.providerError) {
    return { state: "provider", quotedAt: null, detail: input.providerError };
  }
  if (!input.contract) {
    return {
      state: "missing",
      quotedAt: null,
      detail: "That strike is not in the live chain, so this quote was not graded.",
    };
  }
  const quotedAt = finiteTime(input.contract.quoteTime);
  if (input.delayed) {
    return {
      state: "delayed",
      quotedAt,
      detail: "Schwab marked this chain delayed. Real-time data is required.",
    };
  }
  if (!isChicagoMarketHours(input.now)) {
    const when = quotedAt == null ? "" : ` Quote time ${formatChicago(quotedAt)}.`;
    return {
      state: "closed",
      quotedAt,
      detail: `The market is closed, so this quote was not graded as live.${when}`,
    };
  }
  if (quotedAt == null) {
    return {
      state: "untimed",
      quotedAt: null,
      detail: "Schwab did not send a quote time, so this quote cannot be checked for staleness.",
    };
  }
  const quoteClock = chicagoClock(new Date(quotedAt));
  const nowClock = chicagoClock(input.now);
  const sessionOpen = 8 * 60 + 30;
  if (!quoteClock || !nowClock || quoteClock.date !== nowClock.date || quoteClock.minutes < sessionOpen) {
    return {
      state: "stale",
      quotedAt,
      detail: `The quote time ${formatChicago(quotedAt)} is not from the current Chicago session, so it was not graded as live.`,
    };
  }
  const age = input.now.getTime() - quotedAt;
  if (age > QUOTE_MAX_AGE_MS || quotedAt - input.now.getTime() > 2 * 60 * 1000) {
    return {
      state: "stale",
      quotedAt,
      detail: `The quote time ${formatChicago(quotedAt)} is more than 15 minutes from now, so it was not graded as live.`,
    };
  }
  return { state: "live", quotedAt, detail: `Quote time ${formatChicago(quotedAt)}.` };
}

function applyFreshness(checks: GradeCheckRow[], freshness: Freshness): GradeCheckRow[] {
  if (freshness.state === "live") return checks;
  const blocked = freshness.state === "delayed"
    ? "Schwab marked this chain delayed, so this was not counted as a pass."
    : freshness.detail;
  return checks.map((check) => {
    if (!QUOTE_CHECK_IDS.has(check.id)) return check;
    return { ...check, status: "unknown", detail: blocked, required: true };
  });
}

function setupFrom(input: GradeMyTradeInput, expiration: string, dte: number | null): SetupInput {
  const contract = input.contract as OptionContract;
  const spread = checkBidAskSpread(contract.bid, contract.ask);
  const side = estimateSide(contract.bid, contract.ask, contract.last);
  const distance = otmDistance(contract.putCall, contract.strike, input.underlyingPrice);
  return {
    bid: contract.bid,
    ask: contract.ask,
    volume: contract.volume,
    openInterest: contract.openInterest,
    mid: spread.mid,
    notionalPremium: notionalPremium(contract.volume, spread.mid),
    volOiRatio: volumeOiRatio(contract.volume, contract.openInterest),
    volumeJump: null,
    side: side.label,
    otmFraction: distance.fraction,
    otm: distance.otm,
    dte,
    delayed: input.delayed,
    strike: contract.strike,
    expiration,
    putCall: contract.putCall,
    underlyingPrice: input.underlyingPrice,
    consecutiveLosses: knownLosses(input.consecutiveLosses),
    levels: input.levels,
    earnings: input.earnings,
    definedRiskSpread: false,
    now: input.now,
  };
}

function quoteRow(freshness: Freshness): GradeCheckRow {
  if (freshness.state === "live") return row("quote", "Quote", "pass", freshness.detail, true);
  if (freshness.state === "delayed") return row("quote", "Quote", "fail", freshness.detail, true);
  return row("quote", "Quote", "unknown", freshness.detail, true);
}

function contractRow(input: GradeMyTradeInput, expiration: string): GradeCheckRow {
  if (input.providerError) return row("contract", "Contract", "unknown", input.providerError, true);
  if (!input.contract) {
    return row("contract", "Contract", "unknown", "That strike is not in the live chain, so it was not graded.", true);
  }
  const right = input.contract.putCall === "put" ? "put" : "call";
  return row("contract", "Contract", "pass", `${expiration} ${input.contract.strike} ${right}.`, true);
}

function openInterestRow(contract: OptionContract | null): GradeCheckRow {
  const seen = contract ? finiteNumber(contract.openInterest) : null;
  if (seen == null) {
    return row("openInterest", "Open interest", "unknown", "Open interest is missing, so it was not counted as a pass.", true);
  }
  if (!openInterestPasses(seen)) {
    return row("openInterest", "Open interest", "fail", `Open interest ${count(seen)}, below the ${MIN_OPEN_INTEREST} minimum.`, true);
  }
  return row("openInterest", "Open interest", "pass", `Open interest ${count(seen)}. Minimum is ${MIN_OPEN_INTEREST}.`, true);
}

function volumeRow(contract: OptionContract | null): GradeCheckRow {
  const seen = contract ? finiteNumber(contract.volume) : null;
  if (seen == null) {
    return row("volume", "Volume", "unknown", "Volume is missing, so it was not counted as a pass.", true);
  }
  if (!volumePasses(seen)) {
    return row("volume", "Volume", "fail", `Volume ${count(seen)}, below the ${MIN_CONTRACT_VOLUME} minimum today.`, true);
  }
  return row("volume", "Volume", "pass", `Volume ${count(seen)}. Minimum is ${MIN_CONTRACT_VOLUME} contracts today.`, true);
}

function spreadRow(contract: OptionContract | null): GradeCheckRow {
  if (!contract || !Number.isFinite(contract.bid) || !Number.isFinite(contract.ask)) {
    return row("spread", "Bid-ask spread", "unknown", "Bid or ask is missing, so the spread was not counted as a pass.", true);
  }
  const result = checkBidAskSpread(contract.bid, contract.ask);
  return row("spread", "Bid-ask spread", result.pass ? "pass" : "fail", result.detail, true);
}

function askRow(contract: OptionContract | null): GradeCheckRow {
  const ask = contract ? finiteNumber(contract.ask) : null;
  if (ask == null || ask <= 0) {
    return row("ask", "Ask", "unknown", "The ask is missing, so the contract price was not checked.", true);
  }
  const floor = formatAskPrice(ALERT_RULES.minContractPremium);
  if (ask < ALERT_RULES.minContractPremium) {
    return row("ask", "Ask", "fail", `The ask is ${formatAskPrice(ask)}, below the ${floor} minimum.`, true);
  }
  return row("ask", "Ask", "pass", `The ask is ${formatAskPrice(ask)}, at least ${floor}.`, true);
}

function costRow(contract: OptionContract | null): GradeCheckRow {
  const ask = contract ? finiteNumber(contract.ask) : null;
  if (ask == null || ask <= 0) {
    return row("cost", "Contract cost", "unknown", "The ask is missing, so the contract cost was not checked.", true);
  }
  const cost = formatContractCost(ask);
  if (ask * 100 > MAX_LOSS_DOLLARS) {
    return row(
      "cost",
      "Contract cost",
      "fail",
      `One contract costs ${cost}, over the $${MAX_LOSS_DOLLARS} cap. ${DEBIT_SPREAD_SUGGESTION}`,
      true,
    );
  }
  return row("cost", "Contract cost", "pass", `One contract costs ${cost}, within the $${MAX_LOSS_DOLLARS} cap.`, true);
}

function dteRow(dte: number | null): GradeCheckRow {
  const min = ALERT_RULES.alertDteMin;
  const max = ALERT_RULES.alertDteMax;
  if (dte == null) return row("dte", "Days to expiration", "unknown", "Days to expiration could not be read.", true);
  if (dte < 0) return row("dte", "Days to expiration", "fail", "This expiration has already passed.", true);
  if (dte === 0) return row("dte", "Days to expiration", "fail", `This expires today. Under ${min} days is too short for an A or a B.`, true);
  if (dte < min) return row("dte", "Days to expiration", "fail", `${dte} days to expiration. Under ${min} days is too short for an A or a B.`, true);
  if (dte > max) return row("dte", "Days to expiration", "fail", `${dte} days to expiration. Past ${max} days is outside the window for an A or a B.`, true);
  return row("dte", "Days to expiration", "pass", `${dte} days to expiration, inside the ${min}–${max} day window.`, true);
}

function flowRow(notional: number | null): GradeCheckRow {
  const aFloor = formatFlowPremium(ALERT_RULES.aMinFlowPremium);
  const bFloor = formatFlowPremium(ALERT_RULES.bMinFlowPremium);
  if (notional == null || !Number.isFinite(notional)) {
    return row("flow", "Flow premium", "unknown", "No flow premium for this strike. Volume or the midpoint is missing, so it was not counted as a pass.", true);
  }
  if (notional < ALERT_RULES.bMinFlowPremium) {
    return row("flow", "Flow premium", "fail", `Flow premium is about ${formatFlowPremium(notional)}. An A needs at least ${aFloor} and a B needs at least ${bFloor}.`, true);
  }
  if (notional < ALERT_RULES.aMinFlowPremium) {
    return row("flow", "Flow premium", "pass", `Flow premium is about ${formatFlowPremium(notional)}. That clears the ${bFloor} B floor and is under the ${aFloor} A floor.`, true);
  }
  return row("flow", "Flow premium", "pass", `Flow premium is about ${formatFlowPremium(notional)}, at least the ${aFloor} A floor.`, true);
}

function flowSignalRow(setup: SetupInput | null, facts: ReturnType<typeof readSetupFacts> | null): GradeCheckRow {
  if (!setup || facts == null || setup.notionalPremium == null || setup.volOiRatio == null) {
    return row("flowSignals", "Flow signals", "unknown", "Flow signals cannot be counted because volume or the midpoint is missing.", true);
  }
  if (facts.qualifiesForA) {
    return row(
      "flowSignals",
      "Flow signals",
      "pass",
      `Flow clears the A bar: ${facts.flowSignalCount} of 4 signals, with volume at least ${ALERT_RULES.aGradeVolOiRatio}× open interest.`,
      true,
    );
  }
  if (facts.flowSignalCount >= ALERT_RULES.takeMinFlowSignals && facts.flowFit !== "below-b") {
    return row(
      "flowSignals",
      "Flow signals",
      "pass",
      `Flow clears the B bar and not the A bar. ${facts.flowSignalCount} of 4 signals. An A needs ${ALERT_RULES.aMinFlowSignals}, volume at least ${ALERT_RULES.aGradeVolOiRatio}× open interest, and flow premium at the A floor.`,
      true,
    );
  }
  return row(
    "flowSignals",
    "Flow signals",
    "fail",
    `That is ${facts.flowSignalCount} of ${ALERT_RULES.takeMinFlowSignals} flow signals for a TAKE.`,
    true,
  );
}

function moneynessRow(setup: SetupInput | null, facts: ReturnType<typeof readSetupFacts> | null): GradeCheckRow {
  if (!setup || facts == null || setup.otm == null || setup.underlyingPrice == null || !(setup.underlyingPrice > 0)) {
    return row("moneyness", "Distance from the money", "unknown", "Distance from the money is unknown because the underlying price is missing.", true);
  }
  const where = distancePhrase(setup);
  if (!facts.distanceFits) {
    return row("moneyness", "Distance from the money", "fail", `${where}. That distance is outside the range for a TAKE.`, true);
  }
  if (facts.distanceIdeal) {
    return row("moneyness", "Distance from the money", "pass", `${where}. That is close enough for an A.`, true);
  }
  const otm = Math.round(ALERT_RULES.idealOtmFraction * 100);
  return row("moneyness", "Distance from the money", "pass", `${where}. That can be a B. An A needs the strike within ${otm}% out of the money.`, true);
}

function levelRow(facts: ReturnType<typeof readSetupFacts> | null): GradeCheckRow {
  if (!facts || !facts.level.checked) {
    const detail = facts?.level.sentence ?? `Support and resistance were not available, so this cannot be an A.`;
    return row("levels", "Distance to the next level", "unknown", detail, true);
  }
  if (facts.level.poor) return row("levels", "Distance to the next level", "fail", facts.level.sentence, true);
  return row("levels", "Distance to the next level", "pass", facts.level.sentence, true);
}

function earningsRow(input: GradeMyTradeInput, expiration: string, dte: number | null): GradeCheckRow {
  const event = assessEventRisk({
    now: input.now,
    expiration,
    dte,
    earnings: input.earnings,
    definedRiskSpread: false,
  });
  if (input.providerError && input.earnings == null) {
    return row("earnings", "Earnings and macro", "unknown", "Earnings were not checked because market data failed, so this was not counted as a pass.", true);
  }
  if (input.earnings == null || input.earnings.status === "unknown") {
    return row(
      "earnings",
      "Earnings and macro",
      "unknown",
      event.reason ?? "The earnings date is unknown, so this cannot be an A.",
      true,
    );
  }
  if (event.skipForEarnings || event.downgradeSteps > 0) {
    return row("earnings", "Earnings and macro", "fail", event.reason ?? event.eventLine, true);
  }
  return row("earnings", "Earnings and macro", "pass", event.eventLine, true);
}

function dailyStopRow(consecutiveLosses: number | null): GradeCheckRow {
  const losses = knownLosses(consecutiveLosses);
  if (losses == null) {
    return row("dailyStop", "Daily stop", "unknown", "The trade log loss count is not available, so the daily stop was not counted as a pass.", true);
  }
  if (!dailyStopPasses(losses)) {
    return row("dailyStop", "Daily stop", "fail", `${losses} closed losses in a row today. The daily stop is ${DAILY_STOP_CONSECUTIVE_LOSSES}.`, true);
  }
  return row("dailyStop", "Daily stop", "pass", `${losses} closed losses in a row today. The daily stop is ${DAILY_STOP_CONSECUTIVE_LOSSES}.`, true);
}

function saveBlockFor(entryPrice: number | null, checks: GradeCheckRow[]): string | null {
  const stopped = checks.some((check) => check.id === "dailyStop" && check.status === "fail");
  if (stopped) return DAILY_STOP_PAPER_MESSAGE;
  if (entryPrice == null) return "Enter a planned entry. There is no live ask to use, so this was not saved.";
  return paperCostError(entryPrice, 1);
}

function row(id: string, label: string, status: GradeCheckStatus, detail: string, required: boolean): GradeCheckRow {
  return { id, label, status, detail, required };
}

function distancePhrase(setup: SetupInput): string {
  if (setup.otm == null) return "Distance from the money is unknown";
  if (!setup.otm) {
    if (setup.underlyingPrice == null || !(setup.underlyingPrice > 0) || !Number.isFinite(setup.strike)) {
      return "Distance from the money is unknown";
    }
    const itm = Math.abs(setup.strike - setup.underlyingPrice) / setup.underlyingPrice;
    if (itm === 0) return "It is at the money";
    return `It is about ${percent(itm)} in the money`;
  }
  if (setup.otmFraction == null) return "Distance from the money is unknown";
  return `It is about ${percent(setup.otmFraction)} out of the money`;
}

function percent(fraction: number): string {
  const value = fraction * 100;
  const text = Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
  return `${text}%`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function finiteNumber(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

function finiteTime(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function formatChicago(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
}

function realYmd(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return match[0];
}

function parseRight(value: unknown): PutCall | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "call" || text === "c") return "call";
  if (text === "put" || text === "p") return "put";
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clipThesis(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, TRADE_RULES.maxNoteLength);
}
