import { ACCOUNT_SIZE_DOLLARS, MAX_LOSS_DOLLARS } from "@/app/lib/risk";

/**
 * Thresholds for the alert checklist and the later midpoint check.
 *
 * Loss cap, open interest, volume, and bid-ask spread stay in risk.ts.
 * The Gate and this checklist both read those, so they cannot drift.
 * Change a number here to change the checklist or the outcome labels.
 * Nothing in this file is a prediction of profit, and nothing is a fill.
 */

export type LetterGrade = "A" | "B" | "C" | "D";

export const ALERT_RULES = {
  /**
   * Letter withheld when price history did not produce support and resistance.
   * A computed level set removes this cap for that alert.
   */
  maxGradeUntilLevels: "B" as LetterGrade,

  /** Volume / open interest at or above this is one flow signal. */
  strongVolOiRatio: 1,
  /** Notional (volume × mid × 100) at or above this is one flow signal. */
  strongNotional: 250_000,
  /** Contracts added since the last same-day scan. One flow signal. */
  strongVolumeJump: 100,
  /** Estimated-at-ask is the fourth flow signal. Bid, mid, and unknown are not. */
  takeMinFlowSignals: 2,
  /**
   * Signals required before a TAKE can be an A.
   * Two signals can still be a TAKE. That letter is B.
   */
  aMinFlowSignals: 3,
  /**
   * Volume / open interest required for an A.
   * The flow signal itself uses the lower strongVolOiRatio.
   */
  aGradeVolOiRatio: 2,
  /**
   * Estimated flow premium (volume × mid × 100) required for an A.
   * The $100,000 / $50,000 A/B split is an assumption. The flow signal
   * itself still uses the lower strongNotional.
   */
  aMinFlowPremium: 100_000,
  /**
   * Estimated flow premium required for a B.
   * Below this cannot be an A or a B.
   */
  bMinFlowPremium: 50_000,

  /**
   * Inclusive days to expiration for an A or a B.
   * 14 to 42 is about 2 to 6 weeks. Shorter or longer stays C or below.
   * The 43–60 day test does not change these two numbers.
   */
  alertDteMin: 14,
  alertDteMax: 42,

  /** Out-of-the-money fraction at or under this is close enough for an A. */
  idealOtmFraction: 0.05,
  /** Out-of-the-money fraction at or under this can still be a TAKE. */
  acceptableOtmFraction: 0.10,
  /** In-the-money fraction above this is too expensive for this account. */
  maxItmFraction: 0.03,

  /**
   * Ask below this cannot be an A or a B.
   * 0.50 is $50 a contract. Cheaper than that is a lottery ticket.
   */
  minContractPremium: 0.50,
  /**
   * One long contract costs ask × 100. Above this cannot be an A or a B.
   * Same dollars as the loss cap in risk.ts. $8.75 ask is $875.
   * One contract over it names a debit spread. The scanner does not grade spreads.
   * A debit spread's max loss is the width.
   */
  maxContractCost: MAX_LOSS_DOLLARS,

  note: "Rules checklist only. This is not a prediction of profit.",
};

/** Ask × 100 for one long contract. Null when the ask cannot be priced. */
export function longContractCost(ask: number): number | null {
  if (!Number.isFinite(ask) || !(ask > 0)) return null;
  return ask * 100;
}

export type PremiumLimit = "cheap" | "expensive";

/**
 * Single long options are priced at the ask.
 * A defined-risk spread is not judged by ask × 100, because its max loss is the width.
 */
export function premiumLimitForAsk(ask: number, definedRiskSpread = false): PremiumLimit | null {
  if (!Number.isFinite(ask) || !(ask > 0) || ask < ALERT_RULES.minContractPremium) return "cheap";
  if (!definedRiskSpread && ask * 100 > ALERT_RULES.maxContractCost) return "expensive";
  return null;
}

export function formatAskPrice(ask: number): string {
  return `$${ask.toFixed(2)}`;
}

export function formatContractCost(ask: number): string {
  const cost = longContractCost(ask);
  if (cost == null) return "—";
  const nearest = Math.round(cost);
  if (Math.abs(cost - nearest) < 0.05) return `$${nearest.toLocaleString("en-US")}`;
  return `$${cost.toFixed(2)}`;
}

