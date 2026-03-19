import { NextRequest, NextResponse } from "next/server";
import {
  getPositions,
  getBalances,
  getOptionChain,
  getExpirations,
  getVolatilityMetrics,
  getMarketMetrics,
  getNetLiqHistory,
  getLiveOrders,
} from "@/app/lib/tastytrade";

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");
  const symbol = request.nextUrl.searchParams.get("symbol");

  try {
    switch (action) {
      // ── Account ──────────────────────────────────────────────────────────
      case "positions":
        return NextResponse.json({ data: await getPositions() });

      case "balances":
        return NextResponse.json({ data: await getBalances() });

      case "orders":
        return NextResponse.json({ data: await getLiveOrders() });

      case "netliq": {
        const timeBack = request.nextUrl.searchParams.get("timeBack") || "1m";
        return NextResponse.json({ data: await getNetLiqHistory(undefined, timeBack) });
      }

      // ── Vol Arb ───────────────────────────────────────────────────────────
      // Returns a single flat metrics object for one symbol.
      // Fields: implied-volatility-30-day, historical-volatility-30-day, iv-rank, etc.
      case "volatility": {
        if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
        return NextResponse.json({ data: await getVolatilityMetrics(symbol) });
      }

      // Batch metrics for multiple symbols (comma-separated)
      case "metrics": {
        const symbols = request.nextUrl.searchParams.get("symbols");
        if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
        return NextResponse.json({ data: await getMarketMetrics(symbols.split(",")) });
      }

      // ── Option Chain ──────────────────────────────────────────────────────
      // Step 1: get available expiration dates for the dropdown
      case "expirations": {
        if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
        return NextResponse.json({ data: await getExpirations(symbol) });
      }

      // Step 2: get strikes for a specific expiration
      case "chain": {
        if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
        const expiration = request.nextUrl.searchParams.get("expiration") ?? undefined;
        return NextResponse.json({ data: await getOptionChain(symbol, expiration) });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("Tastytrade API error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
