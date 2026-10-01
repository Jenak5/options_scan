import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { isFlowTicker } from "@/app/lib/flow";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { VOL_DEFINITIONS, VOL_DISCLAIMER } from "@/app/lib/volArb";
import { scanVolArb, type VolScanError } from "@/app/lib/volScan";

export const dynamic = "force-dynamic";

const MAX_SYMBOLS = 8;

/**
 * Vol arb from Schwab chains and Schwab daily prices.
 * Session required. Read-only. No order endpoint.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  const raw = request.nextUrl.searchParams.get("symbols") ?? request.nextUrl.searchParams.get("symbol") ?? "";
  const parsed = parseSymbols(raw);
  if (parsed.symbols.length === 0) {
    return NextResponse.json({
      error: "Enter a ticker",
      connected: true,
      rows: [],
      errors: parsed.rejected,
      disclaimer: VOL_DISCLAIMER,
    }, { status: 400 });
  }
  if (parsed.symbols.length > MAX_SYMBOLS) {
    return NextResponse.json({
      error: "Send at most 8 symbols at a time.",
      connected: true,
      rows: [],
      errors: [],
      disclaimer: VOL_DISCLAIMER,
    }, { status: 400 });
  }

  try {
    const fresh = request.nextUrl.searchParams.get("fresh") === "true";
    const scan = await scanVolArb({ symbols: parsed.symbols, bypassCache: fresh });
    return NextResponse.json({
      connected: true,
      source: "Schwab market data",
      disclaimer: VOL_DISCLAIMER,
      definitions: VOL_DEFINITIONS,
      rows: scan.rows,
      errors: [...parsed.rejected, ...scan.errors],
      scannedAt: scan.scannedAt,
      cached: scan.cached,
    });
  } catch (err) {
    if (err instanceof SchwabNotConnectedError) {
      return NextResponse.json({
        error: err.message,
        reconnect: "/api/schwab/connect",
        connected: false,
        rows: [],
        errors: [],
        disclaimer: VOL_DISCLAIMER,
      }, { status: 409 });
    }
    if (err instanceof SchwabConfigError) {
      return NextResponse.json({
        error: err.message,
        connected: false,
        rows: [],
        errors: [],
        disclaimer: VOL_DISCLAIMER,
      }, { status: 503 });
    }
    const message = err instanceof Error && err.message.startsWith("Schwab ")
      ? err.message.slice(0, 180)
      : "Schwab market data request failed";
    return NextResponse.json({
      error: message,
      connected: false,
      rows: [],
      errors: [],
      disclaimer: VOL_DISCLAIMER,
    }, { status: 502 });
  }
}

function parseSymbols(raw: string): { symbols: string[]; rejected: VolScanError[] } {
  const seen = new Set<string>();
  const symbols: string[] = [];
  const rejected: VolScanError[] = [];
  const parts = raw.split(/[\s,]+/);
  for (let i = 0; i < parts.length; i++) {
    const ticker = parts[i].trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    if (!isFlowTicker(ticker)) {
      rejected.push({ symbol: ticker.slice(0, 20), message: "Enter a ticker like SPY." });
      continue;
    }
    symbols.push(ticker);
  }
  return { symbols, rejected };
}