/** Ask and the dollars one long contract costs. This is the contract price, not flow premium. */
export function formatContractPriceLine(ask: number): string {
  if (longContractCost(ask) == null) return "Ask is not priced.";
  return `Ask ${formatAskPrice(ask)} · ${formatContractCost(ask)} a contract`;
}

/**
 * Estimated flow premium for display.
 * Same dollars as volume × midpoint × 100 on a Flow row.
 */
export function formatFlowPremium(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const digits = millions >= 10 ? 0 : 1;
    return `$${millions.toFixed(digits)}M`;
  }
  if (value >= 1_000) return `$${Math.round(value / 1_000).toLocaleString("en-US")}K`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Test-only shadows for contracts that would qualify except for days to expiration.
 * Not a grade, not a Telegram alert, and not part of the 14–42 day rule above.
 * 30 resolved results are the minimum before considering a wider window.
 * Quotes per run are taken from the existing shadow quote cap, not added on top.
 */
export const EXPERIMENT_DTE = {
  min: 43,
  max: 60,
  label: "Test: 43-60 DTE",
  minTrust: 30,
  /** New test shadows written on one cron run. */
  opensPerRun: 2,
  /** New test shadows written on one Chicago day. */
  opensPerDay: 4,
  /**
   * Test contracts marked on one run.
   * Real A/B shadows are quoted first. The run's total unique quotes stay at SHADOW_QUOTES_PER_RUN.
   */
  quotesPerRun: 4,
  /** Expirations in this window kept from a chain the scan already fetched. */
  keptExpirations: 4,
} as const;

export type FlowPremiumFit = "below-b" | "below-a" | "ok";

/** Below the B floor cannot be an A or a B. Between the floors can be a B, not an A. */
export function flowPremiumFit(notional: number | null): FlowPremiumFit {
  if (notional == null || !Number.isFinite(notional) || notional < ALERT_RULES.bMinFlowPremium) return "below-b";
  if (notional < ALERT_RULES.aMinFlowPremium) return "below-a";
  return "ok";
}

/**
 * ALERT_MIN_PREMIUM filters candidates before grading.
 * Unset uses the B floor so a B is not dropped before the letter is assigned.
 */
export function alertScanMinPremium(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return ALERT_RULES.bMinFlowPremium;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return ALERT_RULES.bMinFlowPremium;
  return parsed;
}

/**
 * Which grades leave the scanner.
 * Change a number here to change Telegram and the alert book.
 * ALERT_MAX_PER_DAY overrides maxPerDay when it is a whole number in range.
 */
export const ALERT_POLICY = {
  /** Letters that may be sent and stored. C and D stay on the Flow tab. */
  alertGrades: ["A", "B"] as readonly LetterGrade[],
  /** Default cap for one Chicago trading day. A is chosen before B. */
  maxPerDay: 5,
  /** ALERT_MAX_PER_DAY outside 1..maxPerDayCeiling is ignored. */
  maxPerDayCeiling: 50,
  /**
   * Extra A/B setups the cron may screen in one run when Grok flags one.
   * Successful sends still stop at the daily cap.
   */
  screenBuffer: 4,
};

export function isAlertGrade(grade: string): boolean {
  return (ALERT_POLICY.alertGrades as readonly string[]).indexOf(grade) !== -1;
}

/** Whole number from the env var, or the default cap when the value is unset or out of range. */
export function alertsPerDayLimit(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return ALERT_POLICY.maxPerDay;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ALERT_POLICY.maxPerDayCeiling) {
    return ALERT_POLICY.maxPerDay;
  }
  return parsed;
}

/**
 * How nearby price levels change the checklist.
 * These are distances, not a forecast. 0.004 means 0.4% of the underlying.
 */
