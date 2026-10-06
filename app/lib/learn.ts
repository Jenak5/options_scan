import { ALERT_RULES, EXPERIMENT_DTE, TRADE_RULES } from "@/app/lib/alertConfig";
import {
  emptyFeatures,
  featuresForAlert,
  levelBucket,
  type AlertFeatureSnapshot,
} from "@/app/lib/alertFeatures";
import type { StoredAlert } from "@/app/lib/alertBook";
import { calendarDaysBetween, newYorkDate } from "@/app/lib/flow";
import { MAX_BID_ASK_SPREAD_OF_MID, MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { chicagoClock } from "@/app/lib/marketHours";
import { SHADOW_MIN_TRUST, isExperimentShadow, shadowExitLabel, type ShadowTrade } from "@/app/lib/shadow";
import { tradeMetrics, type StoredTrade } from "@/app/lib/trades";

/**
 * Read-only comparison of resolved shadows and closed paper trades.
 * Nothing here places an order, reads a chain, or changes a rule.
 * A bucket under 30 resolved results is too few to trust.
 * The text is filled in from the counts. It is not a model.
 */

export const LEARN_MIN_TRUST = SHADOW_MIN_TRUST;

export interface LearnCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "unknown";
}

export interface LearnBucket {
  key: string;
  label: string;
  count: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  averagePnl: number | null;
  tooFew: boolean;
}

export interface LearnFactor {
  id: string;
  label: string;
  cuts: string;
  included: number;
  excludedUnknown: number;
  buckets: LearnBucket[];
  winRateGap: number | null;
  bestLabel: string | null;
  worstLabel: string | null;
  tooFew: boolean;
  rank: number;
}

export interface LearnTrade {
  id: string;
  source: "shadow" | "paper" | "test";
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  gradeLabel: string;
  cohort: "ab" | "experiment" | "paper";
  exitReason: string;
  exitDetail: string;
  pnlDollars: number;
  pnlFraction: number | null;
  result: "win" | "loss" | "flat";
  openedAt: number;
  closedAt: number | null;
  entryPrice: number;
  exitPrice: number | null;
  contracts: number;
  features: AlertFeatureSnapshot;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  marksSeen: number;
  markNote: string;
  checks: LearnCheck[] | null;
}

export interface LearnReport {
  estimateNote: string;
  resolved: number;
  testResolved: number;
  testOpen: number;
  wins: number;
  losses: number;
  flats: number;
  totalPnl: number;
  tooFew: boolean;
  omittedShadows: number;
  summary: string[];
  suggestions: string[];
  suggestionNote: string;
  checksNote: string;
  factors: LearnFactor[];
  unavailable: Array<{ id: string; label: string; excludedUnknown: number }>;
  trades: LearnTrade[];
}

export interface LearnInput {
  shadows: readonly ShadowTrade[];
  alerts: readonly StoredAlert[];
  trades: readonly StoredTrade[];
  checksByTradeId: ReadonlyMap<string, readonly LearnCheck[]>;
  now: Date;
}

const ESTIMATE_NOTE =
  "These are estimates from quotes, not fills. A gap in these tables describes the stored results. It is not proof. Learning mode does not change grading rules, thresholds, or the $875 cap.";

const SUGGESTION_NOTE =
  "Suggestions only. Nothing in this section changes a grade, a threshold, or the $875 cap.";

const CHECKS_NOTE =
  "Per-check results show up when a paper trade saved them, which Grade my trade does. Unknown checks are left out of that factor. Alerts saved before that field existed stay unknown.";

export function analyzeLearning(input: LearnInput): LearnReport {
  const built = buildTrades(input);
  const specs = factorSpecs().concat(checkSpecs(built.trades));
  const ranked: LearnFactor[] = [];
  const unavailable: Array<{ id: string; label: string; excludedUnknown: number }> = [];
  for (let i = 0; i < specs.length; i++) {
    const factor = buildFactor(specs[i], built.trades);
    if (factor.included === 0) {
      if (factor.excludedUnknown > 0 || specs[i].id.startsWith("check:")) {
        unavailable.push({ id: factor.id, label: factor.label, excludedUnknown: factor.excludedUnknown });
      }
      continue;
    }
    ranked.push(factor);
  }
  ranked.sort(bySeparation);
  for (let i = 0; i < ranked.length; i++) ranked[i].rank = i + 1;

  const main = built.trades.filter((row) => row.cohort !== "experiment");
  const tests = built.trades.filter((row) => row.cohort === "experiment");
  const totals = tally(main);
  const report: LearnReport = {
    estimateNote: ESTIMATE_NOTE,
    resolved: totals.count,
    testResolved: tests.length,
    testOpen: countOpenTests(input.shadows),
    wins: totals.wins,
    losses: totals.losses,
    flats: totals.flats,
    totalPnl: totals.pnl,
    tooFew: totals.count < LEARN_MIN_TRUST,
    omittedShadows: built.omittedShadows,
    summary: [],
    suggestions: [],
    suggestionNote: SUGGESTION_NOTE,
    checksNote: CHECKS_NOTE,
    factors: ranked,
    unavailable,
    trades: built.trades,
  };
  report.summary = summaryLines(report);
  report.suggestions = suggestionLines(ranked);
  return report;
}

