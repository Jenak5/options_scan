import { loadAlertBook } from "@/app/lib/alertStore";
import type { StoredAlert } from "@/app/lib/alertBook";
import { notionalPremium } from "@/app/lib/flow";
import { readTradeLogText, resolveStoreKind, updateTradeLog } from "@/app/lib/schwabStore";
import {
  addTrade,
  buildTrade,
  closeTrade,
  DAILY_STOP_PAPER_MESSAGE,
  dailyStopState,
  emptyTradeLog,
  findOpenTradeForAlert,
  paperCostError,
  parseTradeLog,
  removeTrade,
  summarizeTrades,
  tradeMetrics,
  tradesToCsv,
  weeklyFlagSentence,
  weeklySummary,
  type DailyStopState,
  type OpenTradeInput,
  type StoredTrade,
  type TradeLog,
  type TradeMetrics,
  type TradeStats,
  type WeeklySummary,
} from "@/app/lib/trades";

/**
 * Manual trade log on the same private store as alerts.
 * No new environment variable. An unconfigured store does not pretend a trade was saved.
 */

const STORE_MESSAGE = "The private store is not configured, so the trade was not saved. It uses the same KV, Upstash, or Blob store as alerts. Nothing new to set.";

export interface TradeView extends StoredTrade {
  metrics: TradeMetrics;
}

export interface AlertChoice {
  id: string;
  label: string;
}

export interface TradePage {
  trades: TradeView[];
  stats: TradeStats;
  stop: DailyStopState;
  weekly: WeeklySummary;
  weeklyNote: string | null;
  alerts: AlertChoice[];
  stored: boolean;
}

/** What the Trade Log shows before she taps Record on a Telegram link. */
export interface PaperPreview {
  alertId: string;
  found: boolean;
  ticker: string;
  putCall: "call" | "put" | null;
  strike: number | null;
  expiration: string;
  grade: string | null;
  verdict: string | null;
  flowPremium: number | null;
  entryPrice: number | null;
  oneContractCost: number | null;
  blocked: string | null;
  openTradeId: string | null;
}

export interface PaperOpenResult {
  page: TradePage;
  alreadyOpen: boolean;
  focusAlertId: string | null;
}

export async function loadTradePage(now: Date): Promise<TradePage> {
  const [log, alerts] = await Promise.all([readLog(), recentAlerts()]);
  return pageFrom(log, alerts, now, resolveStoreKind() !== "unconfigured");
}

export async function paperPreviewForAlert(alertId: string, now: Date): Promise<PaperPreview> {
  const id = alertId.trim();
  const [book, log] = await Promise.all([loadAlertBook(), readLog()]);
  const alert = findAlert(book.records, id);
  const open = findOpenTradeForAlert(log.trades, id);
  if (!alert) {
    return {
      alertId: id,
      found: false,
      ticker: "",
      putCall: null,
      strike: null,
      expiration: "",
      grade: null,
      verdict: null,
      flowPremium: null,
      entryPrice: null,
      oneContractCost: null,
      blocked: "That alert is not in the book yet. Refresh once the scanner has saved it.",
      openTradeId: open?.id ?? null,
    };
  }
  const premium = notionalPremium(alert.volume, alert.mid);
  const one = alert.ask > 0 ? alert.ask * 100 : null;
  const gradeOk = alert.grade === "A" || alert.grade === "B";
  const cost = paperCostError(alert.ask, 1);
  const stopped = dailyStopState(log.trades, now).dailyStop && open == null;
  return {
    alertId: alert.id,
    found: true,
    ticker: alert.ticker,
    putCall: alert.putCall,
    strike: alert.strike,
    expiration: alert.expiration,
    grade: alert.grade,
    verdict: alert.verdict,
    flowPremium: premium,
    entryPrice: alert.ask,
    oneContractCost: one,
    blocked: open
      ? null
      : !gradeOk
        ? "Paper trade is for an A or a B alert."
        : stopped
          ? DAILY_STOP_PAPER_MESSAGE
          : cost,
    openTradeId: open?.id ?? null,
  };
}

