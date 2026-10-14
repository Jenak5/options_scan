/**
 * Routes that authenticate themselves with Authorization: Bearer (CRON_SECRET or HEALTH_TOKEN).
 * The middleware lets these through without a session; each route checks its own bearer.
 */
export const BEARER_PATHS: ReadonlySet<string> = new Set([
  "/api/cron",
  "/api/cron/candles",
  "/api/candles/backfill",
  "/api/candles/summaries",
  "/api/features/backfill",
  "/api/health",
  "/api/brief",
]);

export function isBearerPath(pathname: string): boolean {
  return BEARER_PATHS.has(pathname);
}