export function learningCsv(report: LearnReport): string {
  const header = [
    "id", "source", "ticker", "putCall", "grade", "cohort", "strike", "expiration",
    "openedAt", "closedAt", "exitReason", "pnlDollars", "pnlPercent", "result",
    "flowPremium", "volOiRatio", "volumeJump", "flowSignalCount", "spreadFraction",
    "iv", "delta", "otmFraction", "itmFraction", "dte", "rewardDistance", "riskDistance",
    "earnings", "side", "maxFavorablePct", "maxAdversePct", "marksSeen",
  ];
  const lines = [header.join(",")];
  for (let i = 0; i < report.trades.length; i++) {
    const row = report.trades[i];
    const features = row.features;
    lines.push([
      row.id,
      row.source,
      row.ticker,
      row.putCall,
      row.gradeLabel,
      row.cohort,
      String(row.strike),
      row.expiration,
      new Date(row.openedAt).toISOString(),
      row.closedAt == null ? "" : new Date(row.closedAt).toISOString(),
      row.exitReason,
      row.pnlDollars.toFixed(2),
      row.pnlFraction == null ? "" : (row.pnlFraction * 100).toFixed(2),
      row.result,
      num(features.flowPremium),
      num(features.volOiRatio),
      num(features.volumeJump),
      features.flowSignalCount == null ? "" : String(features.flowSignalCount),
      num(features.spreadFraction),
      num(features.iv),
      num(features.delta),
      num(features.otmFraction),
      num(features.itmFraction),
      features.dte == null ? "" : String(features.dte),
      num(features.rewardDistance),
      num(features.riskDistance),
      features.earnings,
      features.side ?? "",
      row.maxFavorablePct == null ? "" : (row.maxFavorablePct * 100).toFixed(2),
      row.maxAdversePct == null ? "" : (row.maxAdversePct * 100).toFixed(2),
      String(row.marksSeen),
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Grade-my-trade checks live on the trade log JSON. The current parser may not keep them. */
export function readGradeChecks(text: string | null | undefined): Map<string, LearnCheck[]> {
  const out = new Map<string, LearnCheck[]>();
  if (!text) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const row = parsed && typeof parsed === "object" ? parsed as { trades?: unknown } : null;
  if (!row || !Array.isArray(row.trades)) return out;
  for (let i = 0; i < row.trades.length; i++) {
    const trade = row.trades[i];
    if (!trade || typeof trade !== "object") continue;
    const record = trade as { id?: unknown; gradeChecks?: unknown };
    const id = typeof record.id === "string" ? record.id : "";
    const checks = parseChecks(record.gradeChecks);
    if (id && checks.length > 0) out.set(id, checks);
  }
  return out;
}

interface FactorSpec {
  id: string;
  label: string;
  cuts: string;
  includeTest: boolean;
  order: readonly string[] | null;
  bucketOf: (row: LearnTrade) => string | null;
}

function buildTrades(input: LearnInput): { trades: LearnTrade[]; omittedShadows: number } {
  const alerts = new Map<string, StoredAlert>();
  for (let i = 0; i < input.alerts.length; i++) alerts.set(input.alerts[i].id, input.alerts[i]);
  const closedPaper = new Map<string, StoredTrade>();
  for (let i = 0; i < input.trades.length; i++) {
    const trade = input.trades[i];
    if (!trade.alertId) continue;
    if (tradeMetrics(trade).pnlDollars == null) continue;
    closedPaper.set(trade.alertId, trade);
  }

  const trades: LearnTrade[] = [];
  let omittedShadows = 0;
  const usedPaper = new Set<string>();
  for (let i = 0; i < input.shadows.length; i++) {
    const shadow = input.shadows[i];
    if (shadow.status !== "closed" || shadow.pnlDollars == null || shadow.exitPrice == null) continue;
    const paper = closedPaper.get(shadow.alertId);
    if (paper) {
      omittedShadows += 1;
      continue;
    }
    const alert = alerts.get(shadow.alertId) ?? null;
    trades.push(fromShadow(shadow, alert));
  }
  for (let i = 0; i < input.trades.length; i++) {
    const trade = input.trades[i];
    const metrics = tradeMetrics(trade);
    if (metrics.pnlDollars == null || metrics.result == null) continue;
    if (trade.alertId && usedPaper.has(trade.alertId)) continue;
    const shadow = findShadow(input.shadows, trade.alertId);
    if (shadow && shadow.status === "closed" && shadow.pnlDollars != null && !isExperimentShadow(shadow)) {
      // The shadow was omitted above. This paper trade is the one result.
    }
    const alert = trade.alertId ? alerts.get(trade.alertId) ?? null : null;
    const linked = shadow && !isExperimentShadow(shadow) ? shadow : null;
    trades.push(fromPaper(trade, alert, linked, input.checksByTradeId.get(trade.id) ?? null));
    if (trade.alertId) usedPaper.add(trade.alertId);
  }
  trades.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  return { trades, omittedShadows };
}

function fromShadow(shadow: ShadowTrade, alert: StoredAlert | null): LearnTrade {
  const test = isExperimentShadow(shadow);
  const marks = marksOf(shadow, alert);
  const features = resolveFeatures(shadow, alert, null);
  return {
    id: shadow.id,
    source: test ? "test" : "shadow",
    ticker: shadow.ticker,
    putCall: shadow.putCall,
    strike: shadow.strike,
    expiration: shadow.expiration,
    gradeLabel: test ? EXPERIMENT_DTE.label : shadow.grade,
    cohort: test ? "experiment" : "ab",
    exitReason: shadow.exitReason ?? "unknown",
    exitDetail: shadowExitLabel(shadow.exitReason) || "Exit reason was not stored.",
    pnlDollars: shadow.pnlDollars ?? 0,
    pnlFraction: shadow.pnlFraction,
    result: resultOf(shadow.pnlDollars ?? 0),
    openedAt: shadow.openedAt,
    closedAt: shadow.closedAt,
    entryPrice: shadow.entryPrice,
    exitPrice: shadow.exitPrice,
    contracts: 1,
    features,
    maxFavorablePct: marks.favorable,
    maxAdversePct: marks.adverse,
    marksSeen: marks.count,
    markNote: marks.note,
    checks: null,
  };
}

function fromPaper(
  trade: StoredTrade,
  alert: StoredAlert | null,
  shadow: ShadowTrade | null,
  checks: readonly LearnCheck[] | null,
): LearnTrade {
  const metrics = tradeMetrics(trade);
  const note = trade.exitNote?.trim() ?? "";
  return {
    id: trade.id,
    source: "paper",
    ticker: trade.ticker,
    putCall: trade.putCall,
    strike: trade.strike,
    expiration: trade.expiration,
    gradeLabel: trade.alertGrade ?? "unknown",
    cohort: "paper",
    exitReason: note ? "note" : "unrecorded",
    exitDetail: note
      ? `Note: ${note}`
      : "Closed in the trade log. No target, stop, time stop, or expiration reason was stored.",
    pnlDollars: metrics.pnlDollars ?? 0,
    pnlFraction: metrics.pnlFraction,
    result: metrics.result ?? resultOf(metrics.pnlDollars ?? 0),
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    contracts: trade.contracts,
    features: resolveFeatures(shadow, alert, trade),
    maxFavorablePct: null,
    maxAdversePct: null,
    marksSeen: 0,
    markNote: "The trade log does not store the quote path, so the best and worst marks are unknown.",
    checks: checks && checks.length > 0 ? checks.slice() : null,
  };
}

function resolveFeatures(
  shadow: ShadowTrade | null,
  alert: StoredAlert | null,
  trade: StoredTrade | null,
): AlertFeatureSnapshot {
  if (shadow?.features?.capturedAtAlert) return shadow.features;
  if (alert?.features?.capturedAtAlert) return alert.features;
  if (alert) return featuresForAlert(alert);
  if (shadow?.features) return shadow.features;
  if (shadow) return featuresFromWhen(shadow.openedAt, shadow.expiration, null);
  if (trade) return featuresFromWhen(trade.openedAt, trade.expiration, trade.flowPremium);
  return emptyFeatures();
}

function featuresFromWhen(openedAt: number, expiration: string, flowPremium: number | null): AlertFeatureSnapshot {
  const dte = calendarDaysBetween(newYorkDate(new Date(openedAt)), expiration);
  return {
    ...emptyFeatures(),
    flowPremium: flowPremium != null && Number.isFinite(flowPremium) ? flowPremium : null,
    dte: dte != null && dte >= 0 ? dte : null,
  };
}

function marksOf(shadow: ShadowTrade, alert: StoredAlert | null): {
  favorable: number | null;
  adverse: number | null;
  count: number;
  note: string;
} {
  if (shadow.marksSeen > 0 && shadow.maxFavorablePrice != null && shadow.maxAdversePrice != null) {
    const count = shadow.marksSeen;
    return {
      favorable: movePct(shadow.entryPrice, shadow.maxFavorablePrice),
      adverse: movePct(shadow.entryPrice, shadow.maxAdversePrice),
      count,
      note: `Best and worst of ${count} stored mark${count === 1 ? "" : "s"}. Not a tick path, and not a fill.`,
    };
  }
  const prices: number[] = [];
  if (alert) {
    const names = ["m15", "h1", "close"] as const;
    for (let i = 0; i < names.length; i++) {
      const mid = alert.checkpoints[names[i]].mid;
      if (mid != null && mid > 0) prices.push(mid);
    }
  }
  if (shadow.lastMark != null && shadow.lastMark > 0) prices.push(shadow.lastMark);
  if (shadow.exitPrice != null && shadow.exitPrice > 0) prices.push(shadow.exitPrice);
  if (prices.length === 0) {
    return { favorable: null, adverse: null, count: 0, note: "No stored marks, so the best and worst moves are unknown." };
  }
  let high = prices[0];
  let low = prices[0];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > high) high = prices[i];
    if (prices[i] < low) low = prices[i];
  }
  return {
    favorable: movePct(shadow.entryPrice, high),
    adverse: movePct(shadow.entryPrice, low),
    count: prices.length,
    note: `Recovered from ${prices.length} stored quote${prices.length === 1 ? "" : "s"} (checkpoint, last mark, or exit). Not a tick path, and not a fill.`,
  };
}

function factorSpecs(): FactorSpec[] {
  const dteMin = ALERT_RULES.alertDteMin;
  const dteMax = ALERT_RULES.alertDteMax;
  return [
    {
      id: "grade",
      label: "Grade",
      cuts: "A and B are the letters stored on the alert. The 43–60 day test is not a grade.",
      includeTest: false,
      order: ["A", "B", "C", "D"],
      bucketOf: (row) => (row.gradeLabel === "A" || row.gradeLabel === "B" || row.gradeLabel === "C" || row.gradeLabel === "D") ? row.gradeLabel : null,
    },
    {
      id: "flowPremium",
      label: "Flow premium",
      cuts: `Under $${ALERT_RULES.bMinFlowPremium.toLocaleString("en-US")} cannot be a B. Under $${ALERT_RULES.aMinFlowPremium.toLocaleString("en-US")} cannot be an A. $${ALERT_RULES.strongNotional.toLocaleString("en-US")} is one flow signal.`,
      includeTest: false,
      order: ["Under $50,000", "$50,000 to under $100,000", "$100,000 to under $250,000", "$250,000 or more"],
      bucketOf: (row) => premiumBucket(row.features.flowPremium),
    },
    {
      id: "flowSignals",
      label: "Flow signals hit",
      cuts: "Four signals: volume versus open interest, flow premium, last trade at the ask, and a same-day volume jump. The count is withheld when the jump was not stored.",
      includeTest: false,
      order: ["0 of 4 flow signals", "1 of 4 flow signals", "2 of 4 flow signals", "3 of 4 flow signals", "4 of 4 flow signals"],
      bucketOf: (row) => row.features.flowSignalCount == null ? null : `${row.features.flowSignalCount} of 4 flow signals`,
    },
    {
      id: "volOi",
      label: "Volume / open interest",
      cuts: `${ALERT_RULES.strongVolOiRatio}× is a flow signal. ${ALERT_RULES.aGradeVolOiRatio}× is required for an A.`,
      includeTest: false,
      order: ["Under 1× open interest", "1× to under 2× open interest", "2× open interest or more"],
      bucketOf: (row) => volOiBucket(row.features.volOiRatio),
    },
    {
      id: "dte",
      label: "Days to expiry",
      cuts: `${dteMin}–${dteMax} is the A/B window, split at 27 so the two halves can be compared. ${EXPERIMENT_DTE.min}–${EXPERIMENT_DTE.max} is the test. That split is not a new rule.`,
      includeTest: true,
      order: ["Under 14 days", "14–27 days", "28–42 days", "43–60 days (test)", "Over 60 days"],
      bucketOf: dteBucket,
    },
    {
      id: "moneyness",
      label: "Moneyness",
      cuts: `An A wants the strike within ${Math.round(ALERT_RULES.idealOtmFraction * 100)}% out of the money, or within ${Math.round(ALERT_RULES.maxItmFraction * 100)}% in the money. A TAKE allows ${Math.round(ALERT_RULES.acceptableOtmFraction * 100)}% out.`,
      includeTest: false,
      order: [
        "In the money, within 3%",
        "In the money, beyond 3%",
        "Out of the money, within 5%",
        "Out of the money, over 5% through 10%",
        "Out of the money, beyond 10%",
      ],
      bucketOf: (row) => moneynessBucket(row.features),
    },
    {
      id: "spread",
      label: "Bid-ask spread",
      cuts: "2% of mid is the scanner's tight spread. 5% of mid is the Gate maximum.",
      includeTest: false,
      order: ["2% or tighter", "Over 2% through 5%", "Over 5%"],
      bucketOf: (row) => spreadBucket(row.features.spreadFraction),
    },
    {
      id: "iv",
      label: "Implied vol",
      cuts: "Ranges of the stored implied vol. The checklist does not grade on IV. Missing IV is left out.",
      includeTest: false,
      order: ["IV under 30%", "IV 30% to under 60%", "IV 60% or more"],
      bucketOf: (row) => ivBucket(row.features.iv),
    },
    {
      id: "volumeJump",
      label: "Same-day volume jump",
      cuts: `${ALERT_RULES.strongVolumeJump} contracts since the last scan is a flow signal. Older alerts did not store the jump, so they are left out.`,
      includeTest: false,
      order: ["Volume jump under 100", "Volume jump of 100 or more"],
      bucketOf: (row) => jumpBucket(row.features.volumeJump),
    },
    {
      id: "level",
      label: "Distance to the next level",
      cuts: "The same room and reward-to-risk cuts the checklist uses. Missing levels are left out.",
      includeTest: false,
      order: ["Tight to the next level", "Poor reward versus the other way", "Room to the next level"],
      bucketOf: (row) => levelBucket(row.features.rewardDistance, row.features.riskDistance),
    },
    {
      id: "earnings",
      label: "Earnings proximity",
      cuts: "Read from the earnings line stored on the alert. A line that does not match a known phrase is left out.",
      includeTest: false,
      order: ["Earnings on or before expiration", "Earnings after expiration", "No earnings date listed"],
      bucketOf: (row) => earningsBucket(row.features.earnings),
    },
    {
      id: "side",
      label: "Estimated side",
      cuts: "Estimated at the ask is the flow signal. The other labels are what the alert stored.",
      includeTest: false,
      order: ["estimated at ask", "estimated at bid", "estimated mid", "estimated unknown"],
      bucketOf: (row) => row.features.side,
    },
    {
      id: "right",
      label: "Call or put",
      cuts: "The stored call or put.",
      includeTest: false,
      order: ["Call", "Put"],
      bucketOf: (row) => row.putCall === "put" ? "Put" : "Call",
    },
    {
      id: "ticker",
      label: "Ticker",
      cuts: "Each stored ticker. A one-name bucket is still too few to trust.",
      includeTest: false,
      order: null,
      bucketOf: (row) => row.ticker,
    },
    {
      id: "timeOfDay",
      label: "Time of day",
      cuts: "America/Chicago clock time when the alert or paper trade was opened.",
      includeTest: false,
      order: ["8:30–10:00 Central", "10:00–12:00 Central", "12:00–2:00 Central", "2:00–3:00 Central", "Outside the regular session"],
      bucketOf: (row) => timeBucket(row.openedAt),
    },
    {
      id: "dayOfWeek",
      label: "Day of week",
      cuts: "America/Chicago weekday when it was opened.",
      includeTest: false,
      order: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      bucketOf: (row) => chicagoClock(new Date(row.openedAt))?.weekday ?? null,
    },
  ];
}

function checkSpecs(trades: readonly LearnTrade[]): FactorSpec[] {
  const ids: string[] = [];
  const labels = new Map<string, string>();
  for (let i = 0; i < trades.length; i++) {
    const checks = trades[i].checks;
    if (!checks) continue;
    for (let j = 0; j < checks.length; j++) {
      const check = checks[j];
      if (!labels.has(check.id)) {
        labels.set(check.id, check.label);
        ids.push(check.id);
      }
    }
  }
  return ids.map((id) => ({
    id: `check:${id}`,
    label: `Grade check: ${labels.get(id) ?? id}`,
    cuts: "Pass or fail as saved on the paper trade. Unknown is left out. This does not change the check.",
    includeTest: false,
    order: ["Pass", "Fail"],
    bucketOf: (row) => checkBucket(row.checks, id),
  }));
}

function buildFactor(spec: FactorSpec, trades: readonly LearnTrade[]): LearnFactor {
  const buckets: Array<LearnBucket & { winDollars: number; lossDollars: number }> = [];
  let excludedUnknown = 0;
  for (let i = 0; i < trades.length; i++) {
    const row = trades[i];
    if (row.cohort === "experiment" && !spec.includeTest) continue;
    const key = spec.bucketOf(row);
    if (key == null) {
      excludedUnknown += 1;
      continue;
    }
    addBucket(buckets, key, row.pnlDollars, row.result);
  }
  const published = buckets.map(publishBucket);
  published.sort((a, b) => {
    if (spec.order) {
      const ai = spec.order.indexOf(a.key);
      const bi = spec.order.indexOf(b.key);
      const ao = ai < 0 ? 99 : ai;
      const bo = bi < 0 ? 99 : bi;
      if (ao !== bo) return ao - bo;
    }
    return b.count - a.count || a.label.localeCompare(b.label);
  });
  const gap = gapOf(published);
  const included = published.reduce((sum, bucket) => sum + bucket.count, 0);
  return {
    id: spec.id,
    label: spec.label,
    cuts: spec.cuts,
    included,
    excludedUnknown,
    buckets: published,
    winRateGap: gap.gap,
    bestLabel: gap.best?.label ?? null,
    worstLabel: gap.worst?.label ?? null,
    tooFew: included < LEARN_MIN_TRUST || published.every((bucket) => bucket.tooFew),
    rank: 0,
  };
}

function summaryLines(report: LearnReport): string[] {
  const lines: string[] = [];
  if (report.resolved === 0 && report.testResolved === 0) {
    lines.push("No resolved shadows or closed paper trades yet. Learning mode waits for a close. It does not invent results.");
    lines.push("New alerts save the grading inputs at send time. Older alerts stay unknown where those inputs were not stored.");
    lines.push(`Fewer than ${LEARN_MIN_TRUST} resolved results is too few to trust. ${ESTIMATE_NOTE}`);
    return lines;
  }
  lines.push(`${report.resolved} resolved alerts and paper trades: ${report.wins} wins, ${report.losses} losses, ${report.flats} flat. ${report.testResolved} resolved test shadows (43–60 days).`);
  if (report.resolved < LEARN_MIN_TRUST) {
    lines.push(`${report.resolved} resolved results. Fewer than ${LEARN_MIN_TRUST} is too few to trust.`);
  }
  lines.push(ESTIMATE_NOTE);
  const right = report.factors.find((factor) => factor.id === "right");
  const sideLine = right ? sideSentence(right) : null;
  if (sideLine) lines.push(sideLine);
  const grade = report.factors.find((factor) => factor.id === "grade");
  const gradeLine = grade ? gradeSentence(grade) : null;
  if (gradeLine) lines.push(gradeLine);
  const dte = report.factors.find((factor) => factor.id === "dte");
  if (dte) lines.push(dteSentence(dte, report.testResolved));
  const widest = report.factors.find((factor) => factor.winRateGap != null && factor.bestLabel && factor.worstLabel);
  if (widest) lines.push(gapSentence(widest));
  if (report.omittedShadows > 0) {
    lines.push(`${report.omittedShadows} shadow${report.omittedShadows === 1 ? "" : "s"} matched a closed paper trade, so the paper trade is the one counted.`);
  }
  return lines;
}

function sideSentence(factor: LearnFactor): string | null {
  const put = factor.buckets.find((bucket) => bucket.key === "Put");
  const call = factor.buckets.find((bucket) => bucket.key === "Call");
  const parts: string[] = [];
  if (put && put.count > 0) parts.push(`Puts are ${forCount(put)}`);
  if (call && call.count > 0) parts.push(`calls are ${forCount(call)}`);
  if (parts.length === 0) return null;
  return `${parts.join("; ")}.`;
}

function gradeSentence(factor: LearnFactor): string | null {
  const parts: string[] = [];
  for (let i = 0; i < factor.buckets.length; i++) {
    const bucket = factor.buckets[i];
    if (bucket.count === 0) continue;
    parts.push(`Grade ${bucket.label} is ${forCount(bucket)}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join("; ")}.`;
}

function dteSentence(factor: LearnFactor, testResolved: number): string {
  const test = factor.buckets.find((bucket) => bucket.key === "43–60 days (test)");
  const early = factor.buckets.find((bucket) => bucket.key === "14–27 days");
  const late = factor.buckets.find((bucket) => bucket.key === "28–42 days");
  const window = mergeBuckets(early, late);
  const testText = test && test.count > 0
    ? `Test 43–60 DTE is ${forCount(test)}`
    : `Test 43–60 DTE has ${testResolved} resolved results`;
  const windowText = window.count > 0
    ? `The 14–42 day window is ${forCount(window)}`
    : "The 14–42 day window has no resolved results in that split yet";
  const trust = (test?.count ?? testResolved) < EXPERIMENT_DTE.minTrust
    ? ` Fewer than ${EXPERIMENT_DTE.minTrust} test results is too few to consider widening that window.`
    : " That is enough test results to describe, and it is still not a reason to change the rule.";
  return `${testText}. ${windowText}.${trust} The 14–42 day rule is unchanged.`;
}

function gapSentence(factor: LearnFactor): string {
  const best = factor.buckets.find((bucket) => bucket.label === factor.bestLabel);
  const worst = factor.buckets.find((bucket) => bucket.label === factor.worstLabel);
  if (!best || !worst) return "";
  const small = best.count < LEARN_MIN_TRUST || worst.count < LEARN_MIN_TRUST;
  const trust = small ? " Too few to trust." : "";
  return `The widest win-rate gap so far is ${factor.label}: ${best.label} is ${forCount(best)}, and ${worst.label} is ${forCount(worst)}.${trust} This is not a proven pattern.`;
}

function suggestionLines(factors: readonly LearnFactor[]): string[] {
  const found: Array<{ factor: LearnFactor; bucket: LearnBucket; rate: number }> = [];
  for (let i = 0; i < factors.length; i++) {
    const factor = factors[i];
    if (factor.buckets.length < 2) continue;
    for (let j = 0; j < factor.buckets.length; j++) {
      const bucket = factor.buckets[j];
      const decided = bucket.wins + bucket.losses;
      if (bucket.count < 5 || decided < 5) continue;
      if (bucket.losses <= bucket.wins) continue;
      found.push({ factor, bucket, rate: bucket.losses / decided });
    }
  }
  found.sort((a, b) => b.rate - a.rate || b.bucket.count - a.bucket.count);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < found.length && lines.length < 3; i++) {
    const item = found[i];
    if (seen.has(item.factor.id)) continue;
    seen.add(item.factor.id);
    const decided = item.bucket.wins + item.bucket.losses;
    const verb = item.factor.id === "spread"
      ? "Consider tightening the spread filter."
      : "Consider whether that group should be filtered.";
    let line = `${item.bucket.label} lost ${item.bucket.losses} of ${decided} (${item.factor.label}). ${verb} Suggestion only. This does not change grading rules, thresholds, or the $${MAX_LOSS_DOLLARS} cap.`;
    if (item.bucket.count < LEARN_MIN_TRUST) line = `Too few to trust. ${line}`;
    if (item.factor.id === "dte" && item.bucket.key.includes("43")) {
      line += " The 14–42 day rule is unchanged.";
    }
    lines.push(line);
  }
  if (lines.length === 0) {
    lines.push("No suggestion yet. A suggestion needs a bucket with at least 5 resolved results and more losses than wins. Even then it would not change a rule.");
  }
  return lines;
}

function dteBucket(row: LearnTrade): string | null {
  if (row.cohort === "experiment") return "43–60 days (test)";
  const dte = row.features.dte;
  if (dte == null) return null;
  if (dte < ALERT_RULES.alertDteMin) return "Under 14 days";
  if (dte <= 27) return "14–27 days";
  if (dte <= ALERT_RULES.alertDteMax) return "28–42 days";
  if (dte >= EXPERIMENT_DTE.min && dte <= EXPERIMENT_DTE.max) return "43–60 days (test)";
  return "Over 60 days";
}

function premiumBucket(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < ALERT_RULES.bMinFlowPremium) return "Under $50,000";
  if (value < ALERT_RULES.aMinFlowPremium) return "$50,000 to under $100,000";
  if (value < ALERT_RULES.strongNotional) return "$100,000 to under $250,000";
  return "$250,000 or more";
}

function volOiBucket(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < ALERT_RULES.strongVolOiRatio) return "Under 1× open interest";
  if (value < ALERT_RULES.aGradeVolOiRatio) return "1× to under 2× open interest";
  return "2× open interest or more";
}

function moneynessBucket(features: AlertFeatureSnapshot): string | null {
  if (features.otm == null) return null;
  if (!features.otm) {
    if (features.itmFraction == null) return null;
    if (features.itmFraction <= ALERT_RULES.maxItmFraction) return "In the money, within 3%";
    return "In the money, beyond 3%";
  }
  if (features.otmFraction == null) return null;
  if (features.otmFraction <= ALERT_RULES.idealOtmFraction) return "Out of the money, within 5%";
  if (features.otmFraction <= ALERT_RULES.acceptableOtmFraction) return "Out of the money, over 5% through 10%";
  return "Out of the money, beyond 10%";
}

function spreadBucket(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0.02) return "2% or tighter";
  if (value <= MAX_BID_ASK_SPREAD_OF_MID) return "Over 2% through 5%";
  return "Over 5%";
}