export const LEVEL_RULES = {
  /** At or inside this fraction, price is sitting on the next level. */
  pinnedFraction: 0.0015,
  /** Room to the next level at or above this is enough for that side. */
  minRoomFraction: 0.004,
  /** Reward distance divided by the distance the other way. Below this, the grade drops. */
  minRewardToRisk: 1,
  /** Daily candles used for swing highs and lows. */
  dailyBars: 20,
  swingWing: 2,
  /** First minutes of the regular session treated as the open range. */
  openRangeMinutes: 30,
  /** Shared candle cache so a scan and the Gate do not each pull history. */
  cacheMs: 3 * 60 * 1000,
};

export const OUTCOME_RULES = {
  /**
   * Option mid up at least this much versus the alert mid, at any checkpoint.
   * 0.20 means 20%. Compared with midpoint, not the last trade.
   */
  winMidChange: 0.20,
  /**
   * Option mid down at least this much at the close, and no earlier win.
   * -0.20 means down 20%. This is not trade profit or loss.
   */
  missMidChange: -0.20,
  checkpoint15MinMs: 15 * 60 * 1000,
  checkpoint1HourMs: 60 * 60 * 1000,
  /** 15:00 America/Chicago. The cash close. Due on that session only. */
  closeCheckpointMinutes: 15 * 60,
  /** Minutes after 15:00 Chicago when the cron may still record the close quote. */
  closeWindowMinutes: 20,
  maxFollowUpQuotesPerRun: 20,
  maxStoredAlerts: 200,
  note: "Percents compare option midpoints. This is an estimate, not a fill, and it is not trade profit or loss.",
};

/**
 * Quote-derived prints. These are not exchange-reported sweeps.
 * Schwab's chain carries the latest trade (last size, trade time, bid, and ask),
 * not a tape. The cron runs every 15 minutes, so the only second-scale samples
 * are a few extra chain reads inside that one request.
 */
export const PRINT_RULES = {
  /** Last size at or above this many contracts is a block, even if the dollars are smaller. */
  blockMinContracts: 100,
  /** Last size × price × 100 at or above this is a block. */
  blockMinNotional: 50_000,
  /** Distinct trade times on one side, inside the window, before a burst is called sweep-like. */
  sweepMinPrints: 3,
  /** Milliseconds from the first trade time in the burst to the last. */
  sweepWindowMs: 8_000,
  /** Extra chain reads after the first, only for the most active tickers. */
  followUpReads: 2,
  /** Pause between those extra reads so a new last trade can show up. */
  followUpGapMs: 2_000,
  /** Stop extra reads after this much waiting, so a serverless invocation can still finish. */
  followUpBudgetMs: 8_000,
  /** How many active tickers get the extra reads. The rest keep the single chain. */
  maxFollowUpTickers: 4,
  /** Quote points kept per contract for the next poll. */
  historyPoints: 6,
  /** Added to the flow score when a new print was detected. */
  printScore: 4,
  /** Added on top when that print's last size is a block. */
  blockScore: 8,
  /** Added on top when several prints land inside the burst window. */
  sweepScore: 12,
};

/**
 * Exit rules and the manual trade log.
 * These are starting defaults. Change a number here to tune them.
 * Nothing here places an order.
 */
export const TRADE_RULES = {
  /** Take this fraction of the contracts off at the profit target. 0.5 is half. */
  scaleOutFraction: 0.5,
  /** Profit target as a fraction of the debit paid. 0.40 is +40%. */
  profitTargetFraction: 0.40,
  /** Stop as a fraction of the debit paid, before the dollar cap. 0.25 is -25%. */
  stopLossFraction: 0.25,
  /**
   * Get out when the trade is still flat after this many Chicago trading days.
   * Weekends do not count. This is not the same-day cash-close checkpoint.
   */
  flatAfterTradingDays: 3,
  /**
   * Plain reminder for contracts about 2 to 6 weeks out.
   * Defined here so the Gate, the alerts, and the trade log say the same thing.
   */
  lastWeekExitReminder: "Be out before the last week to expiration.",
  /** A closed trade whose dollar P&L is inside this band is flat. */
  flatAbsDollars: 1,
  /** Information-only flag when the week's closed P&L is down this fraction of the account. */
  weeklyDrawdownFraction: 0.25,
  /** Same contract ceiling as the Gate. */
  maxContracts: 100,
  maxNoteLength: 240,
  maxStoredTrades: 500,
  note: "Starting defaults. Change these numbers to tune the exits. They are not a broker order.",
  sampleNote: "The sample is small until many trades are closed. A win rate on a handful of trades is not a track record.",
};

