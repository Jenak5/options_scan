/**
 * Read-only replay of the scanner's Tastytrade price-history path.
 *
 * Calls ttPriceHistory, the same function AVWAP daily history uses
 * (app/lib/avwapPaperRun.ts loadDaily): six months of daily bars.
 * Tickers run one at a time. This does not call Schwab, Blob, KV, or Telegram.
 *
 *   npm run replay:core-history
 *
 * Requires TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, and
 * TASTYTRADE_REFRESH_TOKEN. Those values are never printed.
 */
import { ttPriceHistory } from "../app/lib/tastytradeMarket";

const CORE_TICKERS = [
  "SPY", "QQQ", "IWM", "AAPL", "NVDA", "TSLA", "MSFT", "AMD", "AMZN", "GOOGL", "META",
] as const;

const BLOCKED_ENV = [
  "BLOB_READ_WRITE_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "KV_REST_API_READ_ONLY_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "EDGE_CONFIG",
  "GLOBAL_CONFIG",
] as const;

function redact(text: string): string {
  const secrets = [
    process.env.TASTYTRADE_CLIENT_ID,
    process.env.TASTYTRADE_CLIENT_SECRET,
    process.env.TASTYTRADE_REFRESH_TOKEN,
  ].filter((value): value is string => typeof value === "string" && value.length >= 6);
  let out = text;
  for (let i = 0; i < secrets.length; i++) out = out.split(secrets[i]).join("[redacted]");
  return out
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

async function main(): Promise<void> {
  for (let i = 0; i < BLOCKED_ENV.length; i++) delete process.env[BLOCKED_ENV[i]];
  const required = ["TASTYTRADE_CLIENT_ID", "TASTYTRADE_CLIENT_SECRET", "TASTYTRADE_REFRESH_TOKEN"] as const;
  const missing = required.filter((key) => !(process.env[key] ?? "").trim());
  if (missing.length > 0) {
    console.error(`Missing ${missing.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  let passed = 0;
  let failed = 0;
  for (let i = 0; i < CORE_TICKERS.length; i++) {
    const symbol = CORE_TICKERS[i];
    try {
      const bars = await ttPriceHistory({
        symbol,
        periodType: "month",
        period: 6,
        frequencyType: "daily",
        frequency: 1,
        needExtendedHoursData: false,
        endDate: now,
      });
      passed += 1;
      console.log(`${symbol} pass ${bars.length} bars`);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : "price history failed";
      console.log(`${symbol} fail ${redact(message)}`);
    }
  }
  console.log(`${CORE_TICKERS.length} tickers, ${passed} pass, ${failed} fail`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "replay failed";
  console.error(redact(message));
  process.exitCode = 1;
});