function ivBucket(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const pct = value <= 3 ? value * 100 : value;
  if (pct < 30) return "IV under 30%";
  if (pct < 60) return "IV 30% to under 60%";
  return "IV 60% or more";
}

function jumpBucket(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= ALERT_RULES.strongVolumeJump) return "Volume jump of 100 or more";
  return "Volume jump under 100";
}

function earningsBucket(value: AlertFeatureSnapshot["earnings"]): string | null {
  if (value === "unknown") return null;
  if (value === "inside") return "Earnings on or before expiration";
  if (value === "after") return "Earnings after expiration";
  return "No earnings date listed";
}

function timeBucket(openedAt: number): string | null {
  const clock = chicagoClock(new Date(openedAt));
  if (!clock) return null;
  const minutes = clock.minutes;
  if (minutes < 8 * 60 + 30 || minutes >= 15 * 60) return "Outside the regular session";
  if (minutes < 10 * 60) return "8:30–10:00 Central";
  if (minutes < 12 * 60) return "10:00–12:00 Central";
  if (minutes < 14 * 60) return "12:00–2:00 Central";
  return "2:00–3:00 Central";
}

function checkBucket(checks: readonly LearnCheck[] | null, id: string): string | null {
  if (!checks) return null;
  for (let i = 0; i < checks.length; i++) {
    if (checks[i].id !== id) continue;
    if (checks[i].status === "pass") return "Pass";
    if (checks[i].status === "fail") return "Fail";
    return null;
  }
  return null;
}