export const SMALL_SAMPLE_NOTE =
  "The sample is small until many alerts are graded. A hit rate on a handful of names is not a track record.";

/**
 * Event risk for a contract: company earnings and market-wide release days.
 * Change a number here to change the checklist. The date list is the 2026
 * schedule; replace it when the next year's calendars are published.
 *
 * FOMC dates are the statement day (the second day of the meeting) from
 * the Federal Reserve FOMC calendar.
 * CPI, the Employment Situation (jobs report), and PPI are release days from
 * the BLS Schedule of Selected Releases for 2026.
 */
export interface MacroRelease {
  date: string;
  name: string;
}

export const EVENT_RULES = {
  /**
   * Letter withheld when the earnings source is down or the next date is not known.
   * A confirmed date, or a symbol with no earnings calendar, removes this cap.
   */
  maxGradeUntilEarnings: "B" as LetterGrade,
  /** Steps down when the next earnings date falls on or before expiration. */
  earningsDowngradeSteps: 1,
  /** Steps down once when any listed macro release falls on or before expiration. */
  macroDowngradeSteps: 1,
  /**
   * Earnings this many calendar days from today still counts as imminent.
   * 1 means today or tomorrow.
   */
  imminentEarningsDays: 1,
  /**
   * Days to expiration at or under this is short-dated.
   * Earnings today or tomorrow on a short-dated single is a SKIP.
   * A defined-risk spread is the exception. A single long option is not.
   */
  shortDatedDteMax: 10,
  /** A known date, or a symbol with no earnings calendar, stays cached this many hours. */
  cacheHours: 6,
  /** A failed lookup is cached briefly, then tried again. It is never treated as safe. */
  unknownCacheMinutes: 20,
  /** Public Yahoo crumb lifetime. Not an API key. */
  crumbCacheMinutes: 30,
  requestTimeoutMs: 8000,
  macroDates: [
    { date: "2026-01-09", name: "Jobs report" },
    { date: "2026-01-13", name: "CPI" },
    { date: "2026-01-14", name: "PPI" },
    { date: "2026-01-28", name: "FOMC" },
    { date: "2026-01-30", name: "PPI" },
    { date: "2026-02-11", name: "Jobs report" },
    { date: "2026-02-13", name: "CPI" },
    { date: "2026-02-27", name: "PPI" },
    { date: "2026-03-06", name: "Jobs report" },
    { date: "2026-03-11", name: "CPI" },
    { date: "2026-03-18", name: "FOMC" },
    { date: "2026-03-18", name: "PPI" },
    { date: "2026-04-03", name: "Jobs report" },
    { date: "2026-04-10", name: "CPI" },
    { date: "2026-04-14", name: "PPI" },
    { date: "2026-04-29", name: "FOMC" },
    { date: "2026-05-08", name: "Jobs report" },
    { date: "2026-05-12", name: "CPI" },
    { date: "2026-05-13", name: "PPI" },
    { date: "2026-06-05", name: "Jobs report" },
    { date: "2026-06-10", name: "CPI" },
    { date: "2026-06-11", name: "PPI" },
    { date: "2026-06-17", name: "FOMC" },
    { date: "2026-07-02", name: "Jobs report" },
    { date: "2026-07-14", name: "CPI" },
    { date: "2026-07-15", name: "PPI" },
    { date: "2026-07-29", name: "FOMC" },
    { date: "2026-08-07", name: "Jobs report" },
    { date: "2026-08-12", name: "CPI" },
    { date: "2026-08-13", name: "PPI" },
    { date: "2026-09-04", name: "Jobs report" },
    { date: "2026-09-10", name: "PPI" },
    { date: "2026-09-11", name: "CPI" },
    { date: "2026-09-16", name: "FOMC" },
    { date: "2026-10-02", name: "Jobs report" },
    { date: "2026-10-14", name: "CPI" },
    { date: "2026-10-15", name: "PPI" },
    { date: "2026-10-28", name: "FOMC" },
    { date: "2026-11-06", name: "Jobs report" },
    { date: "2026-11-10", name: "CPI" },
    { date: "2026-11-13", name: "PPI" },
    { date: "2026-12-04", name: "Jobs report" },
    { date: "2026-12-09", name: "FOMC" },
    { date: "2026-12-10", name: "CPI" },
    { date: "2026-12-15", name: "PPI" },
  ] as MacroRelease[],
};

