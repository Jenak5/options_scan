/**
 * Read-only timing of the scanner's market-data path for one cron universe.
 *
 * Uses planCronScan (core names first, then one rotating slice) and the same
 * history prefetch and option-chain reads the scheduled scan uses. No Blob,
 * KV, or Telegram writes. Secrets are never printed.
 *
 *   npm run replay:scan-timing
 *
 * Requires TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, and
 * TASTYTRADE_REFRESH_TOKEN.
 */
import { DEFAULT_FLOW_WATCHLIST, flowChainRequest, planCronScan } from "../app/lib/flow";
import { keyLevelsForTicker, prefetchLevelHistory } from "../app/lib/levelScan";
import { getOptionChain } from "../app/lib/marketData";

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

  const now = new Date();
  const plan = planCronScan([...DEFAULT_FLOW_WATCHLIST], now);
  console.log(`universe ${plan.tickers.length} tickers (${plan.core.length} core first)`);
  const started = Date.now();
  try {
    await prefetchLevelHistory(plan.tickers, started);
  } catch (err) {
    console.log(`history prefetch fail ${redact(err instanceof Error ? err.message : "price history failed")}`);
  }
  let passed = 0;
  let failed = 0;
  for (let i = 0; i < plan.tickers.length; i++) {
    const ticker = plan.tickers[i];
    try {
      const chain = await getOptionChain(flowChainRequest(ticker, now));
      const levels = await keyLevelsForTicker({
        ticker,
        spot: chain.underlyingPrice,
        contracts: chain.contracts,
        now: started,
      });
      passed += 1;
      const anchored = levels.vwap != null ? "vwap" : "no-vwap";
      console.log(`${ticker} pass chain ${chain.contracts.length} ${anchored}`);
    } catch (err) {
      failed += 1;
      console.log(`${ticker} fail ${redact(err instanceof Error ? err.message : "scan data failed")}`);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`total ${seconds}s, ${plan.tickers.length} tickers, ${passed} pass, ${failed} fail`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "replay failed";
  console.error(redact(message));
  process.exitCode = 1;
});
