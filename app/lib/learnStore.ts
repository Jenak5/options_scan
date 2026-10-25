import { parseAlertBook } from "@/app/lib/alertBook";
import { LEARN_CANDLE_BUDGET_MS, loadCandleSummaries } from "@/app/lib/candleStore";
import { analyzeLearning, learningCsv, readGradeChecks, type LearnReport } from "@/app/lib/learn";
import type { ResearchTrack } from "@/app/lib/researchTrack";
import { readAlertBookText, readShadowBookText, readTradeLogText, resolveStoreKind } from "@/app/lib/schwabStore";
import { contractKey, excludedFromMainTotals, parseShadowBook, type ShadowTrade } from "@/app/lib/shadow";
import { parseTradeLog } from "@/app/lib/trades";

/**
 * Learning mode reads the alert book, the shadow book, and the trade log.
 * It does not quote Schwab and it does not write a rule.
 */

export interface LearnPage extends LearnReport {
  stored: boolean;
}

const LEARN_GRADES = ["A", "B", "C", "D"];

/** Comma-separated letters. Missing or empty keeps the scorecard what-if. */
export function parseLearnGrades(raw: string | null): string[] | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const out: string[] = [];
  const parts = raw.split(",");
  for (let i = 0; i < parts.length; i++) {
    const grade = parts[i].trim().toUpperCase();
    if (LEARN_GRADES.indexOf(grade) === -1 || out.indexOf(grade) !== -1) continue;
    out.push(grade);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Contracts the exit what-if can use. Experiment and test rows are left out.
 * Research tracks are included only when a grade filter asks for them.
 */
export function learnCandleKeys(
  shadows: readonly ShadowTrade[],
  research: readonly ResearchTrack[] | undefined,
  grades?: readonly string[],
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  for (let i = 0; i < shadows.length; i++) {
    const row = shadows[i];
    if (excludedFromMainTotals(row) || row.grade === "test") continue;
    if (!(row.entryPrice > 0)) continue;
    if (grades && grades.indexOf(row.grade) === -1) continue;
    add(contractKey(row));
  }
  if (grades && research) {
    for (let i = 0; i < research.length; i++) {
      const row = research[i];
      if (grades.indexOf(row.grade) === -1) continue;
      if (!(row.entryPrice > 0)) continue;
      add(row.contractKey);
    }
  }
  return keys;
}

export async function loadLearnPage(now: Date, grades?: readonly string[]): Promise<LearnPage> {
  const [shadowText, alertText, tradeText] = await Promise.all([
    readShadowBookText(),
    readAlertBookText(),
    readTradeLogText(),
  ]);
  const book = parseShadowBook(shadowText);
  const keys = learnCandleKeys(book.records, book.research, grades);
  const candles = await loadCandleSummaries(keys, { budgetMs: LEARN_CANDLE_BUDGET_MS }).catch(() => undefined);
  const report = analyzeLearning({
    shadows: book.records,
    alerts: parseAlertBook(alertText).records,
    trades: parseTradeLog(tradeText).trades,
    checksByTradeId: readGradeChecks(tradeText),
    now,
    grades,
    research: book.research,
    candles,
  });
  return { ...report, stored: resolveStoreKind() !== "unconfigured" };
}

export async function learnCsv(now: Date, grades?: readonly string[]): Promise<string> {
  const page = await loadLearnPage(now, grades);
  return learningCsv(page);
}
