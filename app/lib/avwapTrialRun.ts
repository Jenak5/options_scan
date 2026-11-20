import type { CandleBar } from "@/app/lib/candleTypes";
import { newYorkDate } from "@/app/lib/flow";
import { getQuoteEntries } from "@/app/lib/marketData";
import { normalizeOptionSymbol } from "@/app/lib/optionSymbol";
import { readAvwapTrialText, resolveStoreKind, updateAvwapTrial } from "@/app/lib/schwabStore";
import { avwapSkipReason, latestGapDay } from "@/app/lib/avwapPaper";
import { loadAvwapDailyBars, loadAvwapMinuteBars } from "@/app/lib/avwapPaperRun";
import { avwapRepeatsEnabled, deliverAvwapOpenAlert } from "@/app/lib/avwapRepeatJob";
import { sendTelegramAlert } from "@/app/lib/telegram";
import {
  AVWAP_TRIAL_SYMBOLS,
  advanceAvwapTrial,
  avwapTrialSection,
  formatAvwapTrialAlert,
  parseAvwapTrialBook,
  serializeAvwapTrialBook,
  trialQuotePlan,
  type AvwapTrialMark,
  type AvwapTrialMarket,
  type AvwapTrialSection,
  type AvwapTrialSymbol,
} from "@/app/lib/avwapTrial";

/**
 * Runs after the live AVWAP book has saved, inside the same 5-minute cron.
 * No new cron. A throw is caught by the caller and logged only.
 * Open alerts use the live AVWAP repeat path. Exits do not send Telegram.
 */

export interface AvwapTrialDeps {
  daily: (symbol: string, now: Date) => Promise<CandleBar[]>;
  minutes: (symbol: string, now: Date, anchorDate: string | null) => Promise<CandleBar[]>;
  quotes: (symbols: readonly string[]) => Promise<Map<string, AvwapTrialMark>>;
  readBook: () => Promise<string | null>;
  writeBook: (change: (current: string | null) => string | null) => Promise<boolean>;
  deliver: (text: string, tradeId: string) => Promise<{ sent: boolean; saved: boolean }>;
  sendPlain: (text: string) => Promise<boolean>;
  repeatsOn: () => boolean;
}

export interface AvwapTrialRunResult {
  opened: number;
  closed: number;
  saved: boolean;
  skipped: "holiday" | "closed" | null;
  logNote: string;
}

export async function runAvwapTrial(now: Date, deps: AvwapTrialDeps = defaultDeps()): Promise<AvwapTrialRunResult> {
  const skip = avwapSkipReason(now);
  if (skip) {
    return {
      opened: 0,
      closed: 0,
      saved: true,
      skipped: skip,
      logNote: skip === "holiday" ? "market holiday" : "outside market hours",
    };
  }
  const markets: AvwapTrialMarket[] = [];
  for (let i = 0; i < AVWAP_TRIAL_SYMBOLS.length; i++) {
    markets.push(await loadMarket(AVWAP_TRIAL_SYMBOLS[i], now, deps));
  }
  const current = parseAvwapTrialBook(await deps.readBook());
  const plan = trialQuotePlan(current, markets, now);
  let quoteMap = new Map<string, AvwapTrialMark>();
  if (plan.length > 0) {
    try {
      quoteMap = await deps.quotes(plan.map((item) => item.occ));
    } catch {
      quoteMap = new Map();
    }
  }
  const quoted = markets.map((market) => attachQuotes(market, plan, quoteMap));
  let openedIds: string[] = [];
  let closedCount = 0;
  const saved = await deps.writeBook((text) => {
    const advanced = advanceAvwapTrial(parseAvwapTrialBook(text), quoted, now);
    openedIds = advanced.opened.map((trade) => trade.id);
    closedCount = advanced.closed.length;
    return serializeAvwapTrialBook(advanced.book);
  });
  if (!saved) {
    return { opened: 0, closed: 0, saved: false, skipped: null, logNote: "trial log was not saved" };
  }
  const stored = parseAvwapTrialBook(await deps.readBook());
  const opened = stored.trades.filter((trade) => openedIds.includes(trade.id));
  for (let i = 0; i < opened.length; i++) {
    const text = formatAvwapTrialAlert(opened[i]);
    if (deps.repeatsOn()) await deps.deliver(text, opened[i].id);
    else await deps.sendPlain(text);
  }
  const notes = AVWAP_TRIAL_SYMBOLS.map((symbol) => {
    const check = stored.checks[symbol];
    if (!check) return `${symbol}: not checked`;
    return `${symbol}: put ${check.put.outcome}, call ${check.call.outcome}`;
  }).join("; ");
  return { opened: opened.length, closed: closedCount, saved: true, skipped: null, logNote: notes };
}

