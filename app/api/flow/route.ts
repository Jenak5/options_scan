import { NextRequest, NextResponse } from "next/server";
import { verdictBanner } from "@/app/lib/alertConfig";
import { currentDailyLoss } from "@/app/lib/alertStore";
import { denyIfUnauthorized } from "@/app/lib/auth";
import {
  FLOW_DISCLAIMER,
  FLOW_LIQUIDITY_RULES,
  filterFlowRows,
  isFlowTicker,
  watchlistFromEnv,
} from "@/app/lib/flow";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { DAILY_STOP_CONSECUTIVE_LOSSES } from "@/app/lib/risk";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { gradeFlowRow } from "@/app/lib/verdict";

export const dynamic = "force-dynamic";

/**
 * Estimated flow from Schwab chains.
 * Session required. Read-only. No order endpoint.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const ticker = (params.get("ticker") || "").trim().toUpperCase();
  const minPremium = nonNegative(params.get("minPremium") ?? params.get("min_premium"), 0);
  const otmOnly = params.get("otmOnly") === "true" || params.get("is_otm") === "true";
  const liquidOnly = params.get("liquidOnly") !== "false";
  const limit = boundedInt(params.get("limit"), 80, 1, 200);
  const fresh = params.get("fresh") === "true";

  let tickers: string[];
  if (ticker) {
    if (!isFlowTicker(ticker)) return NextResponse.json({ error: "Enter a ticker" }, { status: 400 });
    tickers = [ticker];
  } else {
    tickers = watchlistFromEnv(process.env.FLOW_WATCHLIST);
  }

  try {
    const scan = await scanEstimatedFlow({ tickers, bypassCache: fresh });
    const losses = await currentDailyLoss(new Date());
    const data = filterFlowRows(scan.rows, { minPremium, otmOnly, liquidOnly, limit })
      .map((row) => ({ ...row, verdict: gradeFlowRow(row, losses) }));
    return NextResponse.json({
      data,
      disclaimer: FLOW_DISCLAIMER,
      verdictBanner: verdictBanner(),
      consecutiveLosses: losses,
      dailyStop: losses != null && losses >= DAILY_STOP_CONSECUTIVE_LOSSES,
      connected: true,
      cached: scan.cached,
      scannedAt: scan.scannedAt,
      watchlist: scan.watchlist,
      errors: scan.errors,
      liquidity: { ...FLOW_LIQUIDITY_RULES, liquidOnly },
    });
  } catch (err) {
    if (err instanceof SchwabNotConnectedError) {
      return NextResponse.json({
        error: err.message,
        reconnect: "/api/schwab/connect",
        connected: false,
        disclaimer: FLOW_DISCLAIMER,
        verdictBanner: verdictBanner(),
      }, { status: 409 });
    }
    if (err instanceof SchwabConfigError) {
      return NextResponse.json({
        error: err.message,
        connected: false,
        disclaimer: FLOW_DISCLAIMER,
        verdictBanner: verdictBanner(),
      }, { status: 503 });
    }
    const message = err instanceof Error && err.message.startsWith("Schwab ")
      ? err.message.slice(0, 180)
      : "Schwab market data request failed";
    return NextResponse.json({ error: message, connected: false }, { status: 502 });
  }
}

function nonNegative(value: string | null, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value == null ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
