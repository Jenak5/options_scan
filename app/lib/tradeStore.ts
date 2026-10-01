import { loadAlertBook } from "@/app/lib/alertStore";
import type { StoredAlert } from "@/app/lib/alertBook";
import { readTradeLogText, resolveStoreKind, updateTradeLog } from "@/app/lib/schwabStore";
import {
  addTrade,
  buildTrade,
  closeTrade,
  dailyStopState,
  emptyTradeLog,
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

export async function loadTradePage(now: Date): Promise<TradePage> {
  const [log, alerts] = await Promise.all([readLog(), recentAlerts()]);
  return pageFrom(log, alerts, now, resolveStoreKind() !== "unconfigured");
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
