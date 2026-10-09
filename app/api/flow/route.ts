import { NextRequest, NextResponse } from "next/server";
import { verdictBanner } from "@/app/lib/alertConfig";
import { loadAlertBook, loadRiskStatus } from "@/app/lib/alertStore";
import { denyIfUnauthorized } from "@/app/lib/auth";
import {
  FLOW_DISCLAIMER,
  FLOW_LIQUIDITY_RULES,
  filterFlowRows,
  isFlowTicker,
  watchlistChunk,
  watchlistFromEnv,
  watchlistOverrideNote,
} from "@/app/lib/flow";
import { pinTodayAlerts } from "@/app/lib/flowAlerts";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { chicagoDate, isChicagoMarketHours, isMarketDay, isNyseHoliday } from "@/app/lib/marketHours";
import { noteBrowserScan, recordFlowPageSession } from "@/app/lib/pageScan";
import { formatScanRunLine } from "@/app/lib/scanHealth";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { gradeFlowRow } from "@/app/lib/verdict";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const offset = boundedInt(params.get("offset"), 0, 0, 10_000);

  const fullWatchlist = watchlistFromEnv(process.env.FLOW_WATCHLIST);
  let tickers: string[];
  let scanComplete = true;
  let nextOffset = fullWatchlist.length;
  if (ticker) {
    if (!isFlowTicker(ticker)) return NextResponse.json({ error: "Enter a ticker" }, { status: 400 });
    tickers = [ticker];
  } else {
    const chunk = watchlistChunk(fullWatchlist, offset);
    tickers = chunk.tickers;
    scanComplete = chunk.complete;
    nextOffset = chunk.nextOffset;
  }

  try {
    const now = new Date();
    const scan = await scanEstimatedFlow({ tickers, bypassCache: fresh });
    const risk = await loadRiskStatus(now);
    const losses = risk.stop.consecutiveLosses;
    const graded = filterFlowRows(scan.rows, { minPremium, otmOnly, liquidOnly, limit })
      .map((row) => ({ ...row, verdict: gradeFlowRow(row, losses), alertId: null as string | null }));
    const inSession = isMarketDay(now) && isChicagoMarketHours(now);
    let recorded = { saved: 0, opened: 0, marked: 0, closed: 0 };
    if (inSession) {
      try {
        recorded = await recordFlowPageSession(scan.rows, scan.chainInterest, losses, now);
        const touched = recorded.opened > 0 || recorded.marked > 0 || recorded.closed > 0;
        await noteBrowserScan(now, touched ? now.getTime() : null);
        console.info(formatScanRunLine({
          outcome: "success",
          tickers: scan.watchlist.length,
          alertsSaved: recorded.saved,
          shadowsOpened: recorded.opened,
          shadowsMarked: recorded.marked,
          shadowsClosed: recorded.closed,
          reason: scan.cached ? "Flow page, cached chain" : "Flow page",
        }));
      } catch {
        console.info(formatScanRunLine({
          outcome: "failed",
          tickers: scan.watchlist.length,
          alertsSaved: 0,
          shadowsOpened: 0,
          shadowsMarked: 0,
          shadowsClosed: 0,
          reason: "Flow page could not save shadows",
        }));
      }
    } else {
      console.info(formatScanRunLine({
        outcome: "success",
        tickers: scan.watchlist.length,
        alertsSaved: 0,
        shadowsOpened: 0,
        shadowsMarked: 0,
        shadowsClosed: 0,
        reason: isNyseHoliday(now) ? "Flow page, market holiday" : "Flow page, outside Central market hours",
      }));
    }
    let data = graded;
    try {
      const book = await loadAlertBook();
      data = pinTodayAlerts(graded, book.records, chicagoDate(now), now, ticker);
    } catch {
      data = graded;
    }
    return NextResponse.json({
      data,
      disclaimer: FLOW_DISCLAIMER,
      verdictBanner: verdictBanner(),
      consecutiveLosses: losses,
      dailyStop: risk.stop.dailyStop,
      weeklyNote: risk.weeklyNote,
      connected: true,
      cached: scan.cached,
      scannedAt: scan.scannedAt,
      watchlist: fullWatchlist,
      watchlistNote: watchlistOverrideNote(process.env.FLOW_WATCHLIST),
      scanComplete,
      nextOffset,
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