export async function openPaperLoggedTrade(
  input: {
    alertId?: string | null;
    ticker?: string;
    putCall?: string;
    strike?: number;
    expiration?: string;
    ask?: number;
    grade?: string | null;
    verdict?: string | null;
    flowPremium?: number | null;
    contracts?: number;
  },
  now: Date,
): Promise<{ ok: true } & PaperOpenResult | { ok: false; error: string }> {
  const contracts = input.contracts == null ? 1 : input.contracts;
  const book = await loadAlertBook();
  const alert = resolvePaperAlert(book.records, input);
  if (input.alertId?.trim() && !alert) return { ok: false, error: "That alert is not in the book." };
  const drafted = alert ? draftFromAlert(alert) : draftFromFields(input);
  if (!drafted.ok) return drafted;
  if (drafted.grade !== "A" && drafted.grade !== "B") {
    return { ok: false, error: "Paper trade is for an A or a B alert." };
  }
  const cost = paperCostError(drafted.ask, contracts);
  if (cost) return { ok: false, error: cost };

  const held: { already: StoredTrade | null; error: string | null; blocked: string | null } = {
    already: null,
    error: null,
    blocked: null,
  };
  const saved = await updateTradeLog((current) => {
    const log = parseTradeLog(current);
    const open = drafted.alertId ? findOpenTradeForAlert(log.trades, drafted.alertId) : findOpenContract(log.trades, drafted);
    if (open) {
      held.already = open;
      return JSON.stringify(log);
    }
    if (dailyStopState(log.trades, now).dailyStop) {
      held.blocked = DAILY_STOP_PAPER_MESSAGE;
      return JSON.stringify(log);
    }
    const built = buildTrade({
      ticker: drafted.ticker,
      putCall: drafted.putCall,
      strike: drafted.strike,
      expiration: drafted.expiration,
      contracts,
      entryPrice: drafted.ask,
      structure: "single",
      alertId: drafted.alertId,
      alertVerdict: drafted.verdict,
      alertGrade: drafted.grade,
      flowPremium: drafted.flowPremium,
      entryPriceSource: "ask",
    }, newTradeId(), now);
    if (!built.ok) {
      held.error = built.error;
      return JSON.stringify(log);
    }
    return JSON.stringify(addTrade(log, built.trade));
  });
  if (!saved) return { ok: false, error: STORE_MESSAGE };
  if (held.blocked) return { ok: false, error: held.blocked };
  if (held.error) return { ok: false, error: held.error };
  return {
    ok: true,
    page: await loadTradePage(now),
    alreadyOpen: held.already != null,
    focusAlertId: held.already ? held.already.alertId : drafted.alertId,
  };
}

export async function openLoggedTrade(input: OpenTradeInput, now: Date): Promise<{ ok: true; page: TradePage } | { ok: false; error: string }> {
  const linked = await attachAlert(input);
  const built = buildTrade(linked, newTradeId(), now);
  if (!built.ok) return built;
  let error: string | null = null;
  const saved = await updateTradeLog((current) => {
    const log = parseTradeLog(current);
    if (log.trades.some((trade) => trade.id === built.trade.id)) {
      error = "That trade id is already in the log";
      return JSON.stringify(log);
    }
    return JSON.stringify(addTrade(log, built.trade));
  });
  if (!saved) return { ok: false, error: error ?? STORE_MESSAGE };
  if (error) return { ok: false, error };
  return { ok: true, page: await loadTradePage(now) };
}

export async function closeLoggedTrade(
  id: string,
  input: { exitPrice: number; closedAt?: number; exitNote?: string | null },
  now: Date,
): Promise<{ ok: true; page: TradePage } | { ok: false; error: string }> {
  let error: string | null = null;
  const saved = await updateTradeLog((current) => {
    const result = closeTrade(parseTradeLog(current), id, input, now);
    if (!result.ok) {
      error = result.error;
      return current ?? JSON.stringify(emptyTradeLog());
    }
    return JSON.stringify(result.log);
  });
  if (!saved) return { ok: false, error: STORE_MESSAGE };
  if (error) return { ok: false, error };
  return { ok: true, page: await loadTradePage(now) };
}

export async function removeLoggedTrade(id: string, now: Date): Promise<{ ok: true; page: TradePage } | { ok: false; error: string }> {
  let error: string | null = null;
  const saved = await updateTradeLog((current) => {
    const result = removeTrade(parseTradeLog(current), id);
    if (!result.ok) {
      error = result.error;
      return current ?? JSON.stringify(emptyTradeLog());
    }
    return JSON.stringify(result.log);
  });
  if (!saved) return { ok: false, error: STORE_MESSAGE };
  if (error) return { ok: false, error };
  return { ok: true, page: await loadTradePage(now) };
}

export async function tradeLogCsv(): Promise<string> {
  const log = await readLog();
  return tradesToCsv(log.trades);
}

export async function riskStatusFromTrades(now: Date): Promise<{ stop: DailyStopState; weekly: WeeklySummary; weeklyNote: string | null }> {
  const log = await readLog();
  const weekly = weeklySummary(log.trades, now);
  return { stop: dailyStopState(log.trades, now), weekly, weeklyNote: weeklyFlagSentence(weekly) };
}

async function readLog(): Promise<TradeLog> {
  return parseTradeLog(await readTradeLogText());
}

async function recentAlerts(): Promise<AlertChoice[]> {
  const book = await loadAlertBook();
  const records = book.records.slice().sort((a, b) => b.sentAt - a.sentAt);
  const choices: AlertChoice[] = [];
  for (let i = 0; i < records.length && choices.length < 40; i++) {
    choices.push({ id: records[i].id, label: alertLabel(records[i]) });
  }
  return choices;
}