export function formatAvwapTrialLog(result: AvwapTrialRunResult): string {
  const noun = result.opened === 1 ? "entry" : "entries";
  const skip = result.skipped === "holiday" ? " Market holiday." : result.skipped === "closed" ? " Outside market hours." : "";
  return `AVWAP trial: ${result.opened} new ${noun}, ${result.closed} closed (${result.saved ? "saved" : "not saved"}, PAPER ONLY).${skip} ${result.logNote}`.replace(/[ \t]+/g, " ").trim();
}

export async function loadAvwapTrialSection(): Promise<AvwapTrialSection> {
  const text = await readAvwapTrialText();
  return avwapTrialSection(parseAvwapTrialBook(text), resolveStoreKind() !== "unconfigured");
}

async function loadMarket(symbol: AvwapTrialSymbol, now: Date, deps: AvwapTrialDeps): Promise<AvwapTrialMarket> {
  try {
    const dailyBars = await deps.daily(symbol, now);
    const daily = dailyBars.map((bar) => ({ t: bar.t, open: bar.o, close: bar.c }));
    const gap = latestGapDay(daily, newYorkDate(now));
    const bars = await deps.minutes(symbol, now, gap?.date ?? null);
    return { symbol, daily, bars, historyFailed: false, quotes: [] };
  } catch {
    return { symbol, daily: [], bars: [], historyFailed: true, quotes: [] };
  }
}

function attachQuotes(
  market: AvwapTrialMarket,
  plan: readonly { occ: string; symbol: AvwapTrialSymbol; expiration: string; strike: number; putCall: AvwapTrialMark["putCall"] }[],
  quotes: ReadonlyMap<string, AvwapTrialMark>,
): AvwapTrialMarket {
  const marks: AvwapTrialMark[] = [];
  for (let i = 0; i < plan.length; i++) {
    const request = plan[i];
    if (request.symbol !== market.symbol) continue;
    const quote = quotes.get(normalizeOptionSymbol(request.occ));
    if (!quote) continue;
    marks.push({
      expiration: request.expiration,
      strike: request.strike,
      bid: quote.bid,
      ask: quote.ask,
      putCall: request.putCall,
    });
  }
  return { ...market, quotes: marks };
}

function defaultDeps(): AvwapTrialDeps {
  return {
    daily: loadAvwapDailyBars,
    minutes: loadAvwapMinuteBars,
    quotes: loadTrialQuotes,
    readBook: readAvwapTrialText,
    writeBook: updateAvwapTrial,
    deliver: deliverAvwapOpenAlert,
    sendPlain: (message) => sendTelegramAlert(message, "avwap"),
    repeatsOn: avwapRepeatsEnabled,
  };
}

async function loadTrialQuotes(symbols: readonly string[]): Promise<Map<string, AvwapTrialMark>> {
  const map = new Map<string, AvwapTrialMark>();
  if (symbols.length === 0) return map;
  const read = await getQuoteEntries(symbols.slice());
  for (let i = 0; i < read.entries.length; i++) {
    const entry = read.entries[i];
    const contract = entry.contract;
    const putCall = contract.putCall === "call" || contract.putCall === "put" ? contract.putCall : null;
    if (!putCall || !(contract.ask >= 0) || !(contract.bid >= 0)) continue;
    map.set(normalizeOptionSymbol(entry.symbol), {
      expiration: contract.expiration,
      strike: contract.strike,
      bid: contract.bid,
      ask: contract.ask,
      putCall,
    });
  }
  return map;
}