function forCount(bucket: { wins: number; losses: number; flats: number }): string {
  const decided = bucket.wins + bucket.losses;
  const core = `${bucket.wins} for ${decided}`;
  if (bucket.flats > 0) return `${core}, plus ${bucket.flats} flat`;
  return core;
}

function mergeBuckets(left: LearnBucket | undefined, right: LearnBucket | undefined): LearnBucket {
  const count = (left?.count ?? 0) + (right?.count ?? 0);
  const wins = (left?.wins ?? 0) + (right?.wins ?? 0);
  const losses = (left?.losses ?? 0) + (right?.losses ?? 0);
  const flats = (left?.flats ?? 0) + (right?.flats ?? 0);
  return {
    key: "14–42",
    label: "14–42 days",
    count,
    wins,
    losses,
    flats,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    averageWin: null,
    averageLoss: null,
    totalPnl: (left?.totalPnl ?? 0) + (right?.totalPnl ?? 0),
    averagePnl: null,
    tooFew: count < LEARN_MIN_TRUST,
  };
}

function gapOf(buckets: readonly LearnBucket[]): { gap: number | null; best: LearnBucket | null; worst: LearnBucket | null } {
  const decided = buckets.filter((bucket) => bucket.winRate != null && bucket.wins + bucket.losses > 0);
  if (decided.length < 2) return { gap: null, best: null, worst: null };
  let best = decided[0];
  let worst = decided[0];
  for (let i = 1; i < decided.length; i++) {
    const bucket = decided[i];
    if ((bucket.winRate ?? 0) > (best.winRate ?? 0)) best = bucket;
    if ((bucket.winRate ?? 0) < (worst.winRate ?? 0)) worst = bucket;
  }
  if (best.key === worst.key) return { gap: null, best: null, worst: null };
  return { gap: (best.winRate ?? 0) - (worst.winRate ?? 0), best, worst };
}