async function attachAlert(input: OpenTradeInput): Promise<OpenTradeInput> {
  const alertId = input.alertId?.trim() ?? "";
  if (!alertId) return { ...input, alertId: null, alertVerdict: null, alertGrade: null };
  const book = await loadAlertBook();
  const found = findAlert(book.records, alertId);
  if (!found) return { ...input, alertId, alertVerdict: null, alertGrade: null };
  return { ...input, alertId: found.id, alertVerdict: found.verdict, alertGrade: found.grade };
}

function pageFrom(log: TradeLog, alerts: AlertChoice[], now: Date, stored: boolean): TradePage {
  const trades = log.trades
    .slice()
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((trade) => ({ ...trade, metrics: tradeMetrics(trade) }));
  const weekly = weeklySummary(log.trades, now);
  return {
    trades,
    stats: summarizeTrades(log.trades, now),
    stop: dailyStopState(log.trades, now),
    weekly,
    weeklyNote: weeklyFlagSentence(weekly),
    alerts,
    stored,
  };
}

interface PaperDraft {
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  ask: number;
  grade: "A" | "B" | "C" | "D" | null;
  verdict: string | null;
  flowPremium: number | null;
  alertId: string | null;
}

function resolvePaperAlert(
  records: readonly StoredAlert[],
  input: { alertId?: string | null; ticker?: string; putCall?: string; strike?: number; expiration?: string },
): StoredAlert | null {
  const alertId = input.alertId?.trim() ?? "";
  if (alertId) return findAlert(records, alertId);
  const ticker = (input.ticker ?? "").trim().toUpperCase();
  const putCall = (input.putCall ?? "").trim().toLowerCase();
  const expiration = (input.expiration ?? "").slice(0, 10);
  const strike = input.strike;
  if (!ticker || (putCall !== "call" && putCall !== "put") || !expiration || strike == null) return null;
  let found: StoredAlert | null = null;
  for (let i = 0; i < records.length; i++) {
    const alert = records[i];
    if (alert.ticker !== ticker || alert.putCall !== putCall) continue;
    if (alert.expiration.slice(0, 10) !== expiration) continue;
    if (Math.abs(alert.strike - strike) >= 0.001) continue;
    if (!found || alert.sentAt >= found.sentAt) found = alert;
  }
  return found;
}

function draftFromAlert(alert: StoredAlert): { ok: true } & PaperDraft {
  return {
    ok: true,
    ticker: alert.ticker,
    putCall: alert.putCall,
    strike: alert.strike,
    expiration: alert.expiration,
    ask: alert.ask,
    grade: alert.grade,
    verdict: alert.verdict,
    flowPremium: notionalPremium(alert.volume, alert.mid),
    alertId: alert.id,
  };
}

function draftFromFields(input: {
  ticker?: string;
  putCall?: string;
  strike?: number;
  expiration?: string;
  ask?: number;
  grade?: string | null;
  verdict?: string | null;
  flowPremium?: number | null;
}): { ok: true } & PaperDraft | { ok: false; error: string } {
  const ticker = (input.ticker ?? "").trim().toUpperCase();
  const putCall = (input.putCall ?? "").trim().toLowerCase();
  if (!ticker || (putCall !== "call" && putCall !== "put")) {
    return { ok: false, error: "That contract is missing a ticker or call/put." };
  }
  if (input.strike == null || !Number.isFinite(input.strike)) {
    return { ok: false, error: "That contract is missing a strike." };
  }
  const grade = input.grade === "A" || input.grade === "B" || input.grade === "C" || input.grade === "D" ? input.grade : null;
  return {
    ok: true,
    ticker,
    putCall,
    strike: input.strike,
    expiration: input.expiration ?? "",
    ask: input.ask ?? Number.NaN,
    grade,
    verdict: input.verdict ?? null,
    flowPremium: input.flowPremium ?? null,
    alertId: null,
  };
}

function findOpenContract(trades: readonly StoredTrade[], draft: PaperDraft): StoredTrade | null {
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.closedAt != null) continue;
    if (trade.ticker !== draft.ticker || trade.putCall !== draft.putCall) continue;
    if (trade.expiration !== draft.expiration.slice(0, 10)) continue;
    if (Math.abs(trade.strike - draft.strike) >= 0.001) continue;
    return trade;
  }
  return null;
}

function findAlert(records: readonly StoredAlert[], id: string): StoredAlert | null {
  for (let i = 0; i < records.length; i++) {
    if (records[i].id === id) return records[i];
  }
  return null;
}

function alertLabel(alert: StoredAlert): string {
  return `${alert.ticker} ${alert.putCall.toUpperCase()} $${alert.strike} ${alert.expiration} · ${alert.verdict} ${alert.grade}`;
}

function newTradeId(): string {
  return `t_${crypto.randomUUID().replace(/-/g, "")}`;
}