/**
 * One-paragraph rubric for a letter A. Numbers come from ALERT_RULES
 * so the sentence cannot drift from the checklist.
 */
export function gradeARubric(): string {
  const aFlow = formatFlowPremium(ALERT_RULES.aMinFlowPremium);
  const bFlow = formatFlowPremium(ALERT_RULES.bMinFlowPremium);
  const otm = Math.round(ALERT_RULES.idealOtmFraction * 100);
  const itm = Math.round(ALERT_RULES.maxItmFraction * 100);
  const levelsCap = ALERT_RULES.maxGradeUntilLevels;
  const earningsCap = EVENT_RULES.maxGradeUntilEarnings;
  return `An A is a TAKE that is one of the best setups of the day, not every contract that passes the checklist. It needs live quotes, open interest, volume, and a bid-ask spread that pass the Gate. The ask has to be at least $${ALERT_RULES.minContractPremium.toFixed(2)}. One long contract at the ask (ask × 100) can cost up to $${MAX_LOSS_DOLLARS} and still be an A or a B. A cheaper ask, or a contract that costs more than that, cannot be an A or a B. That $${MAX_LOSS_DOLLARS} is also the loss cap. One contract over it names a debit spread. Flow premium is estimated as volume × midpoint × 100, not an exchange-reported sweep. An A needs at least ${aFlow} of that flow premium. A B needs at least ${bFlow}. Below ${bFlow} cannot be an A or a B. Expiration is ${ALERT_RULES.alertDteMin} to ${ALERT_RULES.alertDteMax} days, about 2 to 6 weeks, and the strike is within ${otm}% out of the money or ${itm}% in the money. A contract under ${ALERT_RULES.alertDteMin} days, or past ${ALERT_RULES.alertDteMax} days, cannot be an A or a B. Flow is exceptional: at least ${ALERT_RULES.aMinFlowSignals} of the 4 signals (volume versus open interest, flow premium, a last trade at the ask, and a same-day volume jump), with volume at least ${ALERT_RULES.aGradeVolOiRatio}× open interest and flow premium at least ${aFlow}. Support and resistance are computed and leave room to the next level. The earnings date is known, or the ticker has no earnings calendar, and that date falls after expiration. No listed macro release falls on or before expiration. Missing price levels, an unknown earnings date, earnings or a macro release inside the contract, ordinary flow, or a farther strike leaves the letter at ${levelsCap} or lower. If price history is unavailable, the grade stops at ${levelsCap}. If the earnings date is unknown, the grade stops at ${earningsCap}. A liquidity failure, delayed quotes, and an expired contract stay SKIP and cannot be an A or a B. Two losing closes stay STOP for today instead of TAKE. An A is never shown when the levels or the earnings date are missing.`;
}

/** Shown with the checklist so the Flow tab and the rubric agree about what is sent. */
export function alertDeliveryNote(): string {
  return `Only an A or a B is sent to Telegram or saved in the alert book. At most ${ALERT_POLICY.maxPerDay} alerts go out on a Chicago trading day unless ALERT_MAX_PER_DAY sets another cap from 1 to ${ALERT_POLICY.maxPerDayCeiling}, and an A is sent before a B. The same ticker, call or put, and expiration is not alerted again that day. A C or a D can still show on the Flow tab.`;
}

export function verdictBanner(): string {
  return `Checklist for a $${ACCOUNT_SIZE_DOLLARS.toLocaleString("en-US")} account with a $${MAX_LOSS_DOLLARS} loss cap. Not a prediction of profit. ${alertDeliveryNote()} ${gradeARubric()}`;
}