function bySeparation(a: LearnFactor, b: LearnFactor): number {
  const ag = a.winRateGap == null ? -1 : a.winRateGap;
  const bg = b.winRateGap == null ? -1 : b.winRateGap;
  if (bg !== ag) return bg - ag;
  if (b.included !== a.included) return b.included - a.included;
  return a.label.localeCompare(b.label);
}

function tally(rows: readonly LearnTrade[]): { count: number; wins: number; losses: number; flats: number; pnl: number } {
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let pnl = 0;
  for (let i = 0; i < rows.length; i++) {
    pnl += rows[i].pnlDollars;
    if (rows[i].result === "win") wins += 1;
    else if (rows[i].result === "loss") losses += 1;
    else flats += 1;
  }
  return { count: rows.length, wins, losses, flats, pnl };
}

function countOpenTests(shadows: readonly ShadowTrade[]): number {
  let open = 0;
  for (let i = 0; i < shadows.length; i++) {
    if (shadows[i].status === "open" && isExperimentShadow(shadows[i])) open += 1;
  }
  return open;
}

function findShadow(shadows: readonly ShadowTrade[], alertId: string | null): ShadowTrade | null {
  if (!alertId) return null;
  for (let i = 0; i < shadows.length; i++) {
    if (shadows[i].alertId === alertId) return shadows[i];
  }
  return null;
}

