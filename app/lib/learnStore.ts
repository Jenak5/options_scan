import { parseAlertBook } from "@/app/lib/alertBook";
import { loadCandleSeries } from "@/app/lib/candleStore";
import { analyzeLearning, learningCsv, readGradeChecks, type LearnReport } from "@/app/lib/learn";
import { readAlertBookText, readShadowBookText, readTradeLogText, resolveStoreKind } from "@/app/lib/schwabStore";
import { contractKey, parseShadowBook } from "@/app/lib/shadow";
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

export async function loadLearnPage(now: Date, grades?: readonly string[]): Promise<LearnPage> {
  const [shadowText, alertText, tradeText] = await Promise.all([
    readShadowBookText(),
    readAlertBookText(),
    readTradeLogText(),
  ]);
  const book = parseShadowBook(shadowText);
  const keys: string[] = [];
  for (let i = 0; i < book.records.length; i++) keys.push(contractKey(book.records[i]));
  const research = book.research ?? [];
  for (let i = 0; i < research.length; i++) keys.push(research[i].contractKey);
  const candles = await loadCandleSeries(keys).catch(() => undefined);
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
