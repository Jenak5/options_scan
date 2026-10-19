import { tastytradeCandleConfigured } from "@/app/lib/tastytradeCandles";

/**
 * Which broker the scanner asks first.
 * Kept separate so the Schwab client can stay quiet without importing the router.
 */

export type DataSource = "tastytrade" | "schwab";

export function preferredDataSource(env: Record<string, string | undefined> = process.env): DataSource {
  const flag = (env.DATA_SOURCE ?? "").trim().toLowerCase();
  if (flag === "schwab") return "schwab";
  if (!tastytradeCandleConfigured(env)) return "schwab";
  return "tastytrade";
}