function resultOf(pnl: number): "win" | "loss" | "flat" {
  if (Math.abs(pnl) < TRADE_RULES.flatAbsDollars) return "flat";
  return pnl > 0 ? "win" : "loss";
}

function movePct(entry: number, price: number): number | null {
  if (!(entry > 0) || !Number.isFinite(price)) return null;
  return (price - entry) / entry;
}

interface RawBucket extends LearnBucket {
  winDollars: number;
  lossDollars: number;
}

function addBucket(buckets: RawBucket[], key: string, pnl: number, result: "win" | "loss" | "flat"): void {
  let bucket: RawBucket | null = null;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].key === key) {
      bucket = buckets[i];
      break;
    }
  }
  if (!bucket) {
    bucket = {
      key,
      label: key,
      count: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      winRate: null,
      averageWin: null,
      averageLoss: null,
      totalPnl: 0,
      averagePnl: null,
      tooFew: true,
      winDollars: 0,
      lossDollars: 0,
    };
    buckets.push(bucket);
  }
  bucket.count += 1;
  bucket.totalPnl += pnl;
  if (result === "win") {
    bucket.wins += 1;
    bucket.winDollars += pnl;
  } else if (result === "loss") {
    bucket.losses += 1;
    bucket.lossDollars += Math.abs(pnl);
  } else {
    bucket.flats += 1;
  }
  const decided = bucket.wins + bucket.losses;
  bucket.winRate = decided > 0 ? bucket.wins / decided : null;
  bucket.averageWin = bucket.wins > 0 ? bucket.winDollars / bucket.wins : null;
  bucket.averageLoss = bucket.losses > 0 ? bucket.lossDollars / bucket.losses : null;
  bucket.averagePnl = bucket.count > 0 ? bucket.totalPnl / bucket.count : null;
  bucket.tooFew = bucket.count < LEARN_MIN_TRUST;
}

function publishBucket(bucket: RawBucket): LearnBucket {
  return {
    key: bucket.key,
    label: bucket.label,
    count: bucket.count,
    wins: bucket.wins,
    losses: bucket.losses,
    flats: bucket.flats,
    winRate: bucket.winRate,
    averageWin: bucket.averageWin,
    averageLoss: bucket.averageLoss,
    totalPnl: bucket.totalPnl,
    averagePnl: bucket.averagePnl,
    tooFew: bucket.tooFew,
  };
}

function parseChecks(value: unknown): LearnCheck[] {
  if (!Array.isArray(value)) return [];
  const checks: LearnCheck[] = [];
  for (let i = 0; i < value.length && checks.length < 24; i++) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    const record = row as { id?: unknown; label?: unknown; status?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(id)) continue;
    const status = record.status === "pass" || record.status === "fail" || record.status === "unknown"
      ? record.status
      : null;
    if (!status) continue;
    const label = typeof record.label === "string" && record.label.trim()
      ? record.label.trim().slice(0, 80)
      : id;
    checks.push({ id, label, status });
  }
  return checks;
}

function num(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(Math.round(value * 1_000_000) / 1_000_000);
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}
