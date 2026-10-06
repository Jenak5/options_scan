import { parseAlertBook } from "@/app/lib/alertBook";
import { analyzeLearning, learningCsv, readGradeChecks, type LearnReport } from "@/app/lib/learn";
import { readAlertBookText, readShadowBookText, readTradeLogText, resolveStoreKind } from "@/app/lib/schwabStore";
import { parseShadowBook } from "@/app/lib/shadow";
import { parseTradeLog } from "@/app/lib/trades";

/**
 * Learning mode reads the alert book, the shadow book, and the trade log.
 * It does not quote Schwab and it does not write a rule.
 */

export interface LearnPage extends LearnReport {
  stored: boolean;
}

export async function loadLearnPage(now: Date): Promise<LearnPage> {
  const [shadowText, alertText, tradeText] = await Promise.all([
    readShadowBookText(),
    readAlertBookText(),
    readTradeLogText(),
  ]);
  const report = analyzeLearning({
    shadows: parseShadowBook(shadowText).records,
    alerts: parseAlertBook(alertText).records,
    trades: parseTradeLog(tradeText).trades,
    checksByTradeId: readGradeChecks(tradeText),
    now,
  });
  return { ...report, stored: resolveStoreKind() !== "unconfigured" };
}

export async function learnCsv(now: Date): Promise<string> {
  const page = await loadLearnPage(now);
  return learningCsv(page);
}
