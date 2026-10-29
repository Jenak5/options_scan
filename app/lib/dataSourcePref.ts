import { tastytradeCandleConfigured } from "@/app/lib/tastytradeCandles";

/**
 * Which broker the scanner asks first.
 * MARKET_DATA_PRIMARY=tastytrade|schwab. Unset defaults to tastytrade.
 * DATA_SOURCE is the older name and applies only when MARKET_DATA_PRIMARY is unset.
 * Kept separate so the Schwab client can stay quiet without importing the router.
 */

export type DataSource = "tastytrade" | "schwab";

function namedSource(value: string | undefined): DataSource | null {
  const flag = (value ?? "").trim().toLowerCase();
  if (flag === "schwab" || flag === "tastytrade") return flag;
  return null;
}

/** The flag the operator set. Default tastytrade, before the credential check. */
export function requestedPrimary(env: Record<string, string | undefined> = process.env): DataSource {
  return namedSource(env.MARKET_DATA_PRIMARY) ?? namedSource(env.DATA_SOURCE) ?? "tastytrade";
}

export function preferredDataSource(env: Record<string, string | undefined> = process.env): DataSource {
  if (requestedPrimary(env) === "schwab") return "schwab";
  if (!tastytradeCandleConfigured(env)) return "schwab";
  return "tastytrade";
}
