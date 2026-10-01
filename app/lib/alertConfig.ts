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

  /** Inclusive days-to-expiration window for a quick short hold. */
  idealDteMin: 1,
  idealDteMax: 10,
  /** Still a short-hold candidate, but not enough on its own for TAKE. */
  acceptableDteMax: 21,

  /** Out-of-the-money fraction at or under this is a comfortable distance. */
  idealOtmFraction: 0.05,
  /** Out-of-the-money fraction at or under this can still be a TAKE. */
  acceptableOtmFraction: 0.10,
  /** In-the-money fraction above this is too expensive for this account. */
  maxItmFraction: 0.03,

  note: "Rules checklist only. This is not a prediction of profit.",
};

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

export function verdictBanner(): string {
  const cap = ALERT_RULES.maxGradeUntilLevels;
  const earningsCap = EVENT_RULES.maxGradeUntilEarnings;
  return `Checklist for a $${ACCOUNT_SIZE_DOLLARS.toLocaleString("en-US")} account with a $${MAX_LOSS_DOLLARS} loss cap. Not a prediction of profit. The grade can be an A when support and resistance are computed and the next earnings date is known. If price history is unavailable, the grade stops at ${cap}. If the earnings date is unknown, the grade stops at ${earningsCap}.`;
}
